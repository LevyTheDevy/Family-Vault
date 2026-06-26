const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/sqlite');
const { JWT_SECRET } = require('./auth');

const router = express.Router();

const { STORAGE_DIR } = require('../config');
const mediaStorage = multer.diskStorage({
  destination: STORAGE_DIR,
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname) || (file.mimetype.startsWith('video') ? '.mp4' : '.jpg');
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});
const uploadMedia = multer({
  storage: mediaStorage,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_, file, cb) => /^(image|video)\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Only image or video files allowed')),
}).single('media');

function auth(req, res, next) {
  try { req.member = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function resolveConversation(convo, me) {
  if (convo.isDM) {
    const otherName = convo.memberNames.find((n) => n !== me) || convo.memberNames[0];
    return { ...convo, name: otherName };
  }
  return convo;
}

router.get('/conversations', auth, (req, res) => {
  const me = req.member.name;
  const convos = db.getConversations(me).map((c) => resolveConversation(c, me));
  res.json(convos);
});

router.post('/conversations', auth, (req, res) => {
  const { name, memberNames } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const all = Array.isArray(memberNames) && memberNames.length
    ? memberNames
    : db.getMembers().map((m) => m.name);
  res.json(db.insertConversation(name.trim(), all, req.member.name));
});

router.post('/conversations/dm', auth, (req, res) => {
  const { targetMember } = req.body;
  if (!targetMember) return res.status(400).json({ error: 'targetMember required' });
  const me = req.member.name;
  const convo = db.findOrCreateDM(me, targetMember);
  res.json({ ...convo, name: targetMember });
});

router.get('/conversations/:id/messages', auth, (req, res) => {
  try { res.json(db.getMessages(Number(req.params.id), req.member.name)); }
  catch (e) { res.status(403).json({ error: e.message }); }
});

router.post('/conversations/:id/messages', auth, (req, res) => {
  const { text, gifUrl, replyToId, postRef } = req.body;
  if (!text?.trim() && !gifUrl && !postRef) return res.status(400).json({ error: 'text, GIF, or post required' });
  if (text && String(text).length > 5000) return res.status(400).json({ error: 'Message too long (max 5000 chars)' });
  const safeRef = postRef && typeof postRef === 'object'
    ? { id: Number(postRef.id), imageUrl: String(postRef.imageUrl || ''), author: String(postRef.author || ''), caption: String(postRef.caption || '') }
    : null;
  try { res.json(db.insertMessage(Number(req.params.id), req.member.name, (text || '').trim(), gifUrl || null, null, null, replyToId || null, safeRef)); }
  catch (e) { res.status(403).json({ error: e.message }); }
});

router.post('/conversations/:id/messages/:msgId/react', auth, (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  try { res.json(db.reactToMessage(Number(req.params.msgId), req.member.name, emoji)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /conversations/:id/media — upload a photo or video as a message
router.post('/conversations/:id/media', auth, (req, res) => {
  uploadMedia(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const base = `${req.protocol}://${req.get('host')}`;
    const isVideo = req.file.mimetype.startsWith('video');
    const url = `${base}/storage/${req.file.filename}`;
    try {
      const msg = db.insertMessage(
        Number(req.params.id),
        req.member.name,
        '',
        null,
        isVideo ? null : url,
        isVideo ? url : null,
      );
      res.json(msg);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
});

// Mark all messages in a conversation as read by the requesting member
router.post('/conversations/:id/read', auth, (req, res) => {
  db.markMessagesRead(Number(req.params.id), req.member.name);
  res.json({ ok: true });
});

// Delete a single message (only the author can)
router.delete('/conversations/:id/messages/:msgId', auth, (req, res) => {
  try {
    db.deleteMessage(Number(req.params.msgId), req.member.name);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/conversations/:id/members', auth, (req, res) => {
  const { memberName } = req.body;
  if (!memberName) return res.status(400).json({ error: 'memberName required' });
  try { res.json(db.addConversationMember(Number(req.params.id), memberName, req.member.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/conversations/:id/members/:memberName', auth, (req, res) => {
  try { res.json(db.removeConversationMember(Number(req.params.id), req.params.memberName, req.member.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/conversations/:id', auth, (req, res) => {
  try {
    db.deleteConversation(Number(req.params.id), req.member.name);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
