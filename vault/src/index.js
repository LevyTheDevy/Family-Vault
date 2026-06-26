const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const https = require('https');

const { STORAGE_DIR, VAULT_NAME } = require('./config');
fs.mkdirSync(STORAGE_DIR, { recursive: true });

const authRoutes = require('./routes/auth');
const postsRoutes = require('./routes/posts');
const storiesRoutes = require('./routes/stories');
const collectionsRoutes = require('./routes/collections');
const messagesRoutes = require('./routes/messages');
const gifRoutes = require('./routes/gif');
const adminRoutes = require('./routes/admin');
const uploadsRoutes = require('./routes/uploads');
const db = require('./db/sqlite');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Protected file serving — require valid JWT to access uploaded media
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./routes/auth');
app.get('/storage/:filename', (req, res) => {
  try {
    jwt.verify((req.headers.authorization || req.query.token || '').replace('Bearer ', ''), JWT_SECRET);
  } catch { return res.status(401).end(); }
  const safeName = path.basename(req.params.filename);
  res.sendFile(path.join(STORAGE_DIR, safeName));
});

// Admin dashboard + API (before auth routes so /admin/* takes priority)
app.use(adminRoutes);

// App API routes
app.use(authRoutes);
app.use(postsRoutes);
app.use(storiesRoutes);
app.use(collectionsRoutes);
app.use(messagesRoutes);
app.use(gifRoutes);
app.use(uploadsRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', vaultName: VAULT_NAME }));

// Purge expired stories from DB and disk every hour
function purgeExpiredStories() {
  try {
    const files = db.purgeExpiredStories();
    for (const fn of files) {
      try { fs.unlinkSync(path.join(__dirname, '../storage', fn)); } catch {}
    }
    if (files.length) console.log(`[cleanup] removed ${files.length} expired story file(s)`);
  } catch {}
}
purgeExpiredStories();
setInterval(purgeExpiredStories, 60 * 60 * 1000);

// Root → admin dashboard
app.get('/', (req, res) => res.redirect('/admin'));

function getLocalIp() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const addr of iface)
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  return 'localhost';
}

// Try UPnP to automatically punch through the router
function tryUPnP(localIp) {
  try {
    const upnp = require('nat-upnp').createClient();
    upnp.portMapping({ public: PORT, private: PORT, ttl: 0, description: 'FamilyVault' }, (err) => {
      if (err) { console.log('  UPnP:     not available (manual port forward needed)'); return; }
      upnp.externalIp((err, extIp) => {
        if (err || !extIp) return;
        console.log(`  External: http://${extIp}:${PORT}`);
        console.log(`  Vault code prefix: ${extIp}:${PORT}`);
        // Renew UPnP mapping every 50 minutes (before 1hr TTL expires)
        setInterval(() => upnp.portMapping({ public: PORT, private: PORT, ttl: 3600, description: 'FamilyVault' }, () => {}), 50 * 60 * 1000);
      });
    });
  } catch {
    // nat-upnp not installed — skip silently
  }
}

app.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  const url = `http://${localIp}:${PORT}`;
  console.log(`\n  FamilyVault running`);
  console.log(`  Local:    ${url}`);
  console.log(`  Admin:    ${url}/admin`);
  tryUPnP(localIp);
  console.log('');
  const open = process.platform === 'win32' ? `start ${url}/admin`
    : process.platform === 'darwin' ? `open ${url}/admin`
    : `xdg-open ${url}/admin`;
  exec(open);
});
