const express = require('express');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');
const fs = require('fs');
const db = require('../db/sqlite');
const { JWT_SECRET } = require('./auth');

const STORAGE_DIR = path.join(__dirname, '../../storage');
const AVATAR_DIR = path.join(STORAGE_DIR, 'avatars');

const router = express.Router();
const PORT = process.env.PORT || 3000;

function getLocalIp() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const addr of iface)
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  return 'localhost';
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
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

// ─── API ──────────────────────────────────────────────────────────────────────

router.get('/admin/api/status', (req, res) => {
  res.json({ setupDone: db.isSetupDone(), vaultUrl: `http://${getLocalIp()}:${PORT}` });
});

router.post('/admin/api/setup', adminRateLimit, (req, res) => {
  if (db.isSetupDone()) return res.status(409).json({ error: 'Already configured' });
  const { name, password } = req.body;
  if (!name?.trim() || !password) return res.status(400).json({ error: 'Name and password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Admin password must be at least 8 characters' });
  try {
    db.createAdmin(name.trim(), password);
    const token = jwt.sign({ role: 'admin', name: name.trim() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, name: name.trim() });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// Simple rate limiter (shared with auth.js pattern)
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

router.post('/admin/api/login', adminRateLimit, (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
  const admin = db.verifyAdmin(name, password);
  if (!admin) return res.status(401).json({ error: 'Incorrect name or password' });
  const token = jwt.sign({ role: 'admin', name: admin.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, name: admin.name });
});

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

router.get('/admin/api/vault-qr', requireAdmin, async (req, res) => {
  const localUrl = `http://${getLocalIp()}:${PORT}`;
  const externalUrl = PUBLIC_URL || localUrl;
  const qr = await QRCode.toDataURL(externalUrl, { width: 300, margin: 2, color: { dark: '#000', light: '#fff' } });
  res.json({ qr, localUrl, externalUrl });
});

router.get('/admin/api/members', requireAdmin, (req, res) => {
  res.json(db.getMembers().map((m) => ({ id: m.id, name: m.name, createdAt: m.createdAt })));
});

router.delete('/admin/api/members/:name', requireAdmin, (req, res) => {
  try {
    const { storageFiles, avatarName } = db.removeMemberWithContent(req.params.name);
    // Delete their uploaded files from disk
    for (const fn of storageFiles) {
      try { fs.unlinkSync(path.join(STORAGE_DIR, fn)); } catch {}
    }
    // Delete their avatar
    try { fs.unlinkSync(path.join(AVATAR_DIR, `${avatarName.replace(/[^a-zA-Z0-9]/g, '_')}.jpg`)); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

router.get('/admin/api/invites', requireAdmin, (req, res) => {
  res.json(db.listInviteLinks());
});

router.post('/admin/api/invites', requireAdmin, (req, res) => {
  const { label } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: 'Label required (e.g. "Grandma Jones")' });
  const link = db.createInviteLink(label.trim(), req.admin.name);
  res.json(link);
});

router.delete('/admin/api/invites/:code', requireAdmin, (req, res) => {
  try {
    db.revokeInviteLink(req.params.code);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/admin/api/invites/:code/qr', requireAdmin, async (req, res) => {
  const { code } = req.params;
  const base = PUBLIC_URL || `http://${getLocalIp()}:${PORT}`;
  const vaultCode = `${base}/${code}`;
  const qr = await QRCode.toDataURL(vaultCode, { width: 320, margin: 2, color: { dark: '#000', light: '#fff' } });
  res.json({ qr, vaultCode });
});

// ─── Admin SPA ────────────────────────────────────────────────────────────────

router.get('/admin', (req, res) => res.send(adminPage()));

function adminPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FamilyVault</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
.hidden{display:none!important}
/* ── Auth views ── */
.auth-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px;gap:32px}
.brand{font-size:28px;font-weight:700;letter-spacing:-0.5px}
.auth-card{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:16px;padding:32px;width:100%;max-width:400px;display:flex;flex-direction:column;gap:20px}
.auth-title{font-size:18px;font-weight:600}
.auth-sub{color:#555;font-size:13px;margin-top:-12px;line-height:1.5}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#555}
.field input{background:#111;border:1px solid #222;border-radius:8px;color:#fff;font-size:15px;padding:13px 14px;outline:none;transition:border-color .15s}
.field input:focus{border-color:#fff}
.btn{background:#fff;color:#000;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:14px;cursor:pointer;transition:opacity .15s}
.btn:hover{opacity:.88}
.btn:disabled{opacity:.3;cursor:default}
.btn-outline{background:transparent;color:#fff;border:1px solid #333}
.btn-danger{background:#e53935;color:#fff}
.btn-sm{font-size:13px;padding:8px 14px;border-radius:8px}
.err{color:#e53935;font-size:13px;text-align:center}
/* ── Dashboard layout ── */
.dash{display:flex;flex-direction:column;min-height:100vh}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:18px 28px;border-bottom:1px solid #111}
.topbar-brand{font-size:17px;font-weight:700}
.topbar-right{display:flex;align-items:center;gap:14px;color:#555;font-size:13px}
.content{max-width:900px;margin:0 auto;padding:32px 24px;display:flex;flex-direction:column;gap:36px;width:100%}
/* ── Section ── */
.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.section-title{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:#555}
/* ── Vault info ── */
.vault-card{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:14px;padding:24px;display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap}
.vault-qr{background:#fff;border-radius:10px;padding:12px;flex-shrink:0}
.vault-qr img{display:block;width:140px;height:140px}
.vault-info{display:flex;flex-direction:column;gap:10px;flex:1}
.vault-url-label{font-size:11px;color:#555;font-weight:600;text-transform:uppercase;letter-spacing:1px}
.vault-url{font-size:19px;font-weight:700;font-family:monospace;word-break:break-all}
.vault-hint{font-size:12px;color:#444;line-height:1.6}
/* ── Members ── */
.members-grid{display:flex;flex-direction:column;gap:10px}
.member-chip{display:flex;align-items:center;gap:12px;background:#0d0d0d;border:1px solid #1e1e1e;border-radius:10px;padding:12px 16px}
.member-avatar{width:36px;height:36px;border-radius:18px;background:#1e1e1e;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;flex-shrink:0}
.member-info{flex:1}
.member-name{font-size:14px;font-weight:500}
.member-date{font-size:11px;color:#444;margin-top:2px}
.empty-hint{color:#333;font-size:13px;padding:20px 0}
/* ── Invite cards ── */
.invites-list{display:flex;flex-direction:column;gap:10px}
.invite-card{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:12px;padding:18px 20px}
.invite-card.used{opacity:.5}
.invite-card.revoked{opacity:.4}
.invite-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.invite-label{font-size:15px;font-weight:600}
.badge{font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;border:1px solid}
.badge-active{color:#43a047;border-color:#43a047;background:rgba(67,160,71,.1)}
.badge-used{color:#555;border-color:#333;background:transparent}
.badge-revoked{color:#e53935;border-color:#e53935;background:rgba(229,57,53,.08)}
.invite-code{font-family:monospace;font-size:17px;letter-spacing:2px;color:#fff;margin-bottom:10px;word-break:break-all}
.invite-meta{font-size:11px;color:#444;margin-bottom:12px}
.invite-actions{display:flex;gap:8px;flex-wrap:wrap}
/* ── Modal ── */
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100}
.modal{background:#0d0d0d;border:1px solid #222;border-radius:16px;padding:28px;width:100%;max-width:440px;display:flex;flex-direction:column;gap:20px}
.modal-title{font-size:17px;font-weight:600}
.modal-qr-wrap{background:#fff;border-radius:10px;padding:14px;align-self:center}
.modal-qr-wrap img{display:block;width:240px;height:240px}
.modal-code{text-align:center;font-family:monospace;font-size:18px;letter-spacing:3px;color:#fff;background:#111;padding:14px;border-radius:8px;word-break:break-all}
.modal-hint{color:#555;font-size:12px;text-align:center;line-height:1.6}
.modal-foot{display:flex;gap:10px}
.modal-foot .btn{flex:1}
/* ── Spinner ── */
.spinner-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}
.spinner{width:28px;height:28px;border:3px solid #1e1e1e;border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<!-- Loading -->
<div id="v-loading" class="spinner-wrap"><div class="spinner"></div></div>

<!-- Setup view -->
<div id="v-setup" class="auth-wrap hidden">
  <div class="brand">FamilyVault</div>
  <div class="auth-card">
    <div>
      <div class="auth-title">Create admin account</div>
      <div class="auth-sub" style="margin-top:6px">This is the first time setup. Create an account to manage your vault.</div>
    </div>
    <div class="field"><label>Admin name</label><input id="setup-name" placeholder="e.g. Levi" autocomplete="off"></div>
    <div class="field"><label>Password</label><input id="setup-pass" type="password" placeholder="Choose a strong password"></div>
    <div id="setup-err" class="err hidden"></div>
    <button class="btn" id="setup-btn" onclick="doSetup()">Create Account</button>
  </div>
</div>

<!-- Login view -->
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
    <div class="topbar-brand">FamilyVault</div>
    <div class="topbar-right">
      <span id="admin-name"></span>
      <button class="btn btn-outline btn-sm" onclick="doLogout()">Sign out</button>
    </div>
  </div>

  <div class="content">

    <!-- Vault info -->
    <div>
      <div class="section-head"><span class="section-title">Vault Connection</span></div>
      <div class="vault-card">
        <div class="vault-qr"><img id="vault-qr-img" src="" alt="QR"></div>
        <div class="vault-info">
          <div class="vault-url-label">External address</div>
          <div class="vault-url" id="vault-url-ext"></div>
          <div class="vault-url-label" style="margin-top:10px">Local address</div>
          <div style="font-size:13px;font-family:monospace;color:#555" id="vault-url-local"></div>
          <div class="vault-hint" style="margin-top:10px">Returning members scan this QR code with the FamilyVault app to sign in anywhere. New members need a personal invite code below.</div>
        </div>
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
    <div id="create-err" class="err hidden"></div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="hideCreateInvite()">Cancel</button>
      <button class="btn" id="create-btn" onclick="doCreateInvite()">Create</button>
    </div>
  </div>
</div>

<!-- QR modal -->
<div id="m-qr" class="modal-backdrop hidden" onclick="hideQr(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-title" id="qr-title">Invite Code</div>
    <div class="modal-qr-wrap"><img id="qr-img" src="" alt="QR" width="240" height="240"></div>
    <div class="modal-code" id="qr-code-text"></div>
    <div class="modal-hint">Show this QR or share the code. The person scans it with FamilyVault app, or types it in the "Enter Code" field.</div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="copyQrCode()">Copy Code</button>
      <button class="btn" onclick="hideQr()">Done</button>
    </div>
  </div>
</div>

<script>
const api = window.location.origin;
let TOKEN = localStorage.getItem('fv_admin_token');

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
      try {
        await loadDashboard();
        return;
      } catch { TOKEN = null; localStorage.removeItem('fv_admin_token'); }
    }
    showView('v-login');
  } catch {
    showView('v-login');
  }
}

async function doSetup() {
  const btn = document.getElementById('setup-btn');
  btn.disabled = true; setErr('setup-err', '');
  try {
    const { token, name } = await apiFetch('/admin/api/setup', {
      method: 'POST',
      body: JSON.stringify({ name: document.getElementById('setup-name').value.trim(), password: document.getElementById('setup-pass').value }),
    });
    TOKEN = token; localStorage.setItem('fv_admin_token', token);
    await loadDashboard();
  } catch (e) { setErr('setup-err', e.message); btn.disabled = false; }
}

async function doLogin() {
  const btn = document.getElementById('login-btn');
  btn.disabled = true; setErr('login-err', '');
  try {
    const { token, name } = await apiFetch('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({ name: document.getElementById('login-name').value.trim(), password: document.getElementById('login-pass').value }),
    });
    TOKEN = token; localStorage.setItem('fv_admin_token', token);
    await loadDashboard();
  } catch (e) { setErr('login-err', e.message); btn.disabled = false; }
}

function doLogout() {
  TOKEN = null; localStorage.removeItem('fv_admin_token');
  showView('v-login');
}

async function loadDashboard() {
  showView('v-dash');
  const [vaultData, members, invites] = await Promise.all([
    apiFetch('/admin/api/vault-qr'),
    apiFetch('/admin/api/members'),
    apiFetch('/admin/api/invites'),
  ]);
  document.getElementById('admin-name').textContent = '';
  document.getElementById('vault-url-ext').textContent = vaultData.externalUrl;
  document.getElementById('vault-url-local').textContent = vaultData.localUrl;
  document.getElementById('vault-qr-img').src = vaultData.qr;
  renderMembers(members);
  renderInvites(invites);
}

function renderMembers(members) {
  const el = document.getElementById('members-grid');
  if (!members.length) { el.innerHTML = '<div class="empty-hint">No members yet.</div>'; return; }
  el.innerHTML = members.map(m => \`
    <div class="member-chip">
      <div class="member-avatar">\${m.name[0].toUpperCase()}</div>
      <div class="member-info">
        <div class="member-name">\${esc(m.name)}</div>
        <div class="member-date">Joined \${m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '—'}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removeMember('\${esc(m.name)}')">Remove</button>
    </div>
  \`).join('');
}

async function removeMember(name) {
  if (!confirm(\`Remove \${name} from the vault?\\n\\nThis permanently deletes ALL their posts, stories, messages, and files. This cannot be undone.\`)) return;
  try {
    await apiFetch(\`/admin/api/members/\${encodeURIComponent(name)}\`, { method: 'DELETE' });
    const members = await apiFetch('/admin/api/members');
    renderMembers(members);
  } catch (e) { alert('Error: ' + e.message); }
}

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
      <div class="invite-card \${cls}" id="inv-\${inv.code}">
        <div class="invite-top">
          <div class="invite-label">\${esc(inv.label)}</div>
          \${badge}
        </div>
        <div class="invite-code" id="code-\${inv.code}">—</div>
        <div class="invite-meta">Created \${created}\${inv.used ? ' · Used ' + new Date(inv.usedAt).toLocaleDateString() : ''}</div>
        <div class="invite-actions">
          \${!inv.revoked && !inv.used ? \`
            <button class="btn btn-sm" onclick="showQr('\${inv.code}','\${esc(inv.label)}')">Show QR</button>
            <button class="btn btn-outline btn-sm" onclick="copyCode('\${inv.code}')">Copy Code</button>
            <button class="btn btn-danger btn-sm" onclick="revokeInvite('\${inv.code}')">Revoke</button>
          \` : \`
            \${!inv.revoked ? \`<button class="btn btn-outline btn-sm" onclick="showQr('\${inv.code}','\${esc(inv.label)}')">View QR</button>\` : ''}
          \`}
        </div>
      </div>
    \`;
  }).join('');
  // Load vault codes for each invite
  invites.forEach(inv => loadInviteCode(inv.code));
}

async function loadInviteCode(code) {
  try {
    const { vaultCode } = await apiFetch(\`/admin/api/invites/\${code}/qr\`);
    const el = document.getElementById('code-' + code);
    if (el) el.textContent = vaultCode;
  } catch {}
}

let currentQrCode = '';
async function showQr(code, label) {
  try {
    const { qr, vaultCode } = await apiFetch(\`/admin/api/invites/\${code}/qr\`);
    document.getElementById('qr-title').textContent = label;
    document.getElementById('qr-img').src = qr;
    document.getElementById('qr-code-text').textContent = vaultCode;
    currentQrCode = vaultCode;
    show('m-qr');
  } catch (e) { alert('Error: ' + e.message); }
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
  if (!label) { setErr('create-err', 'Enter a name for this invite'); btn.disabled = false; return; }
  try {
    await apiFetch('/admin/api/invites', { method: 'POST', body: JSON.stringify({ label }) });
    hide('m-create');
    const invites = await apiFetch('/admin/api/invites');
    renderInvites(invites);
  } catch (e) { setErr('create-err', e.message); btn.disabled = false; }
}

async function revokeInvite(code) {
  if (!confirm('Revoke this invite code? It cannot be undone.')) return;
  try {
    await apiFetch(\`/admin/api/invites/\${code}\`, { method: 'DELETE' });
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
