const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const jwt = require('jsonwebtoken');

const { STORAGE_DIR, VAULT_NAME, JWT_SECRET } = require('./config');

const authRoutes = require('./routes/auth');
const postsRoutes = require('./routes/posts');
const storiesRoutes = require('./routes/stories');
const collectionsRoutes = require('./routes/collections');
const messagesRoutes = require('./routes/messages');
const gifRoutes = require('./routes/gif');
const adminRoutes = require('./routes/admin');
const uploadsRoutes = require('./routes/uploads');
const db = require('./db/sqlite');

// ─── Public API (port 3000, all interfaces, Cloudflare-facing) ───────────────
const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

app.set('trust proxy', true);
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Protected media — JWT required
app.get('/storage/:filename', (req, res) => {
  try {
    jwt.verify((req.headers.authorization || req.query.token || '').replace('Bearer ', ''), JWT_SECRET);
  } catch { return res.status(401).end(); }
  res.sendFile(path.join(STORAGE_DIR, path.basename(req.params.filename)));
});

app.use(authRoutes);
app.use(postsRoutes);
app.use(storiesRoutes);
app.use(collectionsRoutes);
app.use(messagesRoutes);
app.use(gifRoutes);
app.use(uploadsRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', vaultName: VAULT_NAME }));

// ─── Admin panel (port 3001, localhost only — never reachable via tunnel) ────
const adminApp = express();
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT) || 3001;

adminApp.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
adminApp.use(express.json({ limit: '1mb' }));
adminApp.use(express.urlencoded({ extended: false, limit: '1mb' }));
adminApp.use(adminRoutes);
adminApp.get('/', (req, res) => res.redirect('/admin'));

// ─── Cleanup: purge expired stories every hour ────────────────────────────────
function purgeExpiredStories() {
  try {
    const files = db.purgeExpiredStories();
    for (const fn of files)
      try { fs.unlinkSync(path.join(STORAGE_DIR, fn)); } catch {}
    if (files.length) console.log(`[cleanup] removed ${files.length} expired story file(s)`);
  } catch {}
}
purgeExpiredStories();
setInterval(purgeExpiredStories, 60 * 60 * 1000);

// ─── Start both servers ───────────────────────────────────────────────────────
function getLocalIp() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const addr of iface)
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  return 'localhost';
}

http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`\n  FamilyVault running`);
  console.log(`  API:      http://${getLocalIp()}:${PORT}`);
});

http.createServer(adminApp).listen(ADMIN_PORT, '127.0.0.1', () => {
  console.log(`  Admin:    http://localhost:${ADMIN_PORT}/admin`);
  console.log(`  (admin is localhost-only — not reachable via Cloudflare tunnel)\n`);
});
