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
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname) || (file.mimetype.startsWith('video') ? '.mp4' : '.jpg');
    cb(null, `story-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) return cb(null, true);
    if (file.mimetype === 'application/octet-stream' && file.originalname.endsWith('.enc')) return cb(null, true);
    cb(new Error('Only image or video files allowed for stories'));
  },
});

const uploadStoryFields = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'videoClips', maxCount: 5 },
  { name: 'thumbClips', maxCount: 5 },
]);

function auth(req, res, next) {
  try { req.member = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function withStoryUrls(req, story) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const base = `${proto}://${req.get('host')}`;
  const clips = (story.clips || []).map((c) => ({
    ...c,
    url: `${base}/storage/${c.filename}`,
    thumbUrl: c.thumbFilename ? `${base}/storage/${c.thumbFilename}` : null,
  }));
  return {
    ...story,
    imageUrl: `${base}/storage/${story.filename}`,
    clips,
  };
}

router.get('/stories', auth, (req, res) => {
  res.json(db.getActiveStories(req.member.name).map((s) => withStoryUrls(req, s)));
});

router.post('/stories', auth, (req, res, next) => {
  uploadStoryFields(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, (req, res) => {
  const photoFile = req.files?.photo?.[0];
  const videoClipFiles = req.files?.videoClips || [];
  const thumbClipFiles = req.files?.thumbClips || [];

  if (!photoFile && videoClipFiles.length === 0) {
    return res.status(400).json({ error: 'No media provided' });
  }

  const hours = Math.min(Math.max(Number(req.body.durationHours) || 24, 1), 168);
  const caption = String(req.body.caption || '').slice(0, 300);

  if (videoClipFiles.length > 0) {
    const clips = videoClipFiles.map((f, i) => ({
      filename: f.filename,
      thumbFilename: thumbClipFiles[i]?.filename || null,
      durationSecs: req.body[`clipDuration${i}`] ? Number(req.body[`clipDuration${i}`]) : null,
    }));
    // Use first clip filename as the primary story filename for backward compat
    const story = db.insertStory(videoClipFiles[0].filename, req.member.name, hours, caption, clips);
    return res.json(withStoryUrls(req, story));
  }

  const story = db.insertStory(photoFile.filename, req.member.name, hours, caption);
  res.json(withStoryUrls(req, story));
});

router.delete('/stories/:id', auth, (req, res) => {
  try { db.deleteStory(Number(req.params.id), req.member.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Record that the current member viewed this story (idempotent).
// Response carries no viewer identities — both client call sites ignore it.
router.post('/stories/:id/view', auth, (req, res) => {
  db.recordStoryView(Number(req.params.id), req.member.name);
  res.json({ ok: true, views: [] });
});

// Toggle a reaction emoji on a story — echo back only the caller's own entry
router.post('/stories/:id/reactions', auth, (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  try {
    const me = req.member.name.toLowerCase();
    const reactions = db.toggleStoryReaction(Number(req.params.id), req.member.name, emoji)
      .filter((r) => r.author.toLowerCase() === me);
    res.json({ reactions });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Toggle like on a Daily — echo back only the caller's own entry
router.post('/stories/:id/like', auth, (req, res) => {
  try {
    const me = req.member.name.toLowerCase();
    const likes = db.toggleStoryLike(Number(req.params.id), req.member.name)
      .filter((n) => n.toLowerCase() === me);
    res.json({ likes });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Get viewers + reactions — only the story author can call this
router.get('/stories/:id/viewers', auth, (req, res) => {
  try { res.json(db.getStoryViewers(Number(req.params.id), req.member.name)); }
  catch (e) { res.status(403).json({ error: e.message }); }
});

module.exports = router;
