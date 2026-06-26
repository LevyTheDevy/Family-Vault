const express = require('express');
const https = require('https');

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');

const router = express.Router();
const TENOR_KEY = process.env.TENOR_KEY || 'LIVDSRZULELA';

function auth(req, res, next) {
  try { req.member = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function tenorGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

router.get('/gif/search', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const url = `https://api.tenor.com/v1/search?key=${TENOR_KEY}&q=${encodeURIComponent(q)}&limit=24&media_filter=minimal&contentfilter=high`;
    const data = await tenorGet(url);
    const results = (data.results || []).map((r) => {
      const media = r.media?.[0] || {};
      return {
        id: r.id,
        gifUrl: media.gif?.url || '',
        previewUrl: media.tinygif?.url || media.gif?.url || '',
      };
    }).filter((r) => r.gifUrl);
    res.json({ results });
  } catch {
    res.json({ results: [] });
  }
});

module.exports = router;
