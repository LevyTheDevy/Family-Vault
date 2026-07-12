const express = require('express');
const https = require('https');

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');

const router = express.Router();
// Tenor v2 requires a (free) Google API key — the old v1 API and its public
// demo key were shut down by Google, which silently broke GIF search.
const TENOR_KEY = process.env.TENOR_KEY || '';

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
  if (!TENOR_KEY) {
    return res.json({ results: [], error: 'GIF search is not set up on this vault (missing TENOR_KEY).' });
  }
  try {
    const url = `https://tenor.googleapis.com/v2/search?key=${TENOR_KEY}&q=${encodeURIComponent(q)}&limit=24&media_filter=gif,tinygif&contentfilter=high`;
    const data = await tenorGet(url);
    const results = (data.results || []).map((r) => ({
      id: r.id,
      gifUrl: r.media_formats?.gif?.url || '',
      previewUrl: r.media_formats?.tinygif?.url || r.media_formats?.gif?.url || '',
    })).filter((r) => r.gifUrl);
    res.json({ results });
  } catch {
    res.json({ results: [], error: 'GIF search failed — check the vault\'s internet access.' });
  }
});

module.exports = router;
