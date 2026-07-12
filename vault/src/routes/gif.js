const express = require('express');
const https = require('https');

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');

const router = express.Router();

// GIF providers (both free): KLIPY needs only an email signup at
// partner.klipy.com; Tenor v2 needs a Google Cloud API key. KLIPY wins when
// both are set. With neither, clients hide their GIF buttons (gifEnabled).
const KLIPY_KEY = process.env.KLIPY_KEY || '';
const TENOR_KEY = process.env.TENOR_KEY || '';

const gifEnabled = () => !!(process.env.KLIPY_KEY || process.env.TENOR_KEY);

function auth(req, res, next) {
  try { req.member = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'FamilyVault' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// KLIPY media object: files[size][format].url — pick the first available
function pickKlipyUrl(files, sizes, formats) {
  for (const s of sizes) {
    for (const f of formats) {
      const url = files?.[s]?.[f]?.url;
      if (url) return url;
    }
  }
  return '';
}

async function searchKlipy(q) {
  const url = `https://api.klipy.com/api/v1/${KLIPY_KEY}/gifs/search?q=${encodeURIComponent(q)}&per_page=24&page=1&rating=pg`;
  const json = await getJson(url);
  const rows = json?.data?.data || [];
  return rows.map((r) => ({
    id: String(r.id ?? r.slug ?? Math.random()),
    gifUrl: pickKlipyUrl(r.files, ['md', 'hd', 'sm', 'xs'], ['gif']),
    previewUrl: pickKlipyUrl(r.files, ['xs', 'sm', 'md', 'hd'], ['gif', 'webp']),
  })).filter((r) => r.gifUrl);
}

async function searchTenor(q) {
  const url = `https://tenor.googleapis.com/v2/search?key=${TENOR_KEY}&q=${encodeURIComponent(q)}&limit=24&media_filter=gif,tinygif&contentfilter=high`;
  const json = await getJson(url);
  return (json.results || []).map((r) => ({
    id: r.id,
    gifUrl: r.media_formats?.gif?.url || '',
    previewUrl: r.media_formats?.tinygif?.url || r.media_formats?.gif?.url || '',
  })).filter((r) => r.gifUrl);
}

router.get('/gif/search', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  if (!gifEnabled()) {
    return res.json({ results: [], error: 'GIF search is not set up on this vault (missing KLIPY_KEY or TENOR_KEY).' });
  }
  try {
    const results = KLIPY_KEY ? await searchKlipy(q) : await searchTenor(q);
    res.json({ results });
  } catch {
    res.json({ results: [], error: 'GIF search failed — check the vault\'s internet access.' });
  }
});

module.exports = router;
module.exports.gifEnabled = gifEnabled;
