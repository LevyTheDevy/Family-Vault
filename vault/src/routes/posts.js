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
  fileFilter: (_, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) return cb(null, true);
    if (file.mimetype === 'application/octet-stream' && file.originalname.endsWith('.enc')) return cb(null, true);
    cb(new Error('Only image or video files allowed'));
  },
});

const uploadFields = upload.fields([
  { name: 'photos', maxCount: 10 },
  { name: 'feedPhotos', maxCount: 10 },
  { name: 'thumbPhotos', maxCount: 10 },
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]);

function auth(req, res, next) {
  try { req.member = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function withBase(req, post) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const base = `${proto}://${req.get('host')}`;
  const filenames = post.filenames || (post.filename ? [post.filename] : []);
  const feedFn = post.feedFilenames || [];
  const thumbFn = post.thumbFilenames || [];
  const imageUrls = filenames.map((f) => `${base}/storage/${f}`);
  // Fall back to full-res URL for old posts that have no variant
  const feedImageUrls = filenames.map((f, i) => `${base}/storage/${feedFn[i] || f}`);
  const thumbImageUrls = filenames.map((f, i) => `${base}/storage/${thumbFn[i] || f}`);
  const videoUrl = post.videoFilename ? `${base}/storage/${post.videoFilename}` : null;
  const thumbnailUrl = post.thumbnailFilename ? `${base}/storage/${post.thumbnailFilename}` : null;
  return {
    ...post,
    imageUrls, imageUrl: imageUrls[0] || null,
    feedImageUrls, feedImageUrl: feedImageUrls[0] || null,
    thumbImageUrls, thumbImageUrl: thumbImageUrls[0] || null,
    videoUrl, thumbnailUrl,
  };
}

router.get('/posts', auth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const { posts, total } = db.getPosts(req.member.name, { limit, offset });
  res.json({ posts: posts.map((p) => withBase(req, p)), total, offset, limit });
});

router.post('/posts', auth, (req, res, next) => {
  uploadFields(req, res, (err) => {
    if (err) {
      console.error('[posts] multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, (req, res) => {
  const photos = req.files?.photos || [];
  const feedPhotos = req.files?.feedPhotos || [];
  const thumbPhotos = req.files?.thumbPhotos || [];
  const videos = req.files?.video || [];
  const thumbnails = req.files?.thumbnail || [];

  console.log('[posts] POST /posts — photos:', photos.map(f => `${f.originalname}(${f.mimetype},${f.size}b)`).join(', '), 'videos:', videos.length);

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
    const feedFilenames = feedPhotos.map((f) => f.filename);
    const thumbFilenames = thumbPhotos.map((f) => f.filename);
    const post = db.insertPost(filenames, req.member.name, caption, 'image', null, null, null, feedFilenames, thumbFilenames);
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
