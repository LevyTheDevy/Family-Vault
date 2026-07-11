const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const jwt = require('jsonwebtoken');

const { STORAGE_DIR, getVaultName, JWT_SECRET } = require('./config');

const authRoutes = require('./routes/auth');
const postsRoutes = require('./routes/posts');
const storiesRoutes = require('./routes/stories');
const collectionsRoutes = require('./routes/collections');
const messagesRoutes = require('./routes/messages');
const gifRoutes = require('./routes/gif');
const adminRoutes = require('./routes/admin');
const uploadsRoutes = require('./routes/uploads');
const notificationsRoutes = require('./routes/notifications');
const db = require('./db/sqlite');

// ─── Public API (port 3000, all interfaces, Cloudflare-facing) ───────────────
const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

app.set('trust proxy', true);
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
// Gzip JSON responses (encrypted hex text compresses ~2x). Media is skipped:
// encrypted blobs don't compress and it would waste CPU on the Pi.
app.use(compression({
  filter: (req, res) => !req.path.startsWith('/storage') && compression.filter(req, res),
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Protected media — JWT required.
// Filenames are unique per upload (timestamp + random hex) and never rewritten,
// so clients may cache them forever.
app.get('/storage/:filename', (req, res) => {
  try {
    jwt.verify((req.headers.authorization || req.query.token || '').replace('Bearer ', ''), JWT_SECRET);
  } catch { return res.status(401).end(); }
  res.sendFile(path.join(STORAGE_DIR, path.basename(req.params.filename)), {
    maxAge: '365d',
    immutable: true,
  });
});

app.use(authRoutes);
app.use(postsRoutes);
app.use(storiesRoutes);
app.use(collectionsRoutes);
app.use(messagesRoutes);
app.use(gifRoutes);
app.use(uploadsRoutes);
app.use(notificationsRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', vaultName: getVaultName() }));

// ─── Admin panel (port 3001, localhost only — never reachable via tunnel) ────
const adminApp = express();
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT) || 3001;

adminApp.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
adminApp.use(express.json({ limit: '1mb' }));
adminApp.use(express.urlencoded({ extended: false, limit: '1mb' }));
adminApp.use(adminRoutes);
adminApp.get('/', (req, res) => res.redirect('/admin'));

// ─── Cleanup: purge expired stories + old notifications every hour ───────────
function runCleanup() {
  try {
    const files = db.purgeExpiredStories();
    for (const fn of files)
      try { fs.unlinkSync(path.join(STORAGE_DIR, fn)); } catch {}
    if (files.length) console.log(`[cleanup] removed ${files.length} expired story file(s)`);
  } catch {}
  try {
    const n = db.purgeOldNotifications(30);
    if (n) console.log(`[cleanup] removed ${n} old notification(s)`);
  } catch {}
}
runCleanup();
setInterval(runCleanup, 60 * 60 * 1000);

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

http.createServer(adminApp).listen(ADMIN_PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log(`  Admin:    http://${localIp}:${ADMIN_PORT}/admin`);
  console.log(`  (admin is LAN-only — not reachable via Cloudflare tunnel)\n`);
});
