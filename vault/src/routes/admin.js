const express = require('express');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const db = require('../db/sqlite');
const { STORAGE_DIR, BACKUP_DIR, DATA_DIR, getVaultName, setVaultName, VAULT_ACCESS_KEY, JWT_SECRET } = require('../config');

const AVATAR_DIR = path.join(STORAGE_DIR, 'avatars');
const BACKUP_SETTINGS_FILE = path.join(DATA_DIR, 'backup-settings.json');
const SERVER_URL_FILE = path.join(DATA_DIR, 'server-url.txt');

const router = express.Router();
const PORT = process.env.PORT || 3000;

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

function getLocalIp() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const addr of iface)
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  return 'localhost';
}

function getServerUrl() {
  try { const u = fs.readFileSync(SERVER_URL_FILE, 'utf8').trim(); if (u) return u; } catch {}
  return PUBLIC_URL || `http://${getLocalIp()}:${PORT}`;
}

// Accepts token from Authorization header OR ?token= query param (for download links)
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || null);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ─── Server-side E2E crypto helpers ───────────────────────────────────────────

function pbkdf2Async(password, saltHex, iterations = 600000) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(Buffer.from(password), Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256',
      (err, key) => err ? reject(err) : resolve(key));
  });
}

function aesgcmEncrypt(data, keyBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return iv.toString('hex') + Buffer.concat([ct, cipher.getAuthTag()]).toString('hex');
}

function aesgcmDecrypt(encHex, keyBuf) {
  const iv = Buffer.from(encHex.slice(0, 24), 'hex');
  const data = Buffer.from(encHex.slice(24), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(data.slice(-16));
  return Buffer.concat([decipher.update(data.slice(0, -16)), decipher.final()]);
}

async function serverWrapKey(keyBuf, password) {
  const kdfSalt = crypto.randomBytes(32).toString('hex');
  const aesKey = await pbkdf2Async(password, kdfSalt);
  return { kdfSalt, wrappedVaultKey: aesgcmEncrypt(keyBuf, aesKey) };
}

async function getOrInitVaultKey(adminPassword) {
  const vc = db.getVaultCrypto();
  if (!vc || !vc.initialized) {
    const vaultKey = crypto.randomBytes(32);
    const wrapped = await serverWrapKey(vaultKey, adminPassword);
    db.setVaultCrypto(wrapped.kdfSalt, wrapped.wrappedVaultKey);
    return vaultKey;
  }
  try {
    const aesKey = await pbkdf2Async(adminPassword, vc.kdfSalt);
    return aesgcmDecrypt(vc.wrappedVaultKey, aesKey);
  } catch {
    throw new Error('Incorrect admin password');
  }
}

// ─── Backup helpers ────────────────────────────────────────────────────────────

function loadBackupSettings() {
  try { return JSON.parse(fs.readFileSync(BACKUP_SETTINGS_FILE, 'utf8')); } catch {}
  return { schedule: 'off', keepLast: 5, lastBackupAt: null };
}

function saveBackupSettings(settings) {
  fs.writeFileSync(BACKUP_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getDirSize(dirPath) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) total += getDirSize(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
  } catch {}
  return total;
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch { return []; }
}

function pruneBackups(keepLast) {
  const backups = listBackups();
  const toDelete = backups.slice(keepLast);
  for (const b of toDelete) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch {}
  }
}

async function doCreateBackup() {
  const archiver = require('archiver');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `familyvault-backup-${timestamp}.zip`;
  const outPath = path.join(BACKUP_DIR, filename);
  const tempDb = path.join(BACKUP_DIR, `tmp-${timestamp}.db`);

  // Use better-sqlite3's native backup API — creates a consistent WAL snapshot
  await db.backup(tempDb);

  const output = fs.createWriteStream(outPath);
  const archive = archiver('zip', { zlib: { level: 5 } });

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    archive.file(tempDb, { name: 'vault.db' });

    if (fs.existsSync(STORAGE_DIR)) {
      archive.directory(STORAGE_DIR, 'storage', (entry) => {
        const parts = entry.name.split(/[/\\]/);
        return parts[0] === '.chunks' ? false : entry;
      });
    }

    archive.finalize();
  });

  try { fs.unlinkSync(tempDb); } catch {}

  const settings = loadBackupSettings();
  settings.lastBackupAt = new Date().toISOString();
  saveBackupSettings(settings);

  return filename;
}

// ─── Backup scheduler ─────────────────────────────────────────────────────────

function runScheduledBackup() {
  const settings = loadBackupSettings();
  if (settings.schedule === 'off') return;

  const lastBackup = settings.lastBackupAt ? new Date(settings.lastBackupAt) : null;
  const hoursSince = lastBackup ? (Date.now() - lastBackup.getTime()) / 3600000 : Infinity;
  const isDue = settings.schedule === 'daily' ? hoursSince >= 24
    : settings.schedule === 'weekly' ? hoursSince >= 168 : false;

  if (!isDue) return;

  console.log('[backup] scheduled backup starting…');
  doCreateBackup()
    .then(() => {
      pruneBackups(settings.keepLast || 5);
      console.log('[backup] scheduled backup complete');
    })
    .catch((e) => console.error('[backup] scheduled backup failed:', e.message));
}

setInterval(runScheduledBackup, 60 * 60 * 1000);

// ─── API ──────────────────────────────────────────────────────────────────────

router.get('/admin/api/status', (req, res) => {
  res.json({ setupDone: db.isSetupDone(), vaultName: getVaultName() });
});

router.post('/admin/api/vault-name', requireAdmin, (req, res) => {
  const name = (req.body.vaultName || '').trim();
  if (!name) return res.status(400).json({ error: 'Vault name cannot be empty' });
  setVaultName(name);
  res.json({ ok: true, vaultName: name });
});

// Simple rate limiter
const _adminAttempts = new Map();
setInterval(() => _adminAttempts.clear(), 15 * 60 * 1000);
function adminRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const e = _adminAttempts.get(key) || { n: 0, start: now };
  if (now - e.start > 60_000) { e.n = 1; e.start = now; } else e.n++;
  _adminAttempts.set(key, e);
  if (e.n > 8) return res.status(429).json({ error: 'Too many attempts — wait a minute.' });
  next();
}

router.post('/admin/api/setup', adminRateLimit, async (req, res) => {
  if (db.isSetupDone()) return res.status(409).json({ error: 'Already configured' });
  const { name, password, vaultName } = req.body;
  if (!name?.trim() || !password) return res.status(400).json({ error: 'Name and password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Admin password must be at least 8 characters' });
  try {
    if (vaultName?.trim()) setVaultName(vaultName.trim());
    db.createAdmin(name.trim(), password);
    // Initialize vault key server-side, wrapped with admin password
    const vaultKey = crypto.randomBytes(32);
    const wrapped = await serverWrapKey(vaultKey, password);
    db.setVaultCrypto(wrapped.kdfSalt, wrapped.wrappedVaultKey);
    const token = jwt.sign({ role: 'admin', name: name.trim() }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, name: name.trim() });
  } catch (e) { res.status(409).json({ error: e.message }); }
});

router.post('/admin/api/login', adminRateLimit, (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
  const admin = db.verifyAdmin(name, password);
  if (!admin) return res.status(401).json({ error: 'Incorrect name or password' });
  const token = jwt.sign({ role: 'admin', name: admin.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, name: admin.name });
});

router.get('/admin/api/vault-qr', requireAdmin, async (req, res) => {
  const serverUrl = getServerUrl();
  const externalUrl = `${serverUrl}?vk=${VAULT_ACCESS_KEY}`;
  const qr = await QRCode.toDataURL(externalUrl, { width: 300, margin: 2, color: { dark: '#000', light: '#fff' } });
  res.json({ qr, serverUrl, externalUrl });
});

router.get('/admin/api/stats', requireAdmin, (req, res) => {
  const stats = db.getStats();
  const storageBytes = getDirSize(STORAGE_DIR);
  res.json({ ...stats, storageBytes });
});

router.get('/admin/api/members', requireAdmin, (req, res) => {
  const members = db.getMembersAdmin().map((m) => {
    const hasAvatar = fs.existsSync(path.join(AVATAR_DIR, `${m.name.replace(/[^a-zA-Z0-9]/g, '_')}.jpg`));
    return { ...m, hasAvatar };
  });
  res.json(members);
});

router.get('/admin/api/reset-requests', requireAdmin, (req, res) => {
  res.json(db.getResetRequests());
});

router.post('/admin/api/members/:name/set-temp-password', requireAdmin, async (req, res) => {
  const { tempPassword, adminPassword } = req.body;
  if (!tempPassword || String(tempPassword).length < 4)
    return res.status(400).json({ error: 'Temp password must be at least 4 characters' });
  if (!adminPassword) return res.status(400).json({ error: 'Admin password required' });
  try {
    const vaultKey = await getOrInitVaultKey(adminPassword);
    db.setTempPassword(req.params.name, String(tempPassword));
    const member = db.getMemberByName(req.params.name);
    if (member) {
      const wrapped = await serverWrapKey(vaultKey, String(tempPassword));
      db.setUserCrypto(member.id, wrapped.kdfSalt, wrapped.wrappedVaultKey);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(e.message === 'Incorrect admin password' ? 401 : 404).json({ error: e.message });
  }
});

router.delete('/admin/api/members/:name', requireAdmin, (req, res) => {
  try {
    const { storageFiles, avatarName } = db.removeMemberWithContent(req.params.name);
    for (const fn of storageFiles) {
      try { fs.unlinkSync(path.join(STORAGE_DIR, fn)); } catch {}
    }
    try { fs.unlinkSync(path.join(AVATAR_DIR, `${avatarName.replace(/[^a-zA-Z0-9]/g, '_')}.jpg`)); } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// ─── E2E Crypto endpoints ──────────────────────────────────────────────────────

// Admin panel fetches this after login to derive vault_key client-side
router.get('/admin/api/vault-crypto', requireAdmin, (req, res) => {
  res.json(db.getVaultCrypto() || { initialized: false });
});

// Admin panel stores vault_key wrapped with admin password after first setup
router.post('/admin/api/vault-crypto', requireAdmin, (req, res) => {
  const { kdfSalt, wrappedVaultKey } = req.body;
  if (!kdfSalt || !wrappedVaultKey) return res.status(400).json({ error: 'Missing kdfSalt or wrappedVaultKey' });
  db.setVaultCrypto(kdfSalt, wrappedVaultKey);
  res.json({ ok: true });
});

// Admin panel re-wraps vault_key for a member when resetting their password
router.post('/admin/api/members/:name/set-wrapped-key', requireAdmin, (req, res) => {
  const { kdfSalt, wrappedVaultKey } = req.body;
  if (!kdfSalt || !wrappedVaultKey) return res.status(400).json({ error: 'Missing crypto params' });
  const member = db.getMemberByName(req.params.name);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  db.setUserCrypto(member.id, kdfSalt, wrappedVaultKey);
  res.json({ ok: true });
});

// ─── Invite links ──────────────────────────────────────────────────────────────

router.get('/admin/api/invites', requireAdmin, (req, res) => {
  res.json(db.listInviteLinks());
});

router.post('/admin/api/invites', requireAdmin, async (req, res) => {
  const { label, adminPassword, expiresInDays = 7 } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: 'Label required (e.g. "Grandma")' });
  if (!adminPassword) return res.status(400).json({ error: 'Admin password required' });
  try {
    const vaultKey = await getOrInitVaultKey(adminPassword);
    const rawToken = crypto.randomBytes(32);
    const rawTokenHex = rawToken.toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const inviteKdfSalt = crypto.randomBytes(32).toString('hex');
    const inviteAesKey = await pbkdf2Async(rawTokenHex, inviteKdfSalt, 1);
    const inviteWrappedVaultKey = aesgcmEncrypt(vaultKey, inviteAesKey);
    const expiresAt = new Date(Date.now() + Number(expiresInDays) * 86400000).toISOString();
    const invite = db.createCryptoInvite(label.trim(), req.admin.name, tokenHash, inviteKdfSalt, inviteWrappedVaultKey, expiresAt);
    const inviteUrl = `${getServerUrl()}/invite/${rawTokenHex}`;
    const qrDataUrl = await QRCode.toDataURL(inviteUrl, { width: 300, margin: 2 });
    res.json({ ok: true, id: invite.id, inviteUrl, qrDataUrl });
  } catch (e) {
    res.status(e.message === 'Incorrect admin password' ? 401 : 500).json({ error: e.message });
  }
});

router.delete('/admin/api/invites/:id', requireAdmin, (req, res) => {
  try {
    db.revokeInviteLinkById(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/admin/api/server-url', requireAdmin, (req, res) => {
  let saved = '';
  try { saved = fs.readFileSync(SERVER_URL_FILE, 'utf8').trim(); } catch {}
  res.json({ url: saved, detected: getServerUrl() });
});

router.post('/admin/api/server-url', requireAdmin, (req, res) => {
  let { url } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Must start with http:// or https://' });
  url = url.replace(/\/$/, '');
  fs.writeFileSync(SERVER_URL_FILE, url);
  res.json({ ok: true, url });
});

// ─── Backup API ────────────────────────────────────────────────────────────────

// GET /admin/api/backup/settings + backup list combined
router.get('/admin/api/backups', requireAdmin, (req, res) => {
  res.json({ settings: loadBackupSettings(), backups: listBackups() });
});

router.post('/admin/api/backup/settings', requireAdmin, (req, res) => {
  const { schedule, keepLast } = req.body;
  const valid = ['off', 'daily', 'weekly'];
  if (!valid.includes(schedule)) return res.status(400).json({ error: 'Invalid schedule' });
  const settings = loadBackupSettings();
  settings.schedule = schedule;
  settings.keepLast = Math.min(Math.max(Number(keepLast) || 5, 1), 30);
  saveBackupSettings(settings);
  res.json(settings);
});

// Run a backup NOW and save it to BACKUP_DIR (shows up in history)
router.post('/admin/api/backup/run', requireAdmin, async (req, res) => {
  try {
    const filename = await doCreateBackup();
    const settings = loadBackupSettings();
    pruneBackups(settings.keepLast || 5);
    res.json({ ok: true, filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/api/backups/:name', requireAdmin, (req, res) => {
  const safeName = path.basename(req.params.name);
  if (!safeName.endsWith('.zip')) return res.status(400).json({ error: 'Invalid filename' });
  try {
    fs.unlinkSync(path.join(BACKUP_DIR, safeName));
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: 'Backup not found' }); }
});

router.post('/admin/api/backup/restore/:name', requireAdmin, (req, res) => {
  const safeName = path.basename(req.params.name);
  if (!safeName.endsWith('.zip')) return res.status(400).json({ error: 'Invalid filename' });
  const zipPath = path.join(BACKUP_DIR, safeName);
  if (!fs.existsSync(zipPath)) return res.status(404).json({ error: 'Backup not found' });

  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const hasDb = entries.some(e => e.entryName === 'vault.db');
    if (!hasDb) return res.status(400).json({ error: 'Backup does not contain vault.db — this may be from an older version and cannot be restored automatically.' });

    // Respond before restarting
    res.json({ ok: true });

    setImmediate(() => {
      try {
        // Write DB from backup
        const dbEntry = zip.getEntry('vault.db');
        const destDb = path.join(DATA_DIR, 'vault.db');
        db.close();
        fs.writeFileSync(destDb, dbEntry.getData());

        // Write storage files from backup
        for (const entry of entries) {
          if (!entry.entryName.startsWith('storage/') || entry.isDirectory) continue;
          const rel = entry.entryName.slice('storage/'.length);
          if (!rel) continue;
          const dest = path.join(STORAGE_DIR, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, entry.getData());
        }

        console.log(`[restore] Restored from ${safeName} — restarting`);
        process.exit(0); // Docker restart: unless-stopped brings it back
      } catch (e) {
        console.error('[restore] Failed:', e.message);
        process.exit(1);
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin SPA ────────────────────────────────────────────────────────────────

router.get('/admin', (req, res) => res.send(adminPage()));

function adminPage() {
  const BACKUP_DIR_HINT = BACKUP_DIR;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FamilyVault Admin</title>
<style>
:root{
  --bg:#fff;--card:#f7f7f7;--border:#e8e8e8;--border-sub:#f0f0f0;
  --text:#0d0d0d;--text-muted:#888;--text-dim:#bbb;
  --input-bg:#f2f2f2;--input-border:#e0e0e0;--input-focus:#0d0d0d;
  --btn-bg:#0d0d0d;--btn-color:#fff;
  --btn-outline-color:#0d0d0d;--btn-outline-border:#ccc;
  --section-lbl:#aaa;--stat-lbl:#aaa;--td-color:#666;
  --empty-color:#ccc;--avatar-bg:#e8e8e8;
  --overlay:rgba(0,0,0,1);--modal-bg:#fff;--modal-border:#e0e0e0;
  --topbar-border:#eee;--chip-color:#999;--chip-border:#e0e0e0;
  --row-hover:#f9f9f9;
}
@media(prefers-color-scheme:dark){
  :root{
    --bg:#000;--card:#0d0d0d;--border:#1e1e1e;--border-sub:#111;
    --text:#fff;--text-muted:#555;--text-dim:#444;
    --input-bg:#111;--input-border:#222;--input-focus:#fff;
    --btn-bg:#fff;--btn-color:#000;
    --btn-outline-color:#fff;--btn-outline-border:#333;
    --section-lbl:#444;--stat-lbl:#555;--td-color:#aaa;
    --empty-color:#333;--avatar-bg:#1e1e1e;
    --overlay:rgba(0,0,0,1);--modal-bg:#0d0d0d;--modal-border:#222;
    --topbar-border:#111;--chip-color:#444;--chip-border:#1e1e1e;
    --row-hover:#0a0a0a;
  }
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
.hidden{display:none!important}
/* ── Auth views ── */
.auth-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px;gap:32px}
.brand{font-size:28px;font-weight:700;letter-spacing:-0.5px}
.auth-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px;width:100%;max-width:400px;display:flex;flex-direction:column;gap:20px}
.auth-title{font-size:18px;font-weight:600}
.auth-sub{color:var(--text-muted);font-size:13px;margin-top:-12px;line-height:1.5}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted)}
.field input{background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;color:var(--text);font-size:15px;padding:13px 14px;outline:none;transition:border-color .15s}
.field input:focus{border-color:var(--input-focus)}
.btn{background:var(--btn-bg);color:var(--btn-color);border:none;border-radius:10px;font-size:15px;font-weight:700;padding:14px;cursor:pointer;transition:opacity .15s}
.btn:hover{opacity:.82}
.btn:disabled{opacity:.3;cursor:default}
.btn-outline{background:transparent;color:var(--btn-outline-color);border:1px solid var(--btn-outline-border)}
.btn-danger{background:#e53935;color:#fff}
.btn-sm{font-size:13px;padding:8px 14px;border-radius:8px}
.btn-xs{font-size:11px;padding:5px 10px;border-radius:6px}
.err{color:#e53935;font-size:13px;text-align:center}
/* ── Dashboard layout ── */
.dash{display:flex;flex-direction:column;min-height:100vh}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:1px solid var(--topbar-border);gap:16px}
.topbar-left{display:flex;align-items:center;gap:10px}
.topbar-brand{font-size:17px;font-weight:700}
.topbar-vault{font-size:13px;color:var(--chip-color);font-weight:400;padding:3px 10px;border:1px solid var(--chip-border);border-radius:20px}
.topbar-right{display:flex;align-items:center;gap:14px;color:var(--text-muted);font-size:13px}
.content{max-width:920px;margin:0 auto;padding:32px 24px;display:flex;flex-direction:column;gap:36px;width:100%}
/* ── Section ── */
.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px;flex-wrap:wrap}
.section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--section-lbl)}
/* ── Stats ── */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 16px}
.stat-val{font-size:26px;font-weight:700;line-height:1;margin-bottom:6px}
.stat-lbl{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--stat-lbl)}
/* ── Vault info ── */
.vault-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px;display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap}
.vault-qr{background:#fff;border-radius:10px;padding:12px;flex-shrink:0}
.vault-qr img{display:block;width:140px;height:140px}
.vault-info{display:flex;flex-direction:column;gap:10px;flex:1}
.vault-url-label{font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:1px}
.vault-url{font-size:18px;font-weight:700;font-family:monospace;word-break:break-all}
.vault-hint{font-size:12px;color:var(--text-dim);line-height:1.6}
/* ── Backup ── */
.backup-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:16px}
.backup-sched{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sched-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted)}
.sched-select{background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);font-size:13px;padding:7px 10px;outline:none;cursor:pointer}
.sched-select:focus{border-color:var(--input-focus)}
.backup-status{font-size:12px;color:var(--text-muted)}
.backup-table{width:100%;border-collapse:collapse}
.backup-table th{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--section-lbl);text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)}
.backup-table td{font-size:12px;padding:9px 10px;border-bottom:1px solid var(--border-sub);color:var(--td-color);vertical-align:middle}
.backup-table tr:last-child td{border-bottom:none}
.backup-table tr:hover td{background:var(--row-hover)}
/* ── Members ── */
.members-grid{display:flex;flex-direction:column;gap:10px}
.member-chip{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 16px}
.member-avatar{width:38px;height:38px;border-radius:19px;background:var(--avatar-bg);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;flex-shrink:0}
.member-info{flex:1}
.member-name{font-size:14px;font-weight:500}
.member-date{font-size:11px;color:var(--text-dim);margin-top:2px}
.empty-hint{color:var(--empty-color);font-size:13px;padding:16px 0}
/* ── Invite cards ── */
.invites-list{display:flex;flex-direction:column;gap:10px}
.invite-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
.invite-card.used{opacity:.5}
.invite-card.revoked{opacity:.4}
.invite-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.invite-label{font-size:15px;font-weight:600}
.badge{font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;border:1px solid}
.badge-active{color:#43a047;border-color:#43a047;background:rgba(67,160,71,.1)}
.badge-used{color:var(--text-muted);border-color:var(--border);background:transparent}
.badge-revoked{color:#e53935;border-color:#e53935;background:rgba(229,57,53,.08)}
.invite-code{font-family:monospace;font-size:16px;letter-spacing:2px;color:var(--text);margin-bottom:10px;word-break:break-all}
.invite-meta{font-size:11px;color:var(--text-dim);margin-bottom:12px}
.invite-actions{display:flex;gap:8px;flex-wrap:wrap}
/* ── Modal ── */
.modal-backdrop{position:fixed;inset:0;background:var(--overlay);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100}
.modal{background:var(--modal-bg);border:1px solid var(--modal-border);border-radius:16px;padding:28px;width:100%;max-width:440px;display:flex;flex-direction:column;gap:20px}
.modal-title{font-size:17px;font-weight:600}
.modal-qr-wrap{background:#fff;border-radius:10px;padding:14px;align-self:center}
.modal-qr-wrap img{display:block;width:240px;height:240px}
.modal-code{text-align:center;font-family:monospace;font-size:18px;letter-spacing:3px;color:#fff;background:#111;padding:14px;border-radius:8px;word-break:break-all}
.modal-hint{color:#555;font-size:12px;text-align:center;line-height:1.6}
.modal-foot{display:flex;gap:10px}
.modal-foot .btn{flex:1}
/* ── Spinner ── */
.spinner-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}
.spinner{width:28px;height:28px;border:3px solid var(--border);border-top-color:var(--text);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<div id="v-loading" class="spinner-wrap"><div class="spinner"></div></div>

<!-- Setup -->
<div id="v-setup" class="auth-wrap hidden">
  <div class="brand">FamilyVault</div>
  <div class="auth-card">
    <div>
      <div class="auth-title">Create admin account</div>
      <div class="auth-sub" style="margin-top:6px">First time setup. Create an account to manage your vault.</div>
    </div>
    <div class="field"><label>Vault name</label><input id="setup-vault-name" placeholder="e.g. The Smiths" autocomplete="off" value="Family Vault"></div>
    <div class="field"><label>Admin name</label><input id="setup-name" placeholder="Your name" autocomplete="off"></div>
    <div class="field"><label>Password</label><input id="setup-pass" type="password" placeholder="Choose a strong password (8+ chars)"></div>
    <div id="setup-err" class="err hidden"></div>
    <button class="btn" id="setup-btn" onclick="doSetup()">Create Account</button>
  </div>
</div>

<!-- Login -->
<div id="v-login" class="auth-wrap hidden">
  <div class="brand">FamilyVault</div>
  <div class="auth-card">
    <div class="auth-title">Admin sign in</div>
    <div class="field"><label>Name</label><input id="login-name" placeholder="Admin name" autocomplete="off"></div>
    <div class="field"><label>Password</label><input id="login-pass" type="password" placeholder="Password"></div>
    <div id="login-err" class="err hidden"></div>
    <button class="btn" id="login-btn" onclick="doLogin()">Sign In</button>
  </div>
</div>

<!-- Dashboard -->
<div id="v-dash" class="dash hidden">
  <div class="topbar">
    <div class="topbar-left">
      <div class="topbar-brand">FamilyVault</div>
      <div class="topbar-vault" id="vault-name-chip"></div>
    </div>
    <div class="topbar-right">
      <span id="admin-name"></span>
      <button class="btn btn-outline btn-sm" onclick="doLogout()">Sign out</button>
    </div>
  </div>

  <div class="content">

    <!-- Stats -->
    <div>
      <div class="section-head"><span class="section-title">Overview</span></div>
      <div class="stats-grid" id="stats-grid">
        <div class="stat-card"><div class="stat-val" id="stat-members">—</div><div class="stat-lbl">Members</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-posts">—</div><div class="stat-lbl">Posts</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-stories">—</div><div class="stat-lbl">Active Dailys</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-messages">—</div><div class="stat-lbl">Messages</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-storage">—</div><div class="stat-lbl">Storage Used</div></div>
      </div>
    </div>

    <!-- Vault settings -->
    <div>
      <div class="section-head"><span class="section-title">Vault Settings</span></div>
      <div class="vault-card" style="gap:16px">
        <div class="vault-info" style="gap:8px">
          <div class="vault-url-label">Vault Name</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="vault-name-input" style="flex:1;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;color:var(--text);font-size:15px;padding:9px 12px;outline:none;min-width:0" placeholder="Family Vault">
            <button class="btn btn-sm" id="vault-name-btn" onclick="saveVaultName(this)">Save</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim)">Shown in the app and on the connection screen.</div>
        </div>
      </div>
    </div>

    <!-- Vault connection -->
    <div>
      <div class="section-head"><span class="section-title">Vault Connection</span></div>
      <div class="vault-card">
        <div class="vault-qr"><img id="vault-qr-img" src="" alt="QR"></div>
        <div class="vault-info">
          <div class="vault-url-label">Server URL</div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
            <input id="server-url-input" style="flex:1;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 12px;font-family:monospace;outline:none;min-width:0" placeholder="http://192.168.1.165:3000">
            <button class="btn btn-sm" id="server-url-btn" onclick="saveServerUrl(this)">Save</button>
          </div>
          <div style="font-size:11px;color:#444;margin-top:6px">Used in all QR codes and invite links. Set to your Pi's LAN IP, or your Cloudflare domain for remote access.</div>
          <div class="vault-hint" style="margin-top:14px">Returning members scan this QR code with the FamilyVault app to sign in. New members need a personal invite code below.</div>
        </div>
      </div>
    </div>

    <!-- Backups -->
    <div>
      <div class="section-head">
        <span class="section-title">Backups</span>
        <button class="btn btn-sm" onclick="runBackupNow(this)">Save to Server</button>
      </div>
      <div class="backup-card">
        <div class="backup-sched">
          <span class="sched-label">Auto-backup</span>
          <select id="backup-schedule" class="sched-select" onchange="saveBackupSchedule()">
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          <span class="sched-label" style="margin-left:8px">Keep last</span>
          <select id="backup-keep" class="sched-select" onchange="saveBackupSchedule()">
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="30">30</option>
          </select>
          <span id="backup-last" class="backup-status"></span>
        </div>
        <div id="backup-list"><div class="empty-hint">No saved backups yet.</div></div>
      </div>
    </div>

    <!-- Invite codes -->
    <div>
      <div class="section-head">
        <span class="section-title">Invite Codes</span>
        <button class="btn btn-sm" onclick="showCreateInvite()">+ Create Invite</button>
      </div>
      <div id="invites-list" class="invites-list">
        <div class="empty-hint">No invite codes yet. Create one to add a family member.</div>
      </div>
    </div>

    <!-- Members -->
    <div>
      <div class="section-head"><span class="section-title">Members</span></div>
      <div id="members-grid" class="members-grid">
        <div class="empty-hint">No members yet.</div>
      </div>
    </div>

  </div>
</div>

<!-- Create invite modal -->
<div id="m-create" class="modal-backdrop hidden">
  <div class="modal">
    <div class="modal-title">New Invite Code</div>
    <div class="field">
      <label>For who?</label>
      <input id="invite-label" placeholder="e.g. Grandma Jones" autocomplete="off">
    </div>
    <div class="field">
      <label>Your admin password</label>
      <input id="invite-admin-pass" type="password" placeholder="Confirm your password" autocomplete="current-password">
    </div>
    <div id="create-err" class="err hidden"></div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="hideCreateInvite()">Cancel</button>
      <button class="btn" id="create-btn" onclick="doCreateInvite()">Create</button>
    </div>
  </div>
</div>

<!-- Set temp password modal -->
<div id="m-temppass" class="modal-backdrop hidden" onclick="hideTempPass(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-title">Set Temporary Password</div>
    <div id="temppass-hint" class="modal-hint" style="text-align:left;color:#555"></div>
    <div class="field">
      <label>Temporary Password</label>
      <input id="temppass-input" type="text" placeholder="e.g. Family2024Reset" autocomplete="off">
    </div>
    <div class="field">
      <label>Your admin password</label>
      <input id="temppass-admin-pass" type="password" placeholder="Confirm your password" autocomplete="current-password">
    </div>
    <div id="temppass-err" class="err hidden"></div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="hideTempPass()">Cancel</button>
      <button class="btn" id="temppass-btn" onclick="doSetTempPass()">Set &amp; Tell Them</button>
    </div>
  </div>
</div>

<!-- QR modal -->
<div id="m-qr" class="modal-backdrop hidden" onclick="hideQr(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-title" id="qr-title">Invite Code</div>
    <div class="modal-qr-wrap"><img id="qr-img" src="" alt="QR" width="240" height="240"></div>
    <div class="modal-code" id="qr-code-text"></div>
    <div class="modal-hint" id="qr-hint">Family member scans this in the FamilyVault app to join. One-time use.</div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="copyQrCode()">Copy Code</button>
      <button class="btn" onclick="hideQr()">Done</button>
    </div>
  </div>
</div>

<script>
const api = window.location.origin;
let TOKEN = sessionStorage.getItem('fv_admin_token');


function setErr(id, msg) {
  const el = document.getElementById(id);
  if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function showView(id) {
  ['v-loading','v-setup','v-login','v-dash'].forEach(v => document.getElementById(v).classList.add('hidden'));
  show(id);
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(api + path, {
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}), ...(opts.headers || {}) },
    ...opts,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

async function init() {
  try {
    const status = await apiFetch('/admin/api/status');
    if (!status.setupDone) { showView('v-setup'); return; }
    if (TOKEN) {
      try { await loadDashboard(status); return; }
      catch { TOKEN = null; sessionStorage.removeItem('fv_admin_token'); }
    }
    showView('v-login');
  } catch { showView('v-login'); }
}

async function doSetup() {
  const btn = document.getElementById('setup-btn');
  btn.disabled = true; setErr('setup-err', '');
  try {
    const { token } = await apiFetch('/admin/api/setup', {
      method: 'POST',
      body: JSON.stringify({
        vaultName: document.getElementById('setup-vault-name').value.trim(),
        name: document.getElementById('setup-name').value.trim(),
        password: document.getElementById('setup-pass').value,
      }),
    });
    TOKEN = token; sessionStorage.setItem('fv_admin_token', token);
    await loadDashboard();
  } catch (e) { setErr('setup-err', e.message); btn.disabled = false; }
}

async function doLogin() {
  const btn = document.getElementById('login-btn');
  btn.disabled = true; setErr('login-err', '');
  try {
    const { token } = await apiFetch('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({ name: document.getElementById('login-name').value.trim(), password: document.getElementById('login-pass').value }),
    });
    TOKEN = token; sessionStorage.setItem('fv_admin_token', token);
    await loadDashboard();
  } catch (e) { setErr('login-err', e.message); btn.disabled = false; }
}

function doLogout() {
  TOKEN = null;
  sessionStorage.removeItem('fv_admin_token');
  showView('v-login');
}

async function loadDashboard(status) {
  showView('v-dash');
  if (!status) {
    try { status = await apiFetch('/admin/api/status'); } catch {}
  }
  const vn = status?.vaultName || '';
  document.getElementById('vault-name-chip').textContent = vn;
  document.getElementById('vault-name-chip').style.display = vn ? '' : 'none';
  if (document.getElementById('vault-name-input') && !document.getElementById('vault-name-input').value)
    document.getElementById('vault-name-input').value = vn;

  const [vaultData, members, invites, urlData] = await Promise.all([
    apiFetch('/admin/api/vault-qr'),
    apiFetch('/admin/api/members'),
    apiFetch('/admin/api/invites'),
    apiFetch('/admin/api/server-url'),
  ]);
  document.getElementById('vault-qr-img').src = vaultData.qr;
  document.getElementById('server-url-input').value = urlData.url || urlData.detected || '';
  renderMembers(members);
  renderInvites(invites);
  loadStats();
  loadBackups();
}

// ── Vault name ───────────────────────────────────────────────────────────────

async function saveVaultName(btn) {
  const name = document.getElementById('vault-name-input').value.trim();
  if (!name) { alert('Enter a vault name'); return; }
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await apiFetch('/admin/api/vault-name', { method: 'POST', body: JSON.stringify({ vaultName: name }) });
    const chip = document.getElementById('vault-name-chip');
    chip.textContent = name;
    chip.style.display = '';
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  } catch (e) { alert('Error: ' + e.message); btn.textContent = orig; btn.disabled = false; }
}

// ── Server URL ────────────────────────────────────────────────────────────────

async function saveServerUrl(btn) {
  const url = document.getElementById('server-url-input').value.trim();
  if (!url) { alert('Enter a URL first'); return; }
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await apiFetch('/admin/api/server-url', { method: 'POST', body: JSON.stringify({ url }) });
    const vaultData = await apiFetch('/admin/api/vault-qr');
    document.getElementById('vault-qr-img').src = vaultData.qr;
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  } catch (e) { alert('Error: ' + e.message); btn.textContent = orig; btn.disabled = false; }
}

// ── Stats ────────────────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}

async function loadStats() {
  try {
    const s = await apiFetch('/admin/api/stats');
    document.getElementById('stat-members').textContent = s.memberCount;
    document.getElementById('stat-posts').textContent = s.postCount;
    document.getElementById('stat-stories').textContent = s.activeStoryCount;
    document.getElementById('stat-messages').textContent = s.messageCount;
    document.getElementById('stat-storage').textContent = fmtBytes(s.storageBytes);
  } catch {}
}

// ── Backup ───────────────────────────────────────────────────────────────────

async function loadBackups() {
  try {
    const { settings, backups } = await apiFetch('/admin/api/backups');
    document.getElementById('backup-schedule').value = settings.schedule || 'off';
    const keepSel = document.getElementById('backup-keep');
    const keepVal = String(settings.keepLast || 5);
    const opt = Array.from(keepSel.options).find(o => o.value === keepVal);
    if (opt) keepSel.value = keepVal;
    if (settings.lastBackupAt) {
      document.getElementById('backup-last').textContent = 'Last: ' + new Date(settings.lastBackupAt).toLocaleString();
    }
    renderBackups(backups);
  } catch {}
}

function renderBackups(backups) {
  const el = document.getElementById('backup-list');
  if (!backups.length) { el.innerHTML = '<div class="empty-hint">No saved backups yet. Click "Save to Server" to create one.</div>'; return; }
  el.innerHTML = \`
    <table class="backup-table">
      <thead><tr><th>File</th><th>Size</th><th>Created</th><th></th></tr></thead>
      <tbody>
        \${backups.map(b => \`
          <tr>
            <td style="font-family:monospace;font-size:11px">\${esc(b.name)}</td>
            <td>\${fmtBytes(b.size)}</td>
            <td style="white-space:nowrap">\${new Date(b.createdAt).toLocaleString()}</td>
            <td style="text-align:right;white-space:nowrap;display:flex;gap:6px;justify-content:flex-end">
              <button class="btn btn-outline btn-xs" onclick="restoreBackup('\${esc(b.name)}','\${new Date(b.createdAt).toLocaleString()}')">Restore</button>
              <button class="btn btn-danger btn-xs" onclick="deleteBackup('\${esc(b.name)}')">✕</button>
            </td>
          </tr>
        \`).join('')}
      </tbody>
    </table>
    <div style="font-size:11px;color:var(--text-dim);margin-top:10px">Backups survive server restarts and rebuilds. To download a copy, use SSH to access the Docker volume.</div>
  \`;
}

async function runBackupNow(btn) {
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const { filename } = await apiFetch('/admin/api/backup/run', { method: 'POST' });
    btn.textContent = '✓ Saved';
    document.getElementById('backup-last').textContent = 'Last: ' + new Date().toLocaleString();
    await loadBackups();
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  } catch (e) {
    alert('Backup failed: ' + e.message);
    btn.textContent = orig; btn.disabled = false;
  }
}

async function saveBackupSchedule() {
  const schedule = document.getElementById('backup-schedule').value;
  const keepLast = Number(document.getElementById('backup-keep').value);
  try {
    await apiFetch('/admin/api/backup/settings', { method: 'POST', body: JSON.stringify({ schedule, keepLast }) });
  } catch (e) { alert('Error: ' + e.message); }
}

async function deleteBackup(name) {
  if (!confirm('Delete this backup? This cannot be undone.')) return;
  try {
    await apiFetch('/admin/api/backups/' + encodeURIComponent(name), { method: 'DELETE' });
    await loadBackups();
  } catch (e) { alert('Error: ' + e.message); }
}

async function restoreBackup(name, dateStr) {
  if (!confirm('Restore backup from ' + dateStr + '?\\n\\nThis will replace ALL current data — members, posts, messages, and media — with the contents of this backup.\\n\\nThe server will restart automatically. This cannot be undone.')) return;
  try {
    await apiFetch('/admin/api/backup/restore/' + encodeURIComponent(name), { method: 'POST' });
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;font-family:sans-serif;background:var(--bg,#fff);color:var(--text,#000)">'
      + '<div style="font-size:22px;font-weight:700">Restoring backup...</div>'
      + '<div style="font-size:14px;color:#888">The server is restarting. This page will reload automatically.</div>'
      + '</div>';
    // Poll until server responds again, then reload
    const poll = setInterval(async () => {
      try {
        await fetch('/admin/api/status');
        clearInterval(poll);
        location.reload();
      } catch {}
    }, 2000);
  } catch (e) { alert('Restore failed: ' + e.message); }
}

// ── Members ───────────────────────────────────────────────────────────────────

function renderMembers(members) {
  const el = document.getElementById('members-grid');
  if (!members.length) { el.innerHTML = '<div class="empty-hint">No members yet.</div>'; return; }
  el.innerHTML = members.map(m => \`
    <div class="member-chip">
      <div class="member-avatar">\${m.name[0].toUpperCase()}</div>
      <div class="member-info">
        <div class="member-name">\${esc(m.name)}\${m.resetRequested ? ' <span class="badge badge-revoked" style="font-size:10px;vertical-align:middle">Reset requested</span>' : ''}</div>
        <div class="member-date">Joined \${m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '—'}\${m.hasTempPassword ? ' · Temp password active' : ''}</div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="showSetTempPass('\${esc(m.name)}')" title="Set a temporary password for this member">Temp Pass</button>
      <button class="btn btn-danger btn-sm" onclick="removeMember('\${esc(m.name)}')">Remove</button>
    </div>
  \`).join('');
}

let tempPassTarget = null;
function showSetTempPass(name) {
  tempPassTarget = name;
  document.getElementById('temppass-input').value = '';
  document.getElementById('temppass-admin-pass').value = '';
  document.getElementById('temppass-hint').textContent = 'Set a temporary password for ' + name + '. They sign in with it once, then must create a new password.';
  setErr('temppass-err', '');
  document.getElementById('temppass-btn').disabled = false;
  show('m-temppass');
  setTimeout(() => document.getElementById('temppass-input').focus(), 50);
}
function hideTempPass(e) {
  if (!e || e.target === document.getElementById('m-temppass')) hide('m-temppass');
}
async function doSetTempPass() {
  const btn = document.getElementById('temppass-btn');
  const pw = document.getElementById('temppass-input').value.trim();
  const adminPassword = document.getElementById('temppass-admin-pass').value;
  if (!pw || pw.length < 4) { setErr('temppass-err', 'Must be at least 4 characters'); return; }
  if (!adminPassword) { setErr('temppass-err', 'Enter your admin password'); return; }
  btn.disabled = true; setErr('temppass-err', '');
  try {
    await apiFetch(\`/admin/api/members/\${encodeURIComponent(tempPassTarget)}/set-temp-password\`, {
      method: 'POST', body: JSON.stringify({ tempPassword: pw, adminPassword }),
    });
    hide('m-temppass');
    alert('Temp password set for ' + tempPassTarget + '.\\n\\nTell them to sign in with:\\n' + pw + '\\n\\nThey will be prompted to set a new password immediately.');
    const members = await apiFetch('/admin/api/members');
    renderMembers(members);
  } catch (e) { setErr('temppass-err', e.message); btn.disabled = false; }
}

async function removeMember(name) {
  if (!confirm(\`Remove \${name} from the vault?\\n\\nThis permanently deletes ALL their posts, stories, messages, and files. This cannot be undone.\`)) return;
  try {
    await apiFetch(\`/admin/api/members/\${encodeURIComponent(name)}\`, { method: 'DELETE' });
    const members = await apiFetch('/admin/api/members');
    renderMembers(members);
    loadStats();
  } catch (e) { alert('Error: ' + e.message); }
}

// ── Invites ───────────────────────────────────────────────────────────────────

function renderInvites(invites) {
  const el = document.getElementById('invites-list');
  if (!invites.length) { el.innerHTML = '<div class="empty-hint">No invite codes yet. Create one to add a family member.</div>'; return; }
  el.innerHTML = invites.map(inv => {
    const cls = inv.revoked ? 'revoked' : inv.used ? 'used' : '';
    const badge = inv.revoked
      ? '<span class="badge badge-revoked">Revoked</span>'
      : inv.used
        ? \`<span class="badge badge-used">Used by \${esc(inv.usedBy || '')}</span>\`
        : '<span class="badge badge-active">Active</span>';
    const created = new Date(inv.createdAt).toLocaleDateString();
    return \`
      <div class="invite-card \${cls}">
        <div class="invite-top">
          <div class="invite-label">\${esc(inv.label)}</div>
          \${badge}
        </div>
        <div class="invite-meta">Created \${created}\${inv.used ? ' · Used ' + new Date(inv.usedAt).toLocaleDateString() : ''}</div>
        <div class="invite-actions">
          \${!inv.revoked && !inv.used ? \`
            <button class="btn btn-sm" onclick="showQr('\${inv.id}','\${esc(inv.label)}')">Show QR</button>
            <button class="btn btn-danger btn-sm" onclick="revokeInvite('\${inv.id}')">Revoke</button>
          \` : \`
            \${!inv.revoked ? \`<button class="btn btn-outline btn-sm" onclick="showQr('\${inv.id}','\${esc(inv.label)}')">View QR</button>\` : ''}
          \`}
        </div>
      </div>
    \`;
  }).join('');
}

let currentQrCode = '';
async function showQr(inviteId, label) {
  const stored = sessionStorage.getItem('fv_invite_' + inviteId);
  if (stored) {
    try {
      const { url, qr } = JSON.parse(stored);
      await showInviteQr(label, url, qr);
    } catch { alert('QR data corrupted — revoke and create a new invite.'); }
  } else {
    alert('QR code is only available during the session it was created.\\n\\nRevoke this invite and create a new one to get a fresh QR code.');
  }
}

function hideQr(e) {
  if (!e || e.target === document.getElementById('m-qr')) hide('m-qr');
}
function copyQrCode() {
  navigator.clipboard.writeText(currentQrCode).then(() => alert('Copied!'));
}
async function copyCode(code) {
  try {
    const { vaultCode } = await apiFetch(\`/admin/api/invites/\${code}/qr\`);
    navigator.clipboard.writeText(vaultCode).then(() => alert('Copied!'));
  } catch (e) { alert('Error: ' + e.message); }
}

function showCreateInvite() {
  document.getElementById('invite-label').value = '';
  document.getElementById('invite-admin-pass').value = '';
  setErr('create-err', '');
  document.getElementById('create-btn').disabled = false;
  show('m-create');
  setTimeout(() => document.getElementById('invite-label').focus(), 50);
}
function hideCreateInvite() { hide('m-create'); }

document.getElementById('invite-label').addEventListener('keydown', e => { if (e.key === 'Enter') doCreateInvite(); });

async function doCreateInvite() {
  const btn = document.getElementById('create-btn');
  btn.disabled = true; setErr('create-err', '');
  const label = document.getElementById('invite-label').value.trim();
  const adminPassword = document.getElementById('invite-admin-pass').value;
  if (!label) { setErr('create-err', 'Enter a name for this invite'); btn.disabled = false; return; }
  if (!adminPassword) { setErr('create-err', 'Enter your admin password'); btn.disabled = false; return; }
  try {
    const result = await apiFetch('/admin/api/invites', {
      method: 'POST',
      body: JSON.stringify({ label, adminPassword }),
    });
    sessionStorage.setItem('fv_invite_' + result.id, JSON.stringify({ url: result.inviteUrl, qr: result.qrDataUrl }));
    hide('m-create');
    await showInviteQr(label, result.inviteUrl, result.qrDataUrl);
    const invites = await apiFetch('/admin/api/invites');
    renderInvites(invites);
  } catch (e) { setErr('create-err', e.message); btn.disabled = false; }
}

function getServerUrl() {
  const input = document.getElementById('server-url-input');
  if (input && input.value.trim()) return input.value.trim().replace(/\\/$/, '');
  // Fallback: admin panel is on :3001, API is on :3000
  return window.location.origin.replace(':3001', ':3000');
}

async function showInviteQr(label, inviteUrl, qrDataUrl) {
  document.getElementById('qr-title').textContent = label;
  document.getElementById('qr-code-text').textContent = inviteUrl;
  document.getElementById('qr-hint').textContent = 'Family member scans this in the FamilyVault app to join. One-time use — expires in 7 days.';
  currentQrCode = inviteUrl;
  document.getElementById('qr-img').src = qrDataUrl || '';
  show('m-qr');
}

async function revokeInvite(id) {
  if (!confirm('Revoke this invite code? It cannot be undone.')) return;
  try {
    await apiFetch(\`/admin/api/invites/\${id}\`, { method: 'DELETE' });
    const invites = await apiFetch('/admin/api/invites');
    renderInvites(invites);
  } catch (e) { alert('Error: ' + e.message); }
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
</script>
</body>
</html>`;
}

module.exports = router;
