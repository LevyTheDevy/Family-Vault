const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/sqlite');

const router = express.Router();
const { STORAGE_DIR, VAULT_ACCESS_KEY, JWT_SECRET } = require('../config');
const { getVaultName } = require('../config');
const AVATAR_DIR = path.join(STORAGE_DIR, 'avatars');

function safeName(name) { return name.replace(/[^a-zA-Z0-9]/g, '_'); }

// ─── Simple in-process rate limiter ──────────────────────────────────────────
const _attempts = new Map();
setInterval(() => _attempts.clear(), 15 * 60 * 1000); // purge every 15 min

function checkRate(key, max = 8, windowMs = 60_000) {
  const now = Date.now();
  const entry = _attempts.get(key) || { n: 0, start: now };
  if (now - entry.start > windowMs) { entry.n = 1; entry.start = now; }
  else entry.n++;
  _attempts.set(key, entry);
  return entry.n > max;
}

function rateLimited(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  if (checkRate(key)) return res.status(429).json({ error: 'Too many attempts — wait a minute and try again.' });
  next();
}

const avatarUpload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Only image files allowed')),
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
    filename: (req, _file, cb) => cb(null, `${safeName(req.member.name)}.jpg`),
  }),
});

function auth(req, res, next) {
  try { req.member = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

router.get('/members', (req, res) => {
  const key = req.headers['x-vault-key'] || req.query.vk;
  if (key === VAULT_ACCESS_KEY) return res.json(db.getMembers());
  // Also accept a valid JWT so authenticated in-app screens can list members
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try { jwt.verify(token, JWT_SECRET); return res.json(db.getMembers()); } catch {}
  res.status(401).json({ error: 'Invalid vault key' });
});

// GET /auth/invite/:token — app fetches invite info before signup (does not consume it)
router.get('/invite/:token', (req, res) => {
  const rawToken = req.params.token;
  if (!/^[0-9a-f]{64}$/i.test(rawToken))
    return res.status(400).json({ error: 'Invalid invite token format' });
  const tokenHash = crypto.createHash('sha256').update(Buffer.from(rawToken, 'hex')).digest('hex');
  const invite = db.getInviteByTokenHash(tokenHash);
  if (!invite) return res.status(404).json({ error: 'Invite not found, already used, or expired' });
  res.json({
    vaultName: getVaultName(),
    label: invite.label,
    inviteKdfSalt: invite.inviteKdfSalt,
    inviteWrappedVaultKey: invite.inviteWrappedVaultKey,
    expiresAt: invite.expiresAt,
  });
});

router.post('/join', rateLimited, (req, res) => {
  const { name, password, inviteCode, token: rawToken, kdfSalt, wrappedVaultKey } = req.body;

  // Validate identity
  const trimName = String(name || '').trim();
  if (trimName.length < 2 || trimName.length > 40)
    return res.status(400).json({ error: 'Name must be 2–40 characters' });
  if (!password || String(password).length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  // Validate invite — support both new crypto tokens and legacy short codes
  let tokenHash = null;
  if (rawToken) {
    if (!/^[0-9a-f]{64}$/i.test(rawToken))
      return res.status(400).json({ error: 'Invalid invite token' });
    tokenHash = crypto.createHash('sha256').update(Buffer.from(rawToken, 'hex')).digest('hex');
    if (!db.getInviteByTokenHash(tokenHash))
      return res.status(403).json({ error: 'Invite not found, already used, or expired' });
  } else if (inviteCode) {
    if (!db.checkInviteCode(inviteCode))
      return res.status(403).json({ error: 'Invalid or already-used invite code' });
  } else {
    return res.status(400).json({ error: 'Invite token or code required' });
  }

  try {
    const member = db.insertMember(trimName, password);

    if (tokenHash) {
      if (kdfSalt && wrappedVaultKey) db.setUserCrypto(member.id, kdfSalt, wrappedVaultKey);
      db.markInviteLinkUsed(tokenHash, trimName);
    } else {
      db.markInviteLinkUsed(String(inviteCode).trim().toUpperCase(), trimName);
    }

    const jwtToken = jwt.sign({ id: member.id, name: member.name }, JWT_SECRET, { expiresIn: '7d' });
    const userCrypto = db.getUserCrypto(member.id);
    res.json({
      token: jwtToken,
      name: member.name,
      kdfSalt: userCrypto?.kdfSalt || null,
      wrappedVaultKey: userCrypto?.wrappedVaultKey || null,
    });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

router.post('/login', rateLimited, (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password are required' });
  const member = db.loginMember(String(name).trim(), password);
  if (!member) return res.status(401).json({ error: 'Incorrect name or password' });
  const token = jwt.sign({ id: member.id, name: member.name }, JWT_SECRET, { expiresIn: '7d' });
  const userCrypto = db.getUserCrypto(member.id);
  res.json({
    token,
    name: member.name,
    requiresPasswordReset: member.requiresPasswordReset || false,
    kdfSalt: userCrypto?.kdfSalt || null,
    wrappedVaultKey: userCrypto?.wrappedVaultKey || null,
  });
});

router.post('/request-reset', rateLimited, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    db.requestPasswordReset(String(name).trim());
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

router.post('/change-password', auth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'New password required' });
  try {
    db.confirmPasswordReset(req.member.name, String(newPassword));
    const token = jwt.sign({ id: req.member.id, name: req.member.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Called after a password change to re-wrap vault key with new password
router.post('/update-crypto', auth, (req, res) => {
  const { kdfSalt, wrappedVaultKey } = req.body;
  if (!kdfSalt || !wrappedVaultKey)
    return res.status(400).json({ error: 'kdfSalt and wrappedVaultKey required' });
  db.setUserCrypto(req.member.id, kdfSalt, wrappedVaultKey);
  res.json({ ok: true });
});

router.patch('/members/me', auth, (req, res) => {
  const { newName, currentPassword, newPassword } = req.body;

  // Require current password for any change
  if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
  if (!db.verifyMember(req.member.name, currentPassword)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  try {
    const oldName = req.member.name;
    const updated = db.updateMember(oldName, { newName, newPassword });
    if (newName && updated.name !== oldName) {
      const oldFile = path.join(AVATAR_DIR, `${safeName(oldName)}.jpg`);
      const newFile = path.join(AVATAR_DIR, `${safeName(updated.name)}.jpg`);
      try { if (fs.existsSync(oldFile)) fs.renameSync(oldFile, newFile); } catch {}
    }
    const token = jwt.sign({ id: updated.id, name: updated.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, name: updated.name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/members/me/avatar', auth, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const avatarVersion = db.updateAvatarVersion(req.member.name);
  res.json({ ok: true, avatarVersion });
});

router.delete('/members/me/avatar', auth, (req, res) => {
  const file = path.join(AVATAR_DIR, `${safeName(req.member.name)}.jpg`);
  try { fs.unlinkSync(file); } catch {}
  db.updateAvatarVersion(req.member.name);
  res.json({ ok: true });
});

router.get('/members/:name/avatar', (req, res) => {
  // Accept token in query param so React Native Image can load it without custom headers
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token || '';
  try { jwt.verify(token, JWT_SECRET); } catch { return res.status(401).end(); }
  const file = path.join(AVATAR_DIR, `${safeName(req.params.name)}.jpg`);
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).end();
});

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;
