const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/sqlite');
const { JWT_SECRET } = require('./auth');

const router = express.Router();

const { STORAGE_DIR } = require('../config');
const storage = multer.diskStorage({
  destination: STORAGE_DIR,
  filename: (_, file, cb) => cb(null, `story-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname) || '.jpg'}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Only image files allowed for stories')),
});

function auth(req, res, next) {
  try { req.member = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function withImageUrl(req, story) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const base = `${proto}://${req.get('host')}`;
  return { ...story, imageUrl: `${base}/storage/${story.filename}` };
}

router.get('/stories', auth, (req, res) => {
  res.json(db.getActiveStories().map((s) => withImageUrl(req, s)));
});

router.post('/stories', auth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo' });
  const hours = Math.min(Math.max(Number(req.body.durationHours) || 24, 1), 168);
  const caption = String(req.body.caption || '').slice(0, 300);
  const story = db.insertStory(req.file.filename, req.member.name, hours, caption);
  res.json(withImageUrl(req, story));
});

router.delete('/stories/:id', auth, (req, res) => {
  try { db.deleteStory(Number(req.params.id), req.member.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Record that the current member viewed this story (idempotent)
router.post('/stories/:id/view', auth, (req, res) => {
  const views = db.recordStoryView(Number(req.params.id), req.member.name);
  res.json({ views: views || [] });
});

// Toggle a reaction emoji on a story
router.post('/stories/:id/reactions', auth, (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  try {
    const reactions = db.toggleStoryReaction(Number(req.params.id), req.member.name, emoji);
    res.json({ reactions });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Toggle like on a Daily
router.post('/stories/:id/like', auth, (req, res) => {
  try { res.json({ likes: db.toggleStoryLike(Number(req.params.id), req.member.name) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Get viewers + reactions — only the story author can call this
router.get('/stories/:id/viewers', auth, (req, res) => {
  try { res.json(db.getStoryViewers(Number(req.params.id), req.member.name)); }
  catch (e) { res.status(403).json({ error: e.message }); }
});

module.exports = router;
