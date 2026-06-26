const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/sqlite');
const { JWT_SECRET } = require('./auth');

const router = express.Router();

const { STORAGE_DIR } = require('../config');
const storage = multer.diskStorage({
  destination: STORAGE_DIR,
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname) || (file.mimetype.startsWith('video') ? '.mp4' : '.jpg');
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_, file, cb) => /^(image|video)\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Only image or video files allowed')),
});

// Accept: photos[] (images), video (single), thumbnail (single thumb for video)
const uploadFields = upload.fields([
  { name: 'photos', maxCount: 10 },
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]);

function auth(req, res, next) {
  try { req.member = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function withBase(req, post) {
  const base = `${req.protocol}://${req.get('host')}`;
  const filenames = post.filenames || (post.filename ? [post.filename] : []);
  const imageUrls = filenames.map((f) => `${base}/storage/${f}`);
  const videoUrl = post.videoFilename ? `${base}/storage/${post.videoFilename}` : null;
  const thumbnailUrl = post.thumbnailFilename ? `${base}/storage/${post.thumbnailFilename}` : null;
  return { ...post, imageUrls, imageUrl: imageUrls[0] || null, videoUrl, thumbnailUrl };
}

router.get('/posts', auth, (req, res) => {
  res.json(db.getPosts(req.member.name).map((p) => withBase(req, p)));
});

router.post('/posts', auth, uploadFields, (req, res) => {
  const photos = req.files?.photos || [];
  const videos = req.files?.video || [];
  const thumbnails = req.files?.thumbnail || [];

  if (!photos.length && !videos.length) {
    return res.status(400).json({ error: 'No media provided' });
  }

  const caption = req.body.caption || '';

  if (videos.length) {
    // Video post
    const videoFile = videos[0];
    const thumbFile = thumbnails[0] || null;
    const durationSecs = req.body.durationSecs ? Number(req.body.durationSecs) : null;
    const post = db.insertPost(
      [], // no image filenames for video posts
      req.member.name,
      caption,
      'video',
      videoFile.filename,
      thumbFile ? thumbFile.filename : null,
      durationSecs,
    );
    res.json(withBase(req, post));
  } else {
    // Photo post
    const filenames = photos.map((f) => f.filename);
    const post = db.insertPost(filenames, req.member.name, caption);
    res.json(withBase(req, post));
  }
});

// POST /posts/from-upload — create a post from pre-uploaded (chunked) filename
router.post('/posts/from-upload', auth, (req, res) => {
  const { videoFilename, thumbnailFilename, caption, durationSecs } = req.body;
  if (!videoFilename) return res.status(400).json({ error: 'videoFilename required' });
  // Sanitize — must be a simple filename, no path traversal
  const safeVideo = path.basename(videoFilename);
  const safeThumb = thumbnailFilename ? path.basename(thumbnailFilename) : null;
  if (!fs.existsSync(path.join(STORAGE_DIR, safeVideo))) {
    return res.status(400).json({ error: 'Uploaded file not found' });
  }
  const post = db.insertPost([], req.member.name, caption || '', 'video', safeVideo, safeThumb, durationSecs ? Number(durationSecs) : null);
  res.json(withBase(req, post));
});

router.delete('/posts/:id', auth, (req, res) => {
  try {
    const filenames = db.deletePost(Number(req.params.id), req.member.name);
    for (const fn of filenames) {
      const filePath = path.join(STORAGE_DIR, fn);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/posts/:id/like', auth, (req, res) => {
  try { res.json({ likes: db.toggleLike(Number(req.params.id), req.member.name) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/posts/:id/save', auth, (req, res) => {
  try { res.json({ savedBy: db.toggleSave(Number(req.params.id), req.member.name) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/posts/:id/comments', auth, (req, res) => {
  const { text, gifUrl, imageX, imageY, imageIndex } = req.body;
  if (!text?.trim() && !gifUrl) return res.status(400).json({ error: 'Text or GIF required' });
  if (text && String(text).length > 2000) return res.status(400).json({ error: 'Comment too long (max 2000 chars)' });
  try {
    res.json(db.addComment(
      Number(req.params.id), req.member.name,
      (text || '').trim(), gifUrl || null,
      imageX != null ? Number(imageX) : null,
      imageY != null ? Number(imageY) : null,
      imageIndex != null ? Number(imageIndex) : 0,
    ));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/posts/:id/comments/:commentId', auth, (req, res) => {
  try { db.deleteComment(Number(req.params.id), Number(req.params.commentId), req.member.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
