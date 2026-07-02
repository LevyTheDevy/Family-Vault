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
  if (!vc) {
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
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FamilyVault Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f4f4f5;--sidebar:#ffffff;--card:#ffffff;
  --border:#e4e4e7;--border-sub:#f0f0f0;
  --text:#09090b;--text-sub:#71717a;--text-dim:#a1a1aa;
  --input-bg:#ffffff;--input-border:#e4e4e7;
  --btn:#09090b;--btn-text:#ffffff;
  --nav-active:#09090b;--nav-active-text:#ffffff;--nav-hover:#f4f4f5;
  --badge-green-bg:#f0fdf4;--badge-green:#16a34a;--badge-green-border:#bbf7d0;
  --badge-red-bg:#fef2f2;--badge-red:#dc2626;--badge-red-border:#fecaca;
}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
.hidden{display:none!important}

/* ── Auth ── */
.auth-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;background:var(--bg)}
.auth-box{width:100%;max-width:380px;display:flex;flex-direction:column;gap:28px}
.auth-logo{display:flex;align-items:center;gap:10px}
.auth-logo-mark{width:36px;height:36px;background:#09090b;border-radius:9px;display:flex;align-items:center;justify-content:center}
.auth-logo-mark svg{width:20px;height:20px;fill:#fff}
.auth-logo-name{font-size:18px;font-weight:700;letter-spacing:-0.3px}
.auth-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;display:flex;flex-direction:column;gap:18px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.auth-head{display:flex;flex-direction:column;gap:4px}
.auth-title{font-size:17px;font-weight:600;letter-spacing:-0.2px}
.auth-sub{font-size:13px;color:var(--text-sub);line-height:1.5}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--text-sub)}
.field input{background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;color:var(--text);font-size:14px;padding:10px 12px;outline:none;transition:border-color .15s;width:100%}
.field input:focus{border-color:var(--text)}
.btn{background:var(--btn);color:var(--btn-text);border:none;border-radius:8px;font-size:14px;font-weight:600;padding:11px 18px;cursor:pointer;transition:opacity .15s;white-space:nowrap}
.btn:hover{opacity:.85}
.btn:disabled{opacity:.35;cursor:default}
.btn-outline{background:transparent;color:var(--text);border:1px solid var(--border)}
.btn-outline:hover{background:var(--nav-hover)}
.btn-danger{background:#dc2626;color:#fff}
.btn-sm{font-size:13px;padding:7px 13px;border-radius:7px}
.btn-xs{font-size:11px;padding:5px 10px;border-radius:6px}
.err{color:#dc2626;font-size:13px}

/* ── Dashboard shell ── */
.dash{display:flex;min-height:100vh}
.sidebar{width:224px;flex-shrink:0;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:10}
.sb-top{padding:20px 16px 12px}
.sb-logo{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.sb-logo-mark{width:28px;height:28px;background:#09090b;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.sb-logo-mark svg{width:16px;height:16px;fill:#fff}
.sb-logo-name{font-size:15px;font-weight:700;letter-spacing:-0.2px}
.sb-vname{font-size:12px;color:var(--text-sub);padding:2px 0 0 37px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-nav{flex:1;padding:8px 10px;display:flex;flex-direction:column;gap:2px;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:7px;font-size:13px;font-weight:500;color:var(--text-sub);cursor:pointer;transition:background .1s,color .1s;user-select:none;border:none;background:transparent;width:100%;text-align:left}
.nav-item:hover{background:var(--nav-hover);color:var(--text)}
.nav-item.active{background:var(--nav-active);color:var(--nav-active-text)}
.nav-item svg{width:15px;height:15px;flex-shrink:0;opacity:.7}
.nav-item.active svg{opacity:1}
.nav-divider{height:1px;background:var(--border);margin:6px 10px}
.sb-foot{padding:12px 10px;border-top:1px solid var(--border)}
.sb-admin{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 6px}
.sb-admin-name{font-size:13px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-signout{font-size:12px;color:var(--text-sub);background:none;border:none;cursor:pointer;padding:4px 6px;border-radius:5px}
.sb-signout:hover{background:var(--nav-hover);color:var(--text)}

/* ── Main content ── */
.main{margin-left:224px;flex:1;padding:36px 40px;max-width:860px}
.page{display:flex;flex-direction:column;gap:28px}
.page-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.page-title{font-size:20px;font-weight:700;letter-spacing:-0.3px}
.page-sub{font-size:13px;color:var(--text-sub);margin-top:2px}

/* ── Cards ── */
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.card-body{padding:20px 24px}
.card-row{display:flex;align-items:center;gap:12px;padding:13px 24px;border-bottom:1px solid var(--border-sub)}
.card-row:last-child{border-bottom:none}

/* ── Stats ── */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px 18px}
.stat-val{font-size:28px;font-weight:700;letter-spacing:-0.5px;line-height:1;margin-bottom:6px}
.stat-lbl{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--text-sub)}

/* ── Badges ── */
.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;border:1px solid;white-space:nowrap}
.badge-green{color:var(--badge-green);background:var(--badge-green-bg);border-color:var(--badge-green-border)}
.badge-red{color:var(--badge-red);background:var(--badge-red-bg);border-color:var(--badge-red-border)}
.badge-gray{color:var(--text-sub);background:var(--bg);border-color:var(--border)}

/* ── Members ── */
.member-avatar{width:34px;height:34px;border-radius:50%;background:var(--text);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0}
.member-name{font-size:14px;font-weight:500}
.member-meta{font-size:12px;color:var(--text-sub);margin-top:1px}

/* ── Invites ── */
.invite-label{font-size:14px;font-weight:600}
.invite-meta{font-size:12px;color:var(--text-sub);margin-top:2px}
.card-row.dimmed{opacity:.45}

/* ── QR / connection ── */
.qr-wrap{background:#fff;border:1px solid var(--border);border-radius:10px;padding:12px;display:inline-block;flex-shrink:0}
.qr-wrap img{display:block;width:136px;height:136px}
.conn-row{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}
.conn-info{flex:1;min-width:220px;display:flex;flex-direction:column;gap:14px}
.field-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--text-sub);margin-bottom:5px}
.input-row{display:flex;gap:8px;align-items:center}
.mono-input{flex:1;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 12px;font-family:monospace;outline:none;min-width:0;transition:border-color .15s}
.mono-input:focus{border-color:var(--text)}
.hint{font-size:12px;color:var(--text-sub);line-height:1.6;margin-top:4px}

/* ── Backup ── */
.backup-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.select{background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);font-size:13px;padding:7px 10px;outline:none;cursor:pointer}
.select:focus{border-color:var(--text)}
.backup-table{width:100%;border-collapse:collapse}
.backup-table th{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.7px;color:var(--text-sub);text-align:left;padding:8px 14px;border-bottom:1px solid var(--border)}
.backup-table td{font-size:13px;padding:11px 14px;border-bottom:1px solid var(--border-sub);color:var(--text);vertical-align:middle}
.backup-table tr:last-child td{border-bottom:none}
.backup-table tr:hover td{background:var(--bg)}
.td-dim{color:var(--text-sub)!important;font-size:12px!important}

/* ── Empty ── */
.empty{color:var(--text-dim);font-size:13px;padding:20px 24px}

/* ── Modal ── */
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100;backdrop-filter:blur(2px)}
.modal{background:#fff;border:1px solid var(--border);border-radius:16px;padding:28px;width:100%;max-width:440px;display:flex;flex-direction:column;gap:20px;box-shadow:0 20px 60px rgba(0,0,0,.15)}
.modal-title{font-size:17px;font-weight:700;letter-spacing:-0.2px}
.modal-qr{background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px;align-self:center}
.modal-qr img{display:block;width:220px;height:220px}
.modal-url{font-family:monospace;font-size:12px;color:var(--text-sub);word-break:break-all;background:var(--bg);border-radius:8px;padding:10px 14px;border:1px solid var(--border)}
.modal-hint{color:var(--text-sub);font-size:12px;text-align:center;line-height:1.6}
.modal-foot{display:flex;gap:10px}
.modal-foot .btn{flex:1}

/* ── Spinner ── */
.spinner-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}
.spinner{width:26px;height:26px;border:2.5px solid var(--border);border-top-color:var(--text);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

@media(max-width:680px){
  .sidebar{width:100%;height:auto;position:relative;border-right:none;border-bottom:1px solid var(--border)}
  .sb-nav{flex-direction:row;padding:6px 10px;overflow-x:auto;gap:4px}
  .nav-item{white-space:nowrap}
  .main{margin-left:0;padding:20px 16px}
}
</style>
</head>
<body>

<div id="v-loading" class="spinner-wrap"><div class="spinner"></div></div>

<!-- Auth: Setup -->
<div id="v-setup" class="auth-wrap hidden">
  <div class="auth-box">
    <div class="auth-logo">
      <div class="auth-logo-mark"><svg viewBox="0 0 20 20"><path d="M10 2L3 6v4c0 4.4 3 8.4 7 9.3 4-1 7-4.9 7-9.3V6L10 2z"/></svg></div>
      <div class="auth-logo-name">FamilyVault</div>
    </div>
    <div class="auth-card">
      <div class="auth-head">
        <div class="auth-title">Create admin account</div>
        <div class="auth-sub">First-time setup. You'll manage the vault from this account.</div>
      </div>
      <div class="field"><label>Vault name</label><input id="setup-vault-name" placeholder="e.g. The Smith Family" autocomplete="off" value="Family Vault"></div>
      <div class="field"><label>Your name</label><input id="setup-name" placeholder="Admin name" autocomplete="off"></div>
      <div class="field"><label>Password</label><input id="setup-pass" type="password" placeholder="8+ characters"></div>
      <div id="setup-err" class="err hidden"></div>
      <button class="btn" id="setup-btn" onclick="doSetup()">Create Account</button>
    </div>
  </div>
</div>

<!-- Auth: Login -->
<div id="v-login" class="auth-wrap hidden">
  <div class="auth-box">
    <div class="auth-logo">
      <div class="auth-logo-mark"><svg viewBox="0 0 20 20"><path d="M10 2L3 6v4c0 4.4 3 8.4 7 9.3 4-1 7-4.9 7-9.3V6L10 2z"/></svg></div>
      <div class="auth-logo-name">FamilyVault</div>
    </div>
    <div class="auth-card">
      <div class="auth-head">
        <div class="auth-title">Admin sign in</div>
      </div>
      <div class="field"><label>Name</label><input id="login-name" placeholder="Admin name" autocomplete="off"></div>
      <div class="field"><label>Password</label><input id="login-pass" type="password" placeholder="Password"></div>
      <div id="login-err" class="err hidden"></div>
      <button class="btn" id="login-btn" onclick="doLogin()">Sign In</button>
    </div>
  </div>
</div>

<!-- Dashboard -->
<div id="v-dash" class="dash hidden">
  <aside class="sidebar">
    <div class="sb-top">
      <div class="sb-logo">
        <div class="sb-logo-mark"><svg viewBox="0 0 20 20"><path d="M10 2L3 6v4c0 4.4 3 8.4 7 9.3 4-1 7-4.9 7-9.3V6L10 2z"/></svg></div>
        <div class="sb-logo-name">FamilyVault</div>
      </div>
      <div class="sb-vname" id="vault-name-chip"></div>
    </div>

    <nav class="sb-nav">
      <button class="nav-item active" data-sec="s-overview" onclick="showSection('s-overview')">
        <svg viewBox="0 0 20 20" fill="currentColor"><rect x="2" y="2" width="7" height="7" rx="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5"/><rect x="11" y="11" width="7" height="7" rx="1.5"/></svg>
        Overview
      </button>
      <button class="nav-item" data-sec="s-members" onclick="showSection('s-members')">
        <svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>
        Members
      </button>
      <button class="nav-item" data-sec="s-invites" onclick="showSection('s-invites')">
        <svg viewBox="0 0 20 20" fill="currentColor"><path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z"/><path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z"/></svg>
        Invites
      </button>
      <div class="nav-divider"></div>
      <button class="nav-item" data-sec="s-connection" onclick="showSection('s-connection')">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/></svg>
        Connection
      </button>
      <button class="nav-item" data-sec="s-backups" onclick="showSection('s-backups')">
        <svg viewBox="0 0 20 20" fill="currentColor"><path d="M7 3a1 1 0 000 2h6a1 1 0 100-2H7zM4 7a1 1 0 011-1h10a1 1 0 110 2H5a1 1 0 01-1-1zM2 11a2 2 0 012-2h12a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4z"/></svg>
        Backups
      </button>
      <button class="nav-item" data-sec="s-settings" onclick="showSection('s-settings')">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
        Settings
      </button>
    </nav>

    <div class="sb-foot">
      <div class="sb-admin">
        <span class="sb-admin-name" id="admin-name"></span>
        <button class="sb-signout" onclick="doLogout()">Sign out</button>
      </div>
    </div>
  </aside>

  <main class="main">

    <!-- Overview -->
    <div id="s-overview" class="page">
      <div>
        <div class="page-title">Overview</div>
        <div class="page-sub">At-a-glance stats for your vault.</div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-val" id="stat-members">—</div><div class="stat-lbl">Members</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-posts">—</div><div class="stat-lbl">Posts</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-stories">—</div><div class="stat-lbl">Active Dailys</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-messages">—</div><div class="stat-lbl">Messages</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-storage">—</div><div class="stat-lbl">Storage</div></div>
      </div>
    </div>

    <!-- Members -->
    <div id="s-members" class="page hidden">
      <div>
        <div class="page-title">Members</div>
        <div class="page-sub">Everyone who has joined the vault.</div>
      </div>
      <div class="card">
        <div id="members-grid"></div>
      </div>
    </div>

    <!-- Invites -->
    <div id="s-invites" class="page hidden">
      <div class="page-head">
        <div>
          <div class="page-title">Invites</div>
          <div class="page-sub">Create a personal invite link for each new family member.</div>
        </div>
        <button class="btn btn-sm" onclick="showCreateInvite()">+ New Invite</button>
      </div>
      <div class="card">
        <div id="invites-list"></div>
      </div>
    </div>

    <!-- Connection -->
    <div id="s-connection" class="page hidden">
      <div>
        <div class="page-title">Vault Connection</div>
        <div class="page-sub">QR code for returning members. Set the URL to your Cloudflare domain for remote access.</div>
      </div>
      <div class="card card-body">
        <div class="conn-row">
          <div class="qr-wrap"><img id="vault-qr-img" src="" alt="QR" width="136" height="136"></div>
          <div class="conn-info">
            <div>
              <div class="field-label">Server URL</div>
              <div class="input-row">
                <input id="server-url-input" class="mono-input" placeholder="http://192.168.1.100:3000">
                <button class="btn btn-sm" onclick="saveServerUrl(this)">Save</button>
              </div>
              <div class="hint">Set to your Cloudflare domain (https://vault.yourdomain.com) for remote access, or your Pi's LAN IP for local only.</div>
            </div>
            <div class="hint">Returning members scan this QR in the app to sign back in. New members need a personal invite.</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Backups -->
    <div id="s-backups" class="page hidden">
      <div class="page-head">
        <div>
          <div class="page-title">Backups</div>
          <div class="page-sub">Encrypted snapshots saved to the server's storage volume.</div>
        </div>
        <button class="btn btn-sm" onclick="runBackupNow(this)">Back Up Now</button>
      </div>
      <div class="card card-body" style="display:flex;flex-direction:column;gap:16px">
        <div class="backup-controls">
          <span style="font-size:13px;font-weight:500">Auto-backup</span>
          <select id="backup-schedule" class="select" onchange="saveBackupSchedule()">
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          <span style="font-size:13px;font-weight:500;margin-left:8px">Keep last</span>
          <select id="backup-keep" class="select" onchange="saveBackupSchedule()">
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="30">30</option>
          </select>
          <span id="backup-last" style="font-size:12px;color:var(--text-sub)"></span>
        </div>
        <div id="backup-list"></div>
      </div>
    </div>

    <!-- Settings -->
    <div id="s-settings" class="page hidden">
      <div>
        <div class="page-title">Settings</div>
        <div class="page-sub">Vault configuration.</div>
      </div>
      <div class="card card-body" style="display:flex;flex-direction:column;gap:14px">
        <div>
          <div class="field-label">Vault Name</div>
          <div class="input-row" style="margin-top:6px">
            <input id="vault-name-input" style="flex:1;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;color:var(--text);font-size:14px;padding:10px 12px;outline:none;min-width:0;transition:border-color .15s" placeholder="Family Vault">
            <button class="btn btn-sm" onclick="saveVaultName(this)">Save</button>
          </div>
          <div class="hint" style="margin-top:6px">Displayed in the app header and on the connection screen.</div>
        </div>
      </div>
    </div>

  </main>
</div>

<!-- Modal: Create Invite -->
<div id="m-create" class="modal-backdrop hidden">
  <div class="modal">
    <div class="modal-title">New Invite</div>
    <div class="field"><label>For who?</label><input id="invite-label" placeholder="e.g. Grandma Jones" autocomplete="off"></div>
    <div class="field"><label>Your admin password</label><input id="invite-admin-pass" type="password" placeholder="Confirm your password" autocomplete="current-password"></div>
    <div id="create-err" class="err hidden"></div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="hideCreateInvite()">Cancel</button>
      <button class="btn" id="create-btn" onclick="doCreateInvite()">Create</button>
    </div>
  </div>
</div>

<!-- Modal: Temp Password -->
<div id="m-temppass" class="modal-backdrop hidden" onclick="hideTempPass(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-title">Set Temporary Password</div>
    <div id="temppass-hint" style="font-size:13px;color:var(--text-sub);line-height:1.5"></div>
    <div class="field"><label>Temporary Password</label><input id="temppass-input" type="text" placeholder="e.g. Family2024Reset" autocomplete="off"></div>
    <div class="field"><label>Your admin password</label><input id="temppass-admin-pass" type="password" placeholder="Confirm your password" autocomplete="current-password"></div>
    <div id="temppass-err" class="err hidden"></div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="hideTempPass()">Cancel</button>
      <button class="btn" id="temppass-btn" onclick="doSetTempPass()">Set &amp; Tell Them</button>
    </div>
  </div>
</div>

<!-- Modal: QR Code -->
<div id="m-qr" class="modal-backdrop hidden" onclick="hideQr(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-title" id="qr-title">Invite</div>
    <div class="modal-qr"><img id="qr-img" src="" alt="QR" width="220" height="220"></div>
    <div class="modal-url" id="qr-code-text"></div>
    <div class="modal-hint" id="qr-hint">Scan in the FamilyVault app to join. One-time use — expires in 7 days.</div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="copyQrCode()">Copy Link</button>
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
function showSection(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  show(id);
  document.querySelector('[data-sec="' + id + '"]')?.classList.add('active');
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
  TOKEN = null; sessionStorage.removeItem('fv_admin_token'); showView('v-login');
}

async function loadDashboard(status) {
  showView('v-dash');
  if (!status) { try { status = await apiFetch('/admin/api/status'); } catch {} }
  const vn = status?.vaultName || '';
  document.getElementById('vault-name-chip').textContent = vn;
  if (document.getElementById('vault-name-input') && !document.getElementById('vault-name-input').value)
    document.getElementById('vault-name-input').value = vn;
  document.getElementById('admin-name').textContent = TOKEN ? (JSON.parse(atob(TOKEN.split('.')[1]))?.name || '') : '';
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

async function saveVaultName(btn) {
  const name = document.getElementById('vault-name-input').value.trim();
  if (!name) { alert('Enter a vault name'); return; }
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await apiFetch('/admin/api/vault-name', { method: 'POST', body: JSON.stringify({ vaultName: name }) });
    document.getElementById('vault-name-chip').textContent = name;
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  } catch (e) { alert('Error: ' + e.message); btn.textContent = orig; btn.disabled = false; }
}

async function saveServerUrl(btn) {
  const url = document.getElementById('server-url-input').value.trim();
  if (!url) { alert('Enter a URL first'); return; }
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await apiFetch('/admin/api/server-url', { method: 'POST', body: JSON.stringify({ url }) });
    const vaultData = await apiFetch('/admin/api/vault-qr');
    document.getElementById('vault-qr-img').src = vaultData.qr;
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  } catch (e) { alert('Error: ' + e.message); btn.textContent = orig; btn.disabled = false; }
}

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

async function loadBackups() {
  try {
    const { settings, backups } = await apiFetch('/admin/api/backups');
    document.getElementById('backup-schedule').value = settings.schedule || 'off';
    const keepSel = document.getElementById('backup-keep');
    const opt = Array.from(keepSel.options).find(o => o.value === String(settings.keepLast || 5));
    if (opt) keepSel.value = opt.value;
    if (settings.lastBackupAt)
      document.getElementById('backup-last').textContent = 'Last: ' + new Date(settings.lastBackupAt).toLocaleString();
    renderBackups(backups);
  } catch {}
}

function renderBackups(backups) {
  const el = document.getElementById('backup-list');
  if (!backups.length) { el.innerHTML = '<div class="empty">No backups yet.</div>'; return; }
  el.innerHTML = \`
    <table class="backup-table">
      <thead><tr><th>File</th><th>Size</th><th>Created</th><th></th></tr></thead>
      <tbody>\${backups.map(b => \`
        <tr>
          <td style="font-family:monospace;font-size:12px">\${esc(b.name)}</td>
          <td class="td-dim">\${fmtBytes(b.size)}</td>
          <td class="td-dim" style="white-space:nowrap">\${new Date(b.createdAt).toLocaleString()}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-outline btn-xs" style="margin-right:6px" onclick="restoreBackup('\${esc(b.name)}','\${new Date(b.createdAt).toLocaleString()}')">Restore</button>
            <button class="btn btn-danger btn-xs" onclick="deleteBackup('\${esc(b.name)}')">Delete</button>
          </td>
        </tr>\`).join('')}
      </tbody>
    </table>
    <div style="font-size:12px;color:var(--text-dim);margin-top:10px;padding:0 2px">To download a backup, SSH into the Pi and copy from the Docker volume.</div>
  \`;
}

async function runBackupNow(btn) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await apiFetch('/admin/api/backup/run', { method: 'POST' });
    btn.textContent = '✓ Done';
    document.getElementById('backup-last').textContent = 'Last: ' + new Date().toLocaleString();
    await loadBackups();
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  } catch (e) { alert('Backup failed: ' + e.message); btn.textContent = orig; btn.disabled = false; }
}

async function saveBackupSchedule() {
  try {
    await apiFetch('/admin/api/backup/settings', { method: 'POST', body: JSON.stringify({
      schedule: document.getElementById('backup-schedule').value,
      keepLast: Number(document.getElementById('backup-keep').value),
    })});
  } catch (e) { alert('Error: ' + e.message); }
}

async function deleteBackup(name) {
  if (!confirm('Delete this backup? Cannot be undone.')) return;
  try { await apiFetch('/admin/api/backups/' + encodeURIComponent(name), { method: 'DELETE' }); await loadBackups(); }
  catch (e) { alert('Error: ' + e.message); }
}

async function restoreBackup(name, dateStr) {
  if (!confirm('Restore backup from ' + dateStr + '?\\n\\nThis replaces ALL current data and restarts the server. Cannot be undone.')) return;
  try {
    await apiFetch('/admin/api/backup/restore/' + encodeURIComponent(name), { method: 'POST' });
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:14px;font-family:sans-serif"><div style="font-size:20px;font-weight:700">Restoring…</div><div style="font-size:13px;color:#888">Server is restarting. Page will reload shortly.</div></div>';
    const poll = setInterval(async () => { try { await fetch('/admin/api/status'); clearInterval(poll); location.reload(); } catch {} }, 2000);
  } catch (e) { alert('Restore failed: ' + e.message); }
}

function renderMembers(members) {
  const el = document.getElementById('members-grid');
  if (!members.length) { el.innerHTML = '<div class="empty">No members yet. Create an invite to add someone.</div>'; return; }
  el.innerHTML = members.map(m => \`
    <div class="card-row">
      <div class="member-avatar">\${m.name[0].toUpperCase()}</div>
      <div class="member-info" style="flex:1">
        <div class="member-name">\${esc(m.name)}\${m.resetRequested ? ' <span class="badge badge-red" style="font-size:10px;vertical-align:middle;margin-left:6px">Reset requested</span>' : ''}</div>
        <div class="member-meta">Joined \${m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '—'}\${m.hasTempPassword ? ' · Temp password active' : ''}</div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="showSetTempPass('\${esc(m.name)}')">Temp Pass</button>
      <button class="btn btn-danger btn-sm" onclick="removeMember('\${esc(m.name)}')">Remove</button>
    </div>
  \`).join('');
}

function renderInvites(invites) {
  const el = document.getElementById('invites-list');
  if (!invites.length) { el.innerHTML = '<div class="empty">No invites yet. Create one to add a family member.</div>'; return; }
  el.innerHTML = invites.map(inv => {
    const badge = inv.revoked
      ? '<span class="badge badge-red">Revoked</span>'
      : inv.used ? \`<span class="badge badge-gray">Used by \${esc(inv.usedBy||'')}</span>\`
      : '<span class="badge badge-green">Active</span>';
    const dim = inv.revoked || inv.used ? ' dimmed' : '';
    return \`
      <div class="card-row\${dim}">
        <div style="flex:1">
          <div class="invite-label">\${esc(inv.label)}</div>
          <div class="invite-meta">Created \${new Date(inv.createdAt).toLocaleDateString()}\${inv.used ? ' · Used '+new Date(inv.usedAt).toLocaleDateString() : ''}</div>
        </div>
        \${badge}
        \${!inv.revoked && !inv.used ? \`
          <button class="btn btn-sm" style="margin-left:8px" onclick="showQr('\${inv.id}','\${esc(inv.label)}')">Show QR</button>
          <button class="btn btn-danger btn-sm" onclick="revokeInvite('\${inv.id}')">Revoke</button>
        \` : (!inv.revoked ? \`<button class="btn btn-outline btn-sm" style="margin-left:8px" onclick="showQr('\${inv.id}','\${esc(inv.label)}')">View QR</button>\` : '')}
      </div>
    \`;
  }).join('');
}

let tempPassTarget = null;
function showSetTempPass(name) {
  tempPassTarget = name;
  document.getElementById('temppass-input').value = '';
  document.getElementById('temppass-admin-pass').value = '';
  document.getElementById('temppass-hint').textContent = 'Set a temporary password for ' + name + '. They sign in once with it, then create a new one.';
  setErr('temppass-err', '');
  document.getElementById('temppass-btn').disabled = false;
  show('m-temppass');
  setTimeout(() => document.getElementById('temppass-input').focus(), 50);
}
function hideTempPass(e) { if (!e || e.target === document.getElementById('m-temppass')) hide('m-temppass'); }
async function doSetTempPass() {
  const btn = document.getElementById('temppass-btn');
  const pw = document.getElementById('temppass-input').value.trim();
  const ap = document.getElementById('temppass-admin-pass').value;
  if (!pw || pw.length < 4) { setErr('temppass-err', 'Must be at least 4 characters'); return; }
  if (!ap) { setErr('temppass-err', 'Enter your admin password'); return; }
  btn.disabled = true; setErr('temppass-err', '');
  try {
    await apiFetch(\`/admin/api/members/\${encodeURIComponent(tempPassTarget)}/set-temp-password\`, { method: 'POST', body: JSON.stringify({ tempPassword: pw, adminPassword: ap }) });
    hide('m-temppass');
    alert('Temp password set for ' + tempPassTarget + '.\\n\\nTell them to sign in with:\\n' + pw + '\\n\\nThey will be prompted to set a new password immediately.');
    renderMembers(await apiFetch('/admin/api/members'));
  } catch (e) { setErr('temppass-err', e.message); btn.disabled = false; }
}

async function removeMember(name) {
  if (!confirm(\`Remove \${name}?\\n\\nPermanently deletes all their posts, stories, messages, and files. Cannot be undone.\`)) return;
  try {
    await apiFetch(\`/admin/api/members/\${encodeURIComponent(name)}\`, { method: 'DELETE' });
    renderMembers(await apiFetch('/admin/api/members'));
    loadStats();
  } catch (e) { alert('Error: ' + e.message); }
}

let currentQrCode = '';
async function showQr(inviteId, label) {
  const stored = sessionStorage.getItem('fv_invite_' + inviteId);
  if (stored) {
    try { const { url, qr } = JSON.parse(stored); await showInviteQr(label, url, qr); }
    catch { alert('QR data missing — revoke and create a new invite.'); }
  } else {
    alert('QR code is only available during the session it was created.\\n\\nRevoke this invite and create a new one to get a fresh QR code.');
  }
}
function hideQr(e) { if (!e || e.target === document.getElementById('m-qr')) hide('m-qr'); }
function copyQrCode() { navigator.clipboard.writeText(currentQrCode).then(() => alert('Copied!')); }

function showCreateInvite() {
  document.getElementById('invite-label').value = '';
  document.getElementById('invite-admin-pass').value = '';
  setErr('create-err', '');
  document.getElementById('create-btn').disabled = false;
  show('m-create');
  setTimeout(() => document.getElementById('invite-label').focus(), 50);
}
function hideCreateInvite() { hide('m-create'); }

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('invite-label').addEventListener('keydown', e => { if (e.key === 'Enter') doCreateInvite(); });
});

async function doCreateInvite() {
  const btn = document.getElementById('create-btn');
  btn.disabled = true; setErr('create-err', '');
  const label = document.getElementById('invite-label').value.trim();
  const ap = document.getElementById('invite-admin-pass').value;
  if (!label) { setErr('create-err', 'Enter a name for this invite'); btn.disabled = false; return; }
  if (!ap) { setErr('create-err', 'Enter your admin password'); btn.disabled = false; return; }
  try {
    const result = await apiFetch('/admin/api/invites', { method: 'POST', body: JSON.stringify({ label, adminPassword: ap }) });
    sessionStorage.setItem('fv_invite_' + result.id, JSON.stringify({ url: result.inviteUrl, qr: result.qrDataUrl }));
    hide('m-create');
    await showInviteQr(label, result.inviteUrl, result.qrDataUrl);
    renderInvites(await apiFetch('/admin/api/invites'));
  } catch (e) { setErr('create-err', e.message); btn.disabled = false; }
}

async function showInviteQr(label, inviteUrl, qrDataUrl) {
  document.getElementById('qr-title').textContent = label;
  document.getElementById('qr-code-text').textContent = inviteUrl;
  currentQrCode = inviteUrl;
  document.getElementById('qr-img').src = qrDataUrl || '';
  show('m-qr');
}

async function revokeInvite(id) {
  if (!confirm('Revoke this invite? Cannot be undone.')) return;
  try {
    await apiFetch(\`/admin/api/invites/\${id}\`, { method: 'DELETE' });
    renderInvites(await apiFetch('/admin/api/invites'));
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
