const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { JWT_SECRET } = require('./auth');

const router = express.Router();
const STORAGE_DIR = path.join(__dirname, '../../storage');
const CHUNKS_DIR = path.join(__dirname, '../../storage/.chunks');
fs.mkdirSync(CHUNKS_DIR, { recursive: true });

function auth(req, res, next) {
  try { req.member = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: CHUNKS_DIR,
    filename: (req, file, cb) => {
      const { uploadId, chunkIndex } = req.body;
      if (!uploadId || chunkIndex == null) return cb(new Error('Missing uploadId or chunkIndex'));
      cb(null, `${uploadId}-${String(chunkIndex).padStart(5, '0')}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per chunk
}).single('chunk');

// POST /upload/init — start a chunked upload session
router.post('/upload/init', auth, (req, res) => {
  const uploadId = crypto.randomBytes(16).toString('hex');
  res.json({ uploadId });
});

// POST /upload/chunk — receive one chunk
router.post('/upload/chunk', auth, (req, res) => {
  chunkUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No chunk received' });
    res.json({ ok: true, chunkIndex: Number(req.body.chunkIndex) });
  });
});

// POST /upload/finalize — assemble chunks into final file
router.post('/upload/finalize', auth, (req, res) => {
  const { uploadId, totalChunks, mimeType } = req.body;
  if (!uploadId || !totalChunks) return res.status(400).json({ error: 'uploadId and totalChunks required' });

  const n = Number(totalChunks);
  const ext = mimeType?.startsWith('video') ? '.mp4' : mimeType?.startsWith('image') ? '.jpg' : '.bin';
  const finalName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const finalPath = path.join(STORAGE_DIR, finalName);

  try {
    const out = fs.openSync(finalPath, 'w');
    for (let i = 0; i < n; i++) {
      const chunkPath = path.join(CHUNKS_DIR, `${uploadId}-${String(i).padStart(5, '0')}`);
      if (!fs.existsSync(chunkPath)) {
        fs.closeSync(out);
        fs.unlinkSync(finalPath);
        return res.status(400).json({ error: `Missing chunk ${i}` });
      }
      const data = fs.readFileSync(chunkPath);
      fs.writeSync(out, data);
      fs.unlinkSync(chunkPath); // clean up chunk immediately
    }
    fs.closeSync(out);
    res.json({ filename: finalName });
  } catch (e) {
    try { fs.unlinkSync(finalPath); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// Cleanup stale chunk sessions older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  try {
    fs.readdirSync(CHUNKS_DIR).forEach((f) => {
      const p = path.join(CHUNKS_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    });
  } catch {}
}, 30 * 60 * 1000);

module.exports = router;
