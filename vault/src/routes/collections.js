const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/sqlite');
const { JWT_SECRET } = require('./auth');

const router = express.Router();

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

// GET /collections — only collections the user is a member of or created
router.get('/collections', auth, (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const base = `${proto}://${req.get('host')}`;
  const me = req.member.name;
  const allMembersId = db.getAllMembersCollectionId();
  const collections = db.getCollections(me).map((c) => {
    // Dangling post ids are cleaned up on post delete + startup, so postIds is
    // accurate — no need to load every post (All Members holds most of them)
    const thumbFile = db.getCollectionThumbFile(c.id);
    return {
      ...c,
      postCount: c.postIds.length,
      thumbnailUrl: thumbFile ? `${base}/storage/${thumbFile}` : null,
      memberCount: (c.memberNames || [c.author]).length,
      isOwner: c.author === me,
      isSystem: c.id === allMembersId,
    };
  });
  res.json(collections);
});

router.post('/collections', auth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  res.json(db.insertCollection(name.trim(), req.member.name));
});

router.delete('/collections/:id', auth, (req, res) => {
  try { db.deleteCollection(Number(req.params.id), req.member.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// GET posts — membership checked server-side
router.get('/collections/:id/posts', auth, (req, res) => {
  try { res.json(db.getCollectionPosts(Number(req.params.id), req.member.name).map((p) => withBase(req, p))); }
  catch (e) { res.status(403).json({ error: e.message }); }
});

// Any member can add a post to any collection they're a member of
router.post('/collections/:id/posts', auth, (req, res) => {
  const { postId } = req.body;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  try { res.json(db.addToCollection(Number(req.params.id), Number(postId), req.member.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/collections/:id/posts/:postId', auth, (req, res) => {
  try { db.removeFromCollection(Number(req.params.id), Number(req.params.postId)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /collections/:id/members — creator invites a family member
router.post('/collections/:id/members', auth, (req, res) => {
  const { memberName } = req.body;
  if (!memberName) return res.status(400).json({ error: 'memberName required' });
  try { res.json(db.addCollectionMember(Number(req.params.id), memberName, req.member.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /collections/:id/members/:memberName — creator removes a member
router.delete('/collections/:id/members/:memberName', auth, (req, res) => {
  try { res.json(db.removeCollectionMember(Number(req.params.id), req.params.memberName, req.member.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
