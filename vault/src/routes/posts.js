const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/sqlite');
const { JWT_SECRET } = require('./auth');
const push = require('../push');

const router = express.Router();

// After creating a post: file it into a collection (the one the client chose,
// else the All Members catch-all) and notify everyone who can see it.
function afterPostCreate(req, post) {
  const me = req.member.name;
  const colId = req.body.collectionId ? Number(req.body.collectionId) : null;
  const canSee = db.assignPostCollection(post.id, colId, me);
  const others = canSee.filter((n) => n.toLowerCase() !== me.toLowerCase());
  for (const n of others) db.addNotification(n, 'post', me, post.id);
  push.notify(others, 'FamilyVault', `${me} shared a new post`, { type: 'post', postId: post.id });
}

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
  { name: 'videoClips', maxCount: 5 },
  { name: 'thumbClips', maxCount: 5 },
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
  const feedImageUrls = filenames.map((f, i) => `${base}/storage/${feedFn[i] || f}`);
  const thumbImageUrls = filenames.map((f, i) => `${base}/storage/${thumbFn[i] || f}`);
  const videoClips = (post.videoClips || []).map((c) => ({
    ...c,
    url: `${base}/storage/${c.filename}`,
    thumbUrl: c.thumbFilename ? `${base}/storage/${c.thumbFilename}` : null,
  }));
  const videoUrl = post.videoFilename
    ? `${base}/storage/${post.videoFilename}`
    : (videoClips[0]?.url || null);
  const thumbnailUrl = post.thumbnailFilename
    ? `${base}/storage/${post.thumbnailFilename}`
    : (videoClips[0]?.thumbUrl || null);
  return {
    ...post,
    imageUrls, imageUrl: imageUrls[0] || null,
    feedImageUrls, feedImageUrl: feedImageUrls[0] || null,
    thumbImageUrls, thumbImageUrl: thumbImageUrls[0] || null,
    videoUrl, thumbnailUrl, videoClips,
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
  const videoClipFiles = req.files?.videoClips || [];
  const thumbClipFiles = req.files?.thumbClips || [];

  console.log('[posts] POST /posts — photos:', photos.length, 'videos:', videos.length, 'clips:', videoClipFiles.length);

  if (!photos.length && !videos.length && !videoClipFiles.length) {
    return res.status(400).json({ error: 'No media provided' });
  }

  const caption = req.body.caption || '';

  if (videoClipFiles.length > 0) {
    // Multi-clip encrypted video post
    const videoClips = videoClipFiles.map((f, i) => ({
      filename: f.filename,
      thumbFilename: thumbClipFiles[i]?.filename || null,
      durationSecs: req.body[`clipDuration${i}`] ? Number(req.body[`clipDuration${i}`]) : null,
    }));
    const post = db.insertPost([], req.member.name, caption, 'video', null, null, null, [], [], videoClips);
    afterPostCreate(req, post);
    return res.json(withBase(req, post));
  } else if (videos.length) {
    // Single legacy video post
    const videoFile = videos[0];
    const thumbFile = thumbnails[0] || null;
    const durationSecs = req.body.durationSecs ? Number(req.body.durationSecs) : null;
    const post = db.insertPost([], req.member.name, caption, 'video', videoFile.filename, thumbFile ? thumbFile.filename : null, durationSecs);
    afterPostCreate(req, post);
    return res.json(withBase(req, post));
  } else {
    // Photo post
    const filenames = photos.map((f) => f.filename);
    const feedFilenames = feedPhotos.map((f) => f.filename);
    const thumbFilenames = thumbPhotos.map((f) => f.filename);
    const post = db.insertPost(filenames, req.member.name, caption, 'image', null, null, null, feedFilenames, thumbFilenames);
    afterPostCreate(req, post);
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
  afterPostCreate(req, post);
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
  try {
    const postId = Number(req.params.id);
    const me = req.member.name;
    const { likes, liked, postAuthor } = db.toggleLike(postId, me);
    if (postAuthor.toLowerCase() !== me.toLowerCase()) {
      if (liked) {
        db.addNotification(postAuthor, 'like', me, postId);
        push.notify([postAuthor], 'FamilyVault', `${me} liked your post`, { type: 'like', postId });
      } else {
        db.removeLikeNotification(postAuthor, me, postId);
      }
    }
    res.json({ likes });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Record a view — fired by the client when a post is actually on screen
router.post('/posts/:id/view', auth, (req, res) => {
  try { db.recordPostView(Number(req.params.id), req.member.name); res.json({ ok: true }); }
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
    const postId = Number(req.params.id);
    const me = req.member.name;
    const comment = db.addComment(
      postId, me,
      (text || '').trim(), gifUrl || null,
      imageX != null ? Number(imageX) : null,
      imageY != null ? Number(imageY) : null,
      imageIndex != null ? Number(imageIndex) : 0,
    );
    const postAuthor = db.getPostAuthor(postId);
    if (postAuthor && postAuthor.toLowerCase() !== me.toLowerCase()) {
      db.addNotification(postAuthor, 'comment', me, postId);
      push.notify([postAuthor], 'FamilyVault', `${me} commented on your post`, { type: 'comment', postId });
    }
    res.json(comment);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/posts/:id/comments/:commentId', auth, (req, res) => {
  try { db.deleteComment(Number(req.params.id), Number(req.params.commentId), req.member.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
