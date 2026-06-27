'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const { DATA_DIR } = require('../config');
const DB_FILE = path.join(DATA_DIR, 'vault.db');
const LEGACY_JSON = path.join(DATA_DIR, 'db.json');

// ─── Password helpers (unchanged) ────────────────────────────────────────────
function hashPassword(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(p, salt, 100_000, 32, 'sha256').toString('hex');
  return `pbkdf2:${salt}:${hash}`;
}
function checkPassword(p, stored) {
  if (!stored || !stored.startsWith('pbkdf2:'))
    return stored === crypto.createHash('sha256').update(p + 'fv-salt').digest('hex');
  const [, salt, hash] = stored.split(':');
  return crypto.pbkdf2Sync(p, salt, 100_000, 32, 'sha256').toString('hex') === hash;
}
const generateCode = () => crypto.randomBytes(3).toString('hex').toUpperCase();

// ─── Open DB ─────────────────────────────────────────────────────────────────
const sql = new Database(DB_FILE);
sql.pragma('journal_mode = WAL');   // concurrent reads, crash-safe writes
sql.pragma('foreign_keys = ON');

// ─── Schema ──────────────────────────────────────────────────────────────────
sql.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS members (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash      TEXT NOT NULL,
    temp_password_hash TEXT,
    requires_reset     INTEGER NOT NULL DEFAULT 0,
    reset_requested    INTEGER NOT NULL DEFAULT 0,
    avatar_version     INTEGER,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS invite_links (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    code                    TEXT NOT NULL UNIQUE,
    label                   TEXT NOT NULL DEFAULT 'Invite',
    created_by              TEXT NOT NULL,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    used                    INTEGER NOT NULL DEFAULT 0,
    used_by                 TEXT,
    used_at                 TEXT,
    revoked                 INTEGER NOT NULL DEFAULT 0,
    invite_kdf_salt         TEXT,
    invite_wrapped_vault_key TEXT,
    expires_at              TEXT
  );
  CREATE TABLE IF NOT EXISTS user_crypto (
    member_id         INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    kdf_salt          TEXT NOT NULL,
    wrapped_vault_key TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vault_crypto (
    id                INTEGER PRIMARY KEY CHECK(id = 1),
    kdf_salt          TEXT NOT NULL,
    wrapped_vault_key TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    author             TEXT NOT NULL,
    caption            TEXT NOT NULL DEFAULT '',
    media_type         TEXT NOT NULL DEFAULT 'image',
    video_filename     TEXT,
    thumbnail_filename TEXT,
    duration_secs      REAL,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS post_images (
    post_id  INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (post_id, filename)
  );
  CREATE TABLE IF NOT EXISTS post_likes (
    post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    member_name TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (post_id, member_name)
  );
  CREATE TABLE IF NOT EXISTS post_saves (
    post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    member_name TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (post_id, member_name)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author      TEXT NOT NULL,
    text        TEXT,
    gif_url     TEXT,
    image_x     REAL,
    image_y     REAL,
    image_index INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stories (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    filename       TEXT NOT NULL,
    author         TEXT NOT NULL,
    caption        TEXT NOT NULL DEFAULT '',
    duration_hours REAL NOT NULL,
    expires_at     TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS story_views (
    story_id  INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer    TEXT NOT NULL COLLATE NOCASE,
    viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (story_id, viewer)
  );
  CREATE TABLE IF NOT EXISTS story_reactions (
    story_id   INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    author     TEXT NOT NULL COLLATE NOCASE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (story_id, author)
  );
  CREATE TABLE IF NOT EXISTS story_likes (
    story_id    INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    member_name TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (story_id, member_name)
  );
  CREATE TABLE IF NOT EXISTS collections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    author     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS collection_members (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    member_name   TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (collection_id, member_name)
  );
  CREATE TABLE IF NOT EXISTS collection_posts (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    post_id       INTEGER NOT NULL,
    added_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (collection_id, post_id)
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,
    is_dm      INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    member_name     TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (conversation_id, member_name)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author               TEXT NOT NULL,
    text                 TEXT,
    gif_url              TEXT,
    image_url            TEXT,
    video_url            TEXT,
    reply_to_id          INTEGER,
    reply_preview_author TEXT,
    reply_preview_text   TEXT,
    post_ref_id          INTEGER,
    post_ref_image_url   TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS message_reads (
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    member_name TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (message_id, member_name)
  );
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    member_name TEXT NOT NULL COLLATE NOCASE,
    emoji       TEXT NOT NULL,
    PRIMARY KEY (message_id, member_name)
  );
`);

// ─── One-time migration from legacy JSON ─────────────────────────────────────
function migrate() {
  if (!fs.existsSync(LEGACY_JSON)) return;
  if (sql.prepare("SELECT value FROM meta WHERE key = 'migrated'").get()) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8')); } catch { return; }

  sql.transaction(() => {
    if (data.inviteCode)
      sql.prepare("INSERT OR IGNORE INTO meta VALUES ('legacy_invite_code', ?)").run(data.inviteCode);

    for (const a of (data.admins || []))
      sql.prepare('INSERT OR IGNORE INTO admins (name, password_hash, created_at) VALUES (?,?,?)').run(
        a.name, a.passwordHash, a.createdAt || new Date().toISOString());

    for (const m of (data.members || []))
      sql.prepare('INSERT OR IGNORE INTO members (id,name,password_hash,temp_password_hash,requires_reset,reset_requested,avatar_version,created_at) VALUES (?,?,?,?,?,?,?,?)').run(
        m.id, m.name, m.passwordHash, m.tempPasswordHash || null,
        m.requiresReset ? 1 : 0, m.resetRequested ? 1 : 0,
        m.avatarVersion || null, m.createdAt || new Date().toISOString());

    for (const l of (data.inviteLinks || []))
      sql.prepare('INSERT OR IGNORE INTO invite_links (id,code,label,created_by,created_at,used,used_by,used_at,revoked) VALUES (?,?,?,?,?,?,?,?,?)').run(
        l.id, l.code, l.label || 'Invite', l.createdBy,
        l.createdAt || new Date().toISOString(),
        l.used ? 1 : 0, l.usedBy || null, l.usedAt || null, l.revoked ? 1 : 0);

    for (const p of (data.posts || [])) {
      const fns = p.filenames || (p.filename ? [p.filename] : []);
      sql.prepare('INSERT OR IGNORE INTO posts (id,author,caption,media_type,video_filename,thumbnail_filename,duration_secs,created_at) VALUES (?,?,?,?,?,?,?,?)').run(
        p.id, p.author, p.caption || '', p.mediaType || 'image',
        p.videoFilename || null, p.thumbnailFilename || null,
        p.durationSecs || null, p.createdAt || new Date().toISOString());
      fns.forEach((f, i) =>
        sql.prepare('INSERT OR IGNORE INTO post_images VALUES (?,?,?)').run(p.id, f, i));
      for (const n of (p.likes || []))
        sql.prepare('INSERT OR IGNORE INTO post_likes VALUES (?,?)').run(p.id, n);
      for (const n of (p.savedBy || []))
        sql.prepare('INSERT OR IGNORE INTO post_saves VALUES (?,?)').run(p.id, n);
      for (const c of (p.comments || []))
        sql.prepare('INSERT OR IGNORE INTO comments (id,post_id,author,text,gif_url,image_x,image_y,image_index,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
          c.id, p.id, c.author, c.text || null, c.gifUrl || null,
          c.imageX ?? null, c.imageY ?? null, c.imageIndex || 0,
          c.createdAt || new Date().toISOString());
    }

    for (const s of (data.stories || [])) {
      sql.prepare('INSERT OR IGNORE INTO stories (id,filename,author,caption,duration_hours,expires_at,created_at) VALUES (?,?,?,?,?,?,?)').run(
        s.id, s.filename, s.author, s.caption || '',
        s.durationHours, s.expiresAt, s.createdAt || new Date().toISOString());
      const views = (s.views || []).map(v => typeof v === 'string' ? { viewer: v, viewedAt: s.createdAt } : v);
      for (const v of views)
        sql.prepare('INSERT OR IGNORE INTO story_views VALUES (?,?,?)').run(s.id, v.viewer, v.viewedAt || new Date().toISOString());
      for (const r of (s.reactions || []))
        sql.prepare('INSERT OR IGNORE INTO story_reactions VALUES (?,?,?,?)').run(s.id, r.author, r.emoji, r.createdAt || new Date().toISOString());
      for (const n of (s.likes || []))
        sql.prepare('INSERT OR IGNORE INTO story_likes VALUES (?,?)').run(s.id, n);
    }

    for (const col of (data.collections || [])) {
      sql.prepare('INSERT OR IGNORE INTO collections (id,name,author,created_at) VALUES (?,?,?,?)').run(
        col.id, col.name, col.author, col.createdAt || new Date().toISOString());
      for (const n of (col.memberNames || [col.author]))
        sql.prepare('INSERT OR IGNORE INTO collection_members VALUES (?,?)').run(col.id, n);
      for (const pid of (col.postIds || []))
        sql.prepare('INSERT OR IGNORE INTO collection_posts (collection_id, post_id) VALUES (?,?)').run(col.id, pid);
    }

    for (const c of (data.conversations || [])) {
      sql.prepare('INSERT OR IGNORE INTO conversations (id,name,is_dm,created_by,created_at) VALUES (?,?,?,?,?)').run(
        c.id, c.name || null, c.isDM ? 1 : 0, c.createdBy, c.createdAt || new Date().toISOString());
      for (const n of (c.memberNames || []))
        sql.prepare('INSERT OR IGNORE INTO conversation_members VALUES (?,?)').run(c.id, n);
    }

    for (const m of (data.messages || [])) {
      const pr = m.postRef || null;
      sql.prepare('INSERT OR IGNORE INTO messages (id,conversation_id,author,text,gif_url,image_url,video_url,reply_to_id,reply_preview_author,reply_preview_text,post_ref_id,post_ref_image_url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        m.id, m.conversationId, m.author, m.text || null, m.gifUrl || null,
        m.imageUrl || null, m.videoUrl || null,
        m.replyToId || null, m.replyPreview?.author || null, m.replyPreview?.text || null,
        pr?.id || null, pr?.imageUrl || null, m.createdAt || new Date().toISOString());
      for (const n of (m.readBy || []))
        sql.prepare('INSERT OR IGNORE INTO message_reads VALUES (?,?)').run(m.id, n);
      for (const [emoji, names] of Object.entries(m.reactions || {}))
        for (const n of (names || []))
          sql.prepare('INSERT OR IGNORE INTO message_reactions VALUES (?,?,?)').run(m.id, n, emoji);
    }

    sql.prepare("INSERT INTO meta VALUES ('migrated','1')").run();
  })();

  console.log('[DB] Migrated legacy db.json → vault.db (SQLite)');
  fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.migrated');
}
migrate();

// Add crypto columns to existing invite_links tables (no-op if already present)
for (const colDef of [
  'invite_kdf_salt TEXT',
  'invite_wrapped_vault_key TEXT',
  'expires_at TEXT',
]) {
  try { sql.exec(`ALTER TABLE invite_links ADD COLUMN ${colDef}`); } catch {}
}

// ─── Row normalizers ─────────────────────────────────────────────────────────
function postExtras(postId) {
  return {
    filenames: sql.prepare('SELECT filename FROM post_images WHERE post_id = ? ORDER BY position').all(postId).map(r => r.filename),
    likes:     sql.prepare('SELECT member_name FROM post_likes WHERE post_id = ?').all(postId).map(r => r.member_name),
    savedBy:   sql.prepare('SELECT member_name FROM post_saves WHERE post_id = ?').all(postId).map(r => r.member_name),
    comments:  sql.prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY id').all(postId).map(normalizeComment),
  };
}

function normalizePost(row) {
  if (!row) return null;
  return {
    id: row.id, author: row.author, caption: row.caption,
    mediaType: row.media_type, videoFilename: row.video_filename,
    thumbnailFilename: row.thumbnail_filename, durationSecs: row.duration_secs,
    createdAt: row.created_at, ...postExtras(row.id),
  };
}

function normalizeComment(row) {
  return { id: row.id, author: row.author, text: row.text, gifUrl: row.gif_url,
    imageX: row.image_x, imageY: row.image_y, imageIndex: row.image_index, createdAt: row.created_at };
}

function normalizeStory(row) {
  if (!row) return null;
  return {
    id: row.id, filename: row.filename, author: row.author, caption: row.caption,
    durationHours: row.duration_hours, expiresAt: row.expires_at, createdAt: row.created_at,
    views:     sql.prepare('SELECT viewer, viewed_at FROM story_views WHERE story_id = ?').all(row.id).map(v => ({ viewer: v.viewer, viewedAt: v.viewed_at })),
    reactions: sql.prepare('SELECT author, emoji, created_at FROM story_reactions WHERE story_id = ?').all(row.id).map(r => ({ author: r.author, emoji: r.emoji, createdAt: r.created_at })),
    likes:     sql.prepare('SELECT member_name FROM story_likes WHERE story_id = ?').all(row.id).map(r => r.member_name),
  };
}

function normalizeMessage(row, requestingMember = null) {
  if (!row) return null;
  const readBy = sql.prepare('SELECT member_name FROM message_reads WHERE message_id = ?').all(row.id).map(r => r.member_name);
  const reactionRows = sql.prepare('SELECT member_name, emoji FROM message_reactions WHERE message_id = ?').all(row.id);
  const reactions = {};
  for (const r of reactionRows) { if (!reactions[r.emoji]) reactions[r.emoji] = []; reactions[r.emoji].push(r.member_name); }
  let postRef = row.post_ref_id ? { id: row.post_ref_id, imageUrl: row.post_ref_image_url } : null;
  if (postRef && requestingMember && !canAccessPost(requestingMember, postRef.id))
    postRef = { ...postRef, imageUrl: null, isRestricted: true };
  return {
    id: row.id, conversationId: row.conversation_id, author: row.author,
    text: row.text, gifUrl: row.gif_url, imageUrl: row.image_url, videoUrl: row.video_url,
    replyToId: row.reply_to_id,
    replyPreview: row.reply_preview_author ? { id: row.reply_to_id, author: row.reply_preview_author, text: row.reply_preview_text } : null,
    postRef, reactions, readBy, createdAt: row.created_at,
  };
}

function normalizeCollection(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, author: row.author, createdAt: row.created_at,
    memberNames: sql.prepare('SELECT member_name FROM collection_members WHERE collection_id = ?').all(row.id).map(r => r.member_name),
    postIds:     sql.prepare('SELECT post_id FROM collection_posts WHERE collection_id = ? ORDER BY added_at').all(row.id).map(r => r.post_id),
  };
}

function canAccessPost(memberName, postId) {
  const inCol = sql.prepare('SELECT 1 FROM collection_posts WHERE post_id = ?').get(postId);
  if (!inCol) return true;
  return !!sql.prepare(`SELECT 1 FROM collection_posts cp
    JOIN collection_members cm ON cp.collection_id = cm.collection_id
    WHERE cp.post_id = ? AND cm.member_name = ? COLLATE NOCASE`).get(postId, memberName);
}

// ─── Rename cascade helper ────────────────────────────────────────────────────
function cascadeRename(oldName, newName) {
  const tables = [
    ['posts', 'author'], ['comments', 'author'],
    ['post_likes', 'member_name'], ['post_saves', 'member_name'],
    ['stories', 'author'], ['story_views', 'viewer'],
    ['story_reactions', 'author'], ['story_likes', 'member_name'],
    ['collections', 'author'], ['collection_members', 'member_name'],
    ['conversations', 'created_by'], ['conversation_members', 'member_name'],
    ['messages', 'author'], ['message_reads', 'member_name'], ['message_reactions', 'member_name'],
  ];
  for (const [table, col] of tables)
    sql.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ? COLLATE NOCASE`).run(newName, oldName);
}

// ─── DB API ──────────────────────────────────────────────────────────────────
const db = {

  // ── Admin ──────────────────────────────────────────────────────────────────
  isSetupDone() { return sql.prepare('SELECT COUNT(*) AS n FROM admins').get().n > 0; },

  createAdmin(name, password) {
    if (sql.prepare('SELECT id FROM admins WHERE name = ? COLLATE NOCASE').get(name))
      throw new Error('Admin already exists');
    sql.prepare('INSERT INTO admins (name, password_hash) VALUES (?,?)').run(name, hashPassword(password));
  },

  verifyAdmin(name, password) {
    const a = sql.prepare('SELECT * FROM admins WHERE name = ? COLLATE NOCASE').get(name);
    if (!a || !checkPassword(password, a.password_hash)) return null;
    if (!a.password_hash.startsWith('pbkdf2:')) {
      sql.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(password), a.id);
    }
    return { name: a.name, createdAt: a.created_at };
  },

  listAdmins() {
    return sql.prepare('SELECT name, created_at FROM admins').all().map(a => ({ name: a.name, createdAt: a.created_at }));
  },

  // ── Invite links ───────────────────────────────────────────────────────────
  createInviteLink(label, createdBy) {
    const code = generateCode();
    const result = sql.prepare('INSERT INTO invite_links (code, label, created_by) VALUES (?,?,?)').run(code, label || 'Invite', createdBy);
    return sql.prepare('SELECT * FROM invite_links WHERE id = ?').get(result.lastInsertRowid);
  },

  listInviteLinks() {
    return sql.prepare('SELECT * FROM invite_links ORDER BY id DESC').all().map(l => ({
      id: l.id, code: l.code, label: l.label, createdBy: l.created_by, createdAt: l.created_at,
      used: !!l.used, usedBy: l.used_by, usedAt: l.used_at, revoked: !!l.revoked,
      expiresAt: l.expires_at || null, hasCrypto: !!(l.invite_kdf_salt),
    }));
  },

  getInviteLink(code) {
    const l = sql.prepare('SELECT * FROM invite_links WHERE code = ?').get(code.toUpperCase());
    if (!l) return null;
    return { id: l.id, code: l.code, label: l.label, createdBy: l.created_by, createdAt: l.created_at,
      used: !!l.used, usedBy: l.used_by, usedAt: l.used_at, revoked: !!l.revoked };
  },

  checkInviteCode(code) {
    const upper = code.toUpperCase();
    const link = sql.prepare('SELECT used, revoked FROM invite_links WHERE code = ?').get(upper);
    if (link) return !link.used && !link.revoked;
    const legacy = sql.prepare("SELECT value FROM meta WHERE key = 'legacy_invite_code'").get();
    return legacy?.value === upper;
  },

  markInviteLinkUsed(code, memberName) {
    sql.prepare("UPDATE invite_links SET used = 1, used_by = ?, used_at = datetime('now') WHERE code = ? AND used = 0")
      .run(memberName, code.toUpperCase());
  },

  revokeInviteLink(code) {
    const l = sql.prepare('SELECT * FROM invite_links WHERE code = ?').get(code.toUpperCase());
    if (!l) throw new Error('Invite not found');
    if (l.used) throw new Error('This invite has already been used');
    sql.prepare('UPDATE invite_links SET revoked = 1 WHERE code = ?').run(code.toUpperCase());
  },

  revokeInviteLinkById(id) {
    const l = sql.prepare('SELECT * FROM invite_links WHERE id = ?').get(id);
    if (!l) throw new Error('Invite not found');
    if (l.used) throw new Error('This invite has already been used');
    sql.prepare('UPDATE invite_links SET revoked = 1 WHERE id = ?').run(id);
  },

  // ── Members ────────────────────────────────────────────────────────────────
  getInviteCode() {
    return sql.prepare("SELECT value FROM meta WHERE key = 'legacy_invite_code'").get()?.value;
  },

  getMembers() {
    return sql.prepare('SELECT id, name, avatar_version FROM members ORDER BY name').all()
      .map(m => ({ id: m.id, name: m.name, avatarVersion: m.avatar_version || null }));
  },

  getMemberByName(name) {
    return sql.prepare('SELECT * FROM members WHERE name = ? COLLATE NOCASE').get(name) || null;
  },

  insertMember(name, password) {
    if (sql.prepare('SELECT id FROM members WHERE name = ? COLLATE NOCASE').get(name))
      throw new Error('Name already taken');
    const res = sql.prepare('INSERT INTO members (name, password_hash) VALUES (?,?)').run(name.trim(), hashPassword(password));
    return sql.prepare('SELECT * FROM members WHERE id = ?').get(res.lastInsertRowid);
  },

  verifyMember(name, password) {
    const m = sql.prepare('SELECT * FROM members WHERE name = ? COLLATE NOCASE').get(name);
    if (!m || !checkPassword(password, m.password_hash)) return null;
    if (!m.password_hash.startsWith('pbkdf2:'))
      sql.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(hashPassword(password), m.id);
    return m;
  },

  deleteMember(name) {
    const m = sql.prepare('SELECT id FROM members WHERE name = ? COLLATE NOCASE').get(name);
    if (!m) throw new Error('Member not found');
    sql.prepare('DELETE FROM members WHERE id = ?').run(m.id);
  },

  removeMemberWithContent(name) {
    const m = sql.prepare('SELECT * FROM members WHERE name = ? COLLATE NOCASE').get(name);
    if (!m) throw new Error('Member not found');
    const memberName = m.name;
    const storageFiles = [];

    sql.transaction(() => {
      // Collect files before deleting
      for (const p of sql.prepare('SELECT id, video_filename, thumbnail_filename FROM posts WHERE author = ?').all(memberName)) {
        sql.prepare('SELECT filename FROM post_images WHERE post_id = ?').all(p.id).forEach(r => storageFiles.push(r.filename));
        if (p.video_filename) storageFiles.push(p.video_filename);
        if (p.thumbnail_filename) storageFiles.push(p.thumbnail_filename);
      }
      sql.prepare('SELECT filename FROM stories WHERE author = ?').all(memberName).forEach(r => storageFiles.push(r.filename));

      // Delete owned content (cascades handle child rows)
      sql.prepare('DELETE FROM posts WHERE author = ?').run(memberName);
      sql.prepare('DELETE FROM stories WHERE author = ?').run(memberName);
      sql.prepare('DELETE FROM collections WHERE author = ?').run(memberName);

      // Delete DM conversations they're part of
      for (const c of sql.prepare(`SELECT c.id FROM conversations c JOIN conversation_members cm ON c.id = cm.conversation_id WHERE c.is_dm = 1 AND cm.member_name = ? COLLATE NOCASE`).all(memberName))
        sql.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);

      // Delete group chats they created
      for (const c of sql.prepare('SELECT id FROM conversations WHERE created_by = ? COLLATE NOCASE AND is_dm = 0').all(memberName))
        sql.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);

      // Remove from remaining conversations and clean up authored messages
      sql.prepare('DELETE FROM conversation_members WHERE member_name = ? COLLATE NOCASE').run(memberName);
      sql.prepare('DELETE FROM messages WHERE author = ? COLLATE NOCASE').run(memberName);

      // Remove cross-content references
      sql.prepare('DELETE FROM post_likes WHERE member_name = ? COLLATE NOCASE').run(memberName);
      sql.prepare('DELETE FROM post_saves WHERE member_name = ? COLLATE NOCASE').run(memberName);
      sql.prepare('DELETE FROM comments WHERE author = ? COLLATE NOCASE').run(memberName);
      sql.prepare('DELETE FROM collection_members WHERE member_name = ? COLLATE NOCASE').run(memberName);

      sql.prepare('DELETE FROM members WHERE id = ?').run(m.id);
    })();

    return { storageFiles, avatarName: memberName };
  },

  updateAvatarVersion(name) {
    const v = Date.now();
    sql.prepare('UPDATE members SET avatar_version = ? WHERE name = ? COLLATE NOCASE').run(v, name);
    return v;
  },

  updateMember(currentName, { newName, newPassword }) {
    const m = sql.prepare('SELECT * FROM members WHERE name = ? COLLATE NOCASE').get(currentName);
    if (!m) throw new Error('Member not found');

    sql.transaction(() => {
      if (newName && newName.trim() !== m.name) {
        const trimmed = newName.trim();
        if (sql.prepare('SELECT id FROM members WHERE name = ? COLLATE NOCASE AND id != ?').get(trimmed, m.id))
          throw new Error('That name is already taken');
        sql.prepare('UPDATE members SET name = ? WHERE id = ?').run(trimmed, m.id);
        cascadeRename(m.name, trimmed);
      }
      if (newPassword)
        sql.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), m.id);
    })();

    return sql.prepare('SELECT * FROM members WHERE id = ?').get(m.id);
  },

  loginMember(name, password) {
    const m = sql.prepare('SELECT * FROM members WHERE name = ? COLLATE NOCASE').get(name);
    if (!m) return null;

    if (checkPassword(password, m.password_hash)) {
      if (!m.password_hash.startsWith('pbkdf2:'))
        sql.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(hashPassword(password), m.id);
      return { ...m, requiresPasswordReset: !!m.requires_reset };
    }
    if (m.temp_password_hash && checkPassword(password, m.temp_password_hash)) {
      sql.prepare('UPDATE members SET temp_password_hash = NULL, requires_reset = 1, reset_requested = 0 WHERE id = ?').run(m.id);
      return { ...m, requiresPasswordReset: true };
    }
    return null;
  },

  requestPasswordReset(name) {
    const m = sql.prepare('SELECT id FROM members WHERE name = ? COLLATE NOCASE').get(name);
    if (!m) throw new Error('Member not found');
    sql.prepare('UPDATE members SET reset_requested = 1 WHERE id = ?').run(m.id);
  },

  setTempPassword(name, rawPassword) {
    const m = sql.prepare('SELECT id FROM members WHERE name = ? COLLATE NOCASE').get(name);
    if (!m) throw new Error('Member not found');
    sql.prepare('UPDATE members SET temp_password_hash = ?, reset_requested = 0 WHERE id = ?').run(hashPassword(rawPassword), m.id);
  },

  confirmPasswordReset(name, newPassword) {
    const m = sql.prepare('SELECT id FROM members WHERE name = ? COLLATE NOCASE').get(name);
    if (!m) throw new Error('Member not found');
    if (String(newPassword).length < 8) throw new Error('Password must be at least 8 characters');
    sql.prepare('UPDATE members SET password_hash = ?, temp_password_hash = NULL, requires_reset = 0 WHERE id = ?')
      .run(hashPassword(newPassword), m.id);
    return sql.prepare('SELECT * FROM members WHERE id = ?').get(m.id);
  },

  getMembersAdmin() {
    return sql.prepare('SELECT id, name, created_at, reset_requested, temp_password_hash FROM members').all().map(m => ({
      id: m.id, name: m.name, createdAt: m.created_at,
      resetRequested: !!m.reset_requested, hasTempPassword: !!m.temp_password_hash,
    }));
  },

  getResetRequests() {
    return sql.prepare('SELECT id, name, reset_requested, temp_password_hash FROM members WHERE reset_requested = 1 OR temp_password_hash IS NOT NULL').all().map(m => ({
      id: m.id, name: m.name, resetRequested: !!m.reset_requested, hasTempPassword: !!m.temp_password_hash,
    }));
  },

  // ── Posts ──────────────────────────────────────────────────────────────────
  getPosts(memberName, { limit = null, offset = 0 } = {}) {
    const visibilityFilter = memberName
      ? `AND (NOT EXISTS (SELECT 1 FROM collection_posts cp WHERE cp.post_id = p.id)
             OR EXISTS (SELECT 1 FROM collection_posts cp2
                        JOIN collection_members cm ON cp2.collection_id = cm.collection_id
                        WHERE cp2.post_id = p.id AND cm.member_name = ? COLLATE NOCASE))`
      : '';

    const countSql = `SELECT COUNT(*) AS n FROM posts p WHERE 1=1 ${visibilityFilter}`;
    const rowsSql  = `SELECT p.* FROM posts p WHERE 1=1 ${visibilityFilter} ORDER BY p.id DESC${limit != null ? ' LIMIT ? OFFSET ?' : ''}`;

    const params = memberName ? [memberName] : [];
    const total  = sql.prepare(countSql).get(...params).n;
    const limitParams = limit != null ? [...params, limit, offset] : params;
    const rows   = sql.prepare(rowsSql).all(...limitParams);

    return { posts: rows.map(normalizePost), total };
  },

  getPostById(id) {
    return normalizePost(sql.prepare('SELECT * FROM posts WHERE id = ?').get(id));
  },

  insertPost(filenames, author, caption, mediaType = 'image', videoFilename = null, thumbnailFilename = null, durationSecs = null) {
    const arr = Array.isArray(filenames) ? filenames : [filenames];
    const res = sql.prepare('INSERT INTO posts (author, caption, media_type, video_filename, thumbnail_filename, duration_secs) VALUES (?,?,?,?,?,?)').run(
      author, caption || '', mediaType, videoFilename || null, thumbnailFilename || null, durationSecs ?? null);
    const postId = res.lastInsertRowid;
    arr.forEach((f, i) => sql.prepare('INSERT INTO post_images VALUES (?,?,?)').run(postId, f, i));
    return normalizePost(sql.prepare('SELECT * FROM posts WHERE id = ?').get(postId));
  },

  deletePost(id, requestingMember) {
    const p = sql.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    if (!p) throw new Error('Post not found');
    if (p.author !== requestingMember) throw new Error('Not your post');
    const files = sql.prepare('SELECT filename FROM post_images WHERE post_id = ?').all(id).map(r => r.filename);
    if (p.video_filename) files.push(p.video_filename);
    if (p.thumbnail_filename) files.push(p.thumbnail_filename);
    sql.prepare('DELETE FROM posts WHERE id = ?').run(id);
    return files;
  },

  toggleLike(id, memberName) {
    if (!sql.prepare('SELECT id FROM posts WHERE id = ?').get(id)) throw new Error('Post not found');
    const existing = sql.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND member_name = ? COLLATE NOCASE').get(id, memberName);
    if (existing) sql.prepare('DELETE FROM post_likes WHERE post_id = ? AND member_name = ? COLLATE NOCASE').run(id, memberName);
    else sql.prepare('INSERT INTO post_likes VALUES (?,?)').run(id, memberName);
    return sql.prepare('SELECT member_name FROM post_likes WHERE post_id = ?').all(id).map(r => r.member_name);
  },

  addComment(postId, author, text, gifUrl = null, imageX = null, imageY = null, imageIndex = 0) {
    if (!sql.prepare('SELECT id FROM posts WHERE id = ?').get(postId)) throw new Error('Post not found');
    const res = sql.prepare('INSERT INTO comments (post_id, author, text, gif_url, image_x, image_y, image_index) VALUES (?,?,?,?,?,?,?)').run(
      postId, author, text, gifUrl || null, imageX ?? null, imageY ?? null, Number(imageIndex) || 0);
    return normalizeComment(sql.prepare('SELECT * FROM comments WHERE id = ?').get(res.lastInsertRowid));
  },

  deleteComment(postId, commentId, requestingMember) {
    const c = sql.prepare('SELECT * FROM comments WHERE id = ? AND post_id = ?').get(commentId, postId);
    if (!c) throw new Error('Comment not found');
    if (c.author !== requestingMember) throw new Error('Not your comment');
    sql.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
  },

  toggleSave(postId, memberName) {
    if (!sql.prepare('SELECT id FROM posts WHERE id = ?').get(postId)) throw new Error('Post not found');
    const existing = sql.prepare('SELECT 1 FROM post_saves WHERE post_id = ? AND member_name = ? COLLATE NOCASE').get(postId, memberName);
    if (existing) sql.prepare('DELETE FROM post_saves WHERE post_id = ? AND member_name = ? COLLATE NOCASE').run(postId, memberName);
    else sql.prepare('INSERT INTO post_saves VALUES (?,?)').run(postId, memberName);
    return sql.prepare('SELECT member_name FROM post_saves WHERE post_id = ?').all(postId).map(r => r.member_name);
  },

  // ── Stories ────────────────────────────────────────────────────────────────
  insertStory(filename, author, durationHours, caption = '') {
    const expiresAt = new Date(Date.now() + durationHours * 3_600_000).toISOString();
    const res = sql.prepare('INSERT INTO stories (filename, author, caption, duration_hours, expires_at) VALUES (?,?,?,?,?)').run(
      filename, author, caption || '', durationHours, expiresAt);
    return normalizeStory(sql.prepare('SELECT * FROM stories WHERE id = ?').get(res.lastInsertRowid));
  },

  getActiveStories() {
    return sql.prepare("SELECT * FROM stories WHERE expires_at > datetime('now')").all().map(normalizeStory);
  },

  deleteStory(id, requestingMember) {
    const s = sql.prepare('SELECT * FROM stories WHERE id = ?').get(id);
    if (!s) throw new Error('Story not found');
    if (s.author !== requestingMember) throw new Error('Not your story');
    sql.prepare('DELETE FROM stories WHERE id = ?').run(id);
    return s.filename;
  },

  purgeExpiredStories() {
    const expired = sql.prepare("SELECT filename FROM stories WHERE expires_at <= datetime('now')").all().map(r => r.filename);
    if (expired.length) sql.prepare("DELETE FROM stories WHERE expires_at <= datetime('now')").run();
    return expired;
  },

  recordStoryView(storyId, memberName) {
    sql.prepare('INSERT OR IGNORE INTO story_views (story_id, viewer) VALUES (?,?)').run(storyId, memberName);
    return sql.prepare('SELECT viewer, viewed_at FROM story_views WHERE story_id = ?').all(storyId)
      .map(v => ({ viewer: v.viewer, viewedAt: v.viewed_at }));
  },

  toggleStoryReaction(storyId, memberName, emoji) {
    if (!sql.prepare('SELECT id FROM stories WHERE id = ?').get(storyId)) throw new Error('Story not found');
    const existing = sql.prepare('SELECT emoji FROM story_reactions WHERE story_id = ? AND author = ? COLLATE NOCASE').get(storyId, memberName);
    if (existing) {
      if (existing.emoji === emoji) sql.prepare('DELETE FROM story_reactions WHERE story_id = ? AND author = ? COLLATE NOCASE').run(storyId, memberName);
      else sql.prepare("UPDATE story_reactions SET emoji = ?, created_at = datetime('now') WHERE story_id = ? AND author = ? COLLATE NOCASE").run(emoji, storyId, memberName);
    } else {
      sql.prepare('INSERT INTO story_reactions (story_id, author, emoji) VALUES (?,?,?)').run(storyId, memberName, emoji);
    }
    return sql.prepare('SELECT author, emoji, created_at FROM story_reactions WHERE story_id = ?').all(storyId)
      .map(r => ({ author: r.author, emoji: r.emoji, createdAt: r.created_at }));
  },

  getStoryViewers(storyId, requestingMember) {
    const s = sql.prepare('SELECT author FROM stories WHERE id = ?').get(storyId);
    if (!s) throw new Error('Story not found');
    if (s.author !== requestingMember) throw new Error('Only the story author can see viewers');
    return {
      views:     sql.prepare('SELECT viewer, viewed_at FROM story_views WHERE story_id = ?').all(storyId).map(v => ({ viewer: v.viewer, viewedAt: v.viewed_at })),
      reactions: sql.prepare('SELECT author, emoji, created_at FROM story_reactions WHERE story_id = ?').all(storyId).map(r => ({ author: r.author, emoji: r.emoji, createdAt: r.created_at })),
    };
  },

  toggleStoryLike(storyId, memberName) {
    if (!sql.prepare('SELECT id FROM stories WHERE id = ?').get(storyId)) throw new Error('Story not found');
    const existing = sql.prepare('SELECT 1 FROM story_likes WHERE story_id = ? AND member_name = ? COLLATE NOCASE').get(storyId, memberName);
    if (existing) sql.prepare('DELETE FROM story_likes WHERE story_id = ? AND member_name = ? COLLATE NOCASE').run(storyId, memberName);
    else sql.prepare('INSERT INTO story_likes VALUES (?,?)').run(storyId, memberName);
    return sql.prepare('SELECT member_name FROM story_likes WHERE story_id = ?').all(storyId).map(r => r.member_name);
  },

  // ── Collections ────────────────────────────────────────────────────────────
  getCollections(memberName) {
    const rows = sql.prepare(`SELECT DISTINCT c.* FROM collections c
      JOIN collection_members cm ON c.id = cm.collection_id
      WHERE c.author = ? COLLATE NOCASE OR cm.member_name = ? COLLATE NOCASE
      ORDER BY c.id`).all(memberName, memberName);
    return rows.map(normalizeCollection);
  },

  insertCollection(name, author) {
    const res = sql.prepare('INSERT INTO collections (name, author) VALUES (?,?)').run(name, author);
    sql.prepare('INSERT INTO collection_members VALUES (?,?)').run(res.lastInsertRowid, author);
    return normalizeCollection(sql.prepare('SELECT * FROM collections WHERE id = ?').get(res.lastInsertRowid));
  },

  deleteCollection(id, requestingMember) {
    const col = sql.prepare('SELECT * FROM collections WHERE id = ?').get(id);
    if (!col) throw new Error('Collection not found');
    if (col.author !== requestingMember) throw new Error('Not your collection');
    sql.prepare('DELETE FROM collections WHERE id = ?').run(id);
  },

  addCollectionMember(colId, memberName, requestingMember) {
    const col = sql.prepare('SELECT * FROM collections WHERE id = ?').get(colId);
    if (!col) throw new Error('Collection not found');
    if (col.author !== requestingMember) throw new Error('Only the creator can add members');
    sql.prepare('INSERT OR IGNORE INTO collection_members VALUES (?,?)').run(colId, memberName);
    return normalizeCollection(col);
  },

  removeCollectionMember(colId, memberName, requestingMember) {
    const col = sql.prepare('SELECT * FROM collections WHERE id = ?').get(colId);
    if (!col) throw new Error('Collection not found');
    if (col.author !== requestingMember) throw new Error('Only the creator can remove members');
    if (memberName === col.author) throw new Error('Creator cannot be removed');
    sql.prepare('DELETE FROM collection_members WHERE collection_id = ? AND member_name = ? COLLATE NOCASE').run(colId, memberName);
    return normalizeCollection(col);
  },

  addToCollection(colId, postId, requestingMember) {
    const col = sql.prepare('SELECT * FROM collections WHERE id = ?').get(colId);
    if (!col) throw new Error('Collection not found');
    if (requestingMember) {
      const post = sql.prepare('SELECT author FROM posts WHERE id = ?').get(postId);
      if (!post) throw new Error('Post not found');
      if (post.author !== requestingMember) throw new Error('Only the post owner can add it to a collection');
      const isMember = sql.prepare('SELECT 1 FROM collection_members WHERE collection_id = ? AND member_name = ? COLLATE NOCASE').get(colId, requestingMember);
      if (!isMember) throw new Error('You are not a member of this collection');
    }
    sql.prepare('INSERT OR IGNORE INTO collection_posts (collection_id, post_id) VALUES (?,?)').run(colId, postId);
    return normalizeCollection(col);
  },

  removeFromCollection(colId, postId) {
    sql.prepare('DELETE FROM collection_posts WHERE collection_id = ? AND post_id = ?').run(colId, postId);
  },

  getCollectionPosts(colId, memberName) {
    const col = sql.prepare('SELECT * FROM collections WHERE id = ?').get(colId);
    if (!col) throw new Error('Collection not found');
    const members = sql.prepare('SELECT member_name FROM collection_members WHERE collection_id = ?').all(colId).map(r => r.member_name);
    if (memberName && col.author !== memberName && !members.some(n => n.toLowerCase() === memberName.toLowerCase()))
      throw new Error('You do not have access to this collection');
    const rows = sql.prepare(`SELECT p.* FROM posts p JOIN collection_posts cp ON p.id = cp.post_id WHERE cp.collection_id = ? ORDER BY cp.added_at`).all(colId);
    return rows.map(normalizePost);
  },

  // ── Conversations ──────────────────────────────────────────────────────────
  findOrCreateDM(memberA, memberB) {
    const existing = sql.prepare(`SELECT c.id FROM conversations c
      JOIN conversation_members a ON c.id = a.conversation_id AND a.member_name = ? COLLATE NOCASE
      JOIN conversation_members b ON c.id = b.conversation_id AND b.member_name = ? COLLATE NOCASE
      WHERE c.is_dm = 1`).get(memberA, memberB);
    if (existing) return sql.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.id);
    const res = sql.prepare('INSERT INTO conversations (name, is_dm, created_by) VALUES (NULL, 1, ?)').run(memberA);
    const id = res.lastInsertRowid;
    sql.prepare('INSERT INTO conversation_members VALUES (?,?)').run(id, memberA);
    sql.prepare('INSERT INTO conversation_members VALUES (?,?)').run(id, memberB);
    return sql.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  },

  getConversations(memberName = null) {
    const rows = memberName
      ? sql.prepare(`SELECT c.* FROM conversations c JOIN conversation_members cm ON c.id = cm.conversation_id WHERE cm.member_name = ? COLLATE NOCASE`).all(memberName)
      : sql.prepare('SELECT * FROM conversations').all();

    return rows.map(c => {
      const memberNames = sql.prepare('SELECT member_name FROM conversation_members WHERE conversation_id = ?').all(c.id).map(r => r.member_name);
      const last = sql.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
      const msgCount = sql.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(c.id).n;
      const unread = memberName
        ? sql.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.conversation_id = ? AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.member_name = ? COLLATE NOCASE)`).get(c.id, memberName).n
        : 0;
      return {
        id: c.id, name: c.name, isDM: !!c.is_dm, createdBy: c.created_by, createdAt: c.created_at,
        memberNames, lastMessage: last ? normalizeMessage(last) : null, messageCount: msgCount, unreadCount: unread,
      };
    }).sort((a, b) => {
      const ta = a.lastMessage?.createdAt || a.createdAt;
      const tb = b.lastMessage?.createdAt || b.createdAt;
      return new Date(tb) - new Date(ta);
    });
  },

  insertConversation(name, memberNames, createdBy) {
    const res = sql.prepare('INSERT INTO conversations (name, is_dm, created_by) VALUES (?,0,?)').run(name, createdBy);
    const id = res.lastInsertRowid;
    for (const n of memberNames) sql.prepare('INSERT OR IGNORE INTO conversation_members VALUES (?,?)').run(id, n);
    return sql.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  },

  addConversationMember(conversationId, memberName, requestingMember) {
    const c = sql.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!c) throw new Error('Conversation not found');
    if (c.is_dm) throw new Error('Cannot add members to a DM');
    if (c.created_by !== requestingMember) throw new Error('Only the creator can add members');
    sql.prepare('INSERT OR IGNORE INTO conversation_members VALUES (?,?)').run(conversationId, memberName);
    return c;
  },

  removeConversationMember(conversationId, memberName, requestingMember) {
    const c = sql.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!c) throw new Error('Conversation not found');
    if (c.is_dm) throw new Error('Cannot remove members from a DM');
    if (c.created_by !== requestingMember && requestingMember !== memberName) throw new Error('Only the creator can remove others');
    sql.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND member_name = ? COLLATE NOCASE').run(conversationId, memberName);
    return c;
  },

  deleteConversation(id, requestingMember) {
    const c = sql.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!c) throw new Error('Conversation not found');
    const isMember = sql.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND member_name = ? COLLATE NOCASE').get(id, requestingMember);
    if (!isMember) throw new Error('You cannot delete this conversation');
    if (!c.is_dm && c.created_by !== requestingMember) throw new Error('Only the creator can delete a group chat');
    sql.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  },

  // ── Messages ───────────────────────────────────────────────────────────────
  getMessages(conversationId, requestingMember) {
    const c = sql.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!c) throw new Error('Conversation not found');
    if (requestingMember) {
      const isMember = sql.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND member_name = ? COLLATE NOCASE').get(conversationId, requestingMember);
      if (!isMember) throw new Error('Not a member of this conversation');
    }
    return sql.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 200').all(conversationId)
      .reverse()
      .map(m => normalizeMessage(m, requestingMember));
  },

  insertMessage(conversationId, author, text, gifUrl = null, imageUrl = null, videoUrl = null, replyToId = null, postRef = null) {
    const c = sql.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!c) throw new Error('Conversation not found');
    if (!(sql.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND member_name = ? COLLATE NOCASE').get(conversationId, author)))
      throw new Error('Not a member of this conversation');

    let replyPreviewAuthor = null, replyPreviewText = null;
    if (replyToId) {
      const ref = sql.prepare('SELECT author, text FROM messages WHERE id = ?').get(Number(replyToId));
      if (ref) { replyPreviewAuthor = ref.author; replyPreviewText = ref.text; }
    }
    const res = sql.prepare('INSERT INTO messages (conversation_id, author, text, gif_url, image_url, video_url, reply_to_id, reply_preview_author, reply_preview_text, post_ref_id, post_ref_image_url) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      conversationId, author, text || null, gifUrl || null, imageUrl || null, videoUrl || null,
      replyToId ? Number(replyToId) : null, replyPreviewAuthor, replyPreviewText,
      postRef?.id || null, postRef?.imageUrl || null);
    sql.prepare('INSERT OR IGNORE INTO message_reads VALUES (?,?)').run(res.lastInsertRowid, author);
    return normalizeMessage(sql.prepare('SELECT * FROM messages WHERE id = ?').get(res.lastInsertRowid));
  },

  reactToMessage(messageId, memberName, emoji) {
    const m = sql.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(messageId);
    if (!m) throw new Error('Message not found');
    if (!(sql.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND member_name = ? COLLATE NOCASE').get(m.conversation_id, memberName)))
      throw new Error('Not a member of this conversation');
    const existing = sql.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND member_name = ? COLLATE NOCASE').get(messageId, memberName);
    if (existing) {
      if (existing.emoji === emoji) sql.prepare('DELETE FROM message_reactions WHERE message_id = ? AND member_name = ? COLLATE NOCASE').run(messageId, memberName);
      else sql.prepare('UPDATE message_reactions SET emoji = ? WHERE message_id = ? AND member_name = ? COLLATE NOCASE').run(emoji, messageId, memberName);
    } else {
      sql.prepare('INSERT INTO message_reactions VALUES (?,?,?)').run(messageId, memberName, emoji);
    }
    return normalizeMessage(sql.prepare('SELECT * FROM messages WHERE id = ?').get(messageId));
  },

  markMessagesRead(conversationId, memberName) {
    const unread = sql.prepare(`SELECT m.id FROM messages m WHERE m.conversation_id = ? AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.member_name = ? COLLATE NOCASE)`).all(conversationId, memberName);
    const insert = sql.prepare('INSERT OR IGNORE INTO message_reads VALUES (?,?)');
    sql.transaction(() => { for (const m of unread) insert.run(m.id, memberName); })();
  },

  deleteMessage(messageId, requestingMember) {
    const m = sql.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!m) throw new Error('Message not found');
    if (m.author !== requestingMember) throw new Error('Not your message');
    sql.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
  },

  // ── Stats ──────────────────────────────────────────────────────────────────
  getStats() {
    return {
      memberCount:      sql.prepare('SELECT COUNT(*) AS n FROM members').get().n,
      postCount:        sql.prepare('SELECT COUNT(*) AS n FROM posts').get().n,
      activeStoryCount: sql.prepare("SELECT COUNT(*) AS n FROM stories WHERE expires_at > datetime('now')").get().n,
      messageCount:     sql.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    };
  },

  // ── E2E Crypto ────────────────────────────────────────────────────────────

  getUserCrypto(memberId) {
    const row = sql.prepare('SELECT kdf_salt, wrapped_vault_key FROM user_crypto WHERE member_id = ?').get(memberId);
    return row ? { kdfSalt: row.kdf_salt, wrappedVaultKey: row.wrapped_vault_key } : null;
  },

  setUserCrypto(memberId, kdfSalt, wrappedVaultKey) {
    sql.prepare('INSERT OR REPLACE INTO user_crypto (member_id, kdf_salt, wrapped_vault_key) VALUES (?,?,?)')
      .run(memberId, kdfSalt, wrappedVaultKey);
  },

  getVaultCrypto() {
    const row = sql.prepare('SELECT kdf_salt, wrapped_vault_key FROM vault_crypto WHERE id = 1').get();
    return row ? { kdfSalt: row.kdf_salt, wrappedVaultKey: row.wrapped_vault_key } : null;
  },

  setVaultCrypto(kdfSalt, wrappedVaultKey) {
    sql.prepare('INSERT OR REPLACE INTO vault_crypto (id, kdf_salt, wrapped_vault_key) VALUES (1,?,?)')
      .run(kdfSalt, wrappedVaultKey);
  },

  // Creates an E2E invite — code is SHA-256(raw_token) stored as hex
  createCryptoInvite(label, createdBy, tokenHash, inviteKdfSalt, inviteWrappedVaultKey, expiresAt) {
    const result = sql.prepare(
      `INSERT INTO invite_links
         (code, label, created_by, invite_kdf_salt, invite_wrapped_vault_key, expires_at)
       VALUES (?,?,?,?,?,?)`
    ).run(tokenHash, label || 'Invite', createdBy, inviteKdfSalt, inviteWrappedVaultKey, expiresAt);
    return sql.prepare('SELECT * FROM invite_links WHERE id = ?').get(result.lastInsertRowid);
  },

  // Look up a crypto invite by the SHA-256 hash of the raw token
  getInviteByTokenHash(tokenHash) {
    const row = sql.prepare(
      'SELECT * FROM invite_links WHERE code = ? AND used = 0 AND revoked = 0'
    ).get(tokenHash);
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
    return {
      id: row.id, label: row.label, code: row.code,
      inviteKdfSalt: row.invite_kdf_salt,
      inviteWrappedVaultKey: row.invite_wrapped_vault_key,
      expiresAt: row.expires_at,
    };
  },

  // ── Backup/restore helpers ─────────────────────────────────────────────────
  // Creates a consistent WAL-checkpointed snapshot at destPath (returns Promise)
  backup(destPath) { return sql.backup(destPath); },

  // Closes the DB connection — call before replacing the file for restore
  close() { sql.close(); },
};

module.exports = db;
