const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/sqlite');
const { JWT_SECRET } = require('./auth');

const router = express.Router();

function auth(req, res, next) {
  try { req.member = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// GET /notifications — latest activity for the requesting member
router.get('/notifications', auth, (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const base = `${proto}://${req.get('host')}`;
  const items = db.getNotifications(req.member.name).map(({ thumbFile, ...n }) => ({
    ...n,
    thumbUrl: thumbFile ? `${base}/storage/${thumbFile}` : null,
  }));
  res.json(items);
});

router.post('/notifications/seen', auth, (req, res) => {
  db.markNotificationsSeen(req.member.name);
  res.json({ ok: true });
});

// Lightweight badge poll: unseen notifications + total unread messages.
// gifEnabled rides along so clients can hide GIF buttons on vaults with no key.
router.get('/notifications/summary', auth, (req, res) => {
  res.json({
    unseenNotifications: db.getUnseenNotificationCount(req.member.name),
    unreadMessages: db.getTotalUnread(req.member.name),
    gifEnabled: !!process.env.TENOR_KEY,
  });
});

// POST /push/register — client sends its Expo push token after login
router.post('/push/register', auth, (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.length > 200)
    return res.status(400).json({ error: 'token required' });
  db.upsertPushToken(token, req.member.name);
  res.json({ ok: true });
});

module.exports = router;
