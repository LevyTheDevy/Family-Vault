const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/sqlite');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'familyvault-poc-secret';

const { STORAGE_DIR } = require('../config');
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
  // db.getMembers() already returns { id, name, avatarVersion }
  res.json(db.getMembers());
});

router.post('/join', rateLimited, (req, res) => {
  const { name, password, inviteCode } = req.body;
  if (!name || !password || !inviteCode) return res.status(400).json({ error: 'Name, password, and invite code are required' });
  const trimName = String(name).trim();
  if (trimName.length < 2 || trimName.length > 40) return res.status(400).json({ error: 'Name must be 2–40 characters' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (!db.checkInviteCode(inviteCode)) return res.status(403).json({ error: 'Invalid or already-used invite code' });
  try {
    const member = db.insertMember(trimName, password);
    db.markInviteLinkUsed(String(inviteCode).trim().toUpperCase(), trimName);
    const token = jwt.sign({ id: member.id, name: member.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, name: member.name });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

router.post('/login', rateLimited, (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password are required' });
  const member = db.verifyMember(String(name).trim(), password);
  if (!member) return res.status(401).json({ error: 'Incorrect name or password' });
  const token = jwt.sign({ id: member.id, name: member.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, name: member.name });
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
    const token = jwt.sign({ id: updated.id, name: updated.name }, JWT_SECRET, { expiresIn: '30d' });
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
