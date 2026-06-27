const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../data');

const STORAGE_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(__dirname, '../storage');

const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(__dirname, '../backups');

const VAULT_NAME = process.env.VAULT_NAME || 'Family Vault';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(path.join(STORAGE_DIR, 'avatars'), { recursive: true });

// Auto-generate stable secrets on first run and persist them to DATA_DIR.
// This means Docker users need zero config — no env vars required.

const VAULT_KEY_FILE = path.join(DATA_DIR, 'vault-key.txt');
let VAULT_ACCESS_KEY = process.env.VAULT_ACCESS_KEY;
if (!VAULT_ACCESS_KEY) {
  try { VAULT_ACCESS_KEY = fs.readFileSync(VAULT_KEY_FILE, 'utf8').trim(); } catch {}
  if (!VAULT_ACCESS_KEY) {
    VAULT_ACCESS_KEY = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(VAULT_KEY_FILE, VAULT_ACCESS_KEY);
  }
}

const JWT_KEY_FILE = path.join(DATA_DIR, 'jwt-secret.txt');
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  try { JWT_SECRET = fs.readFileSync(JWT_KEY_FILE, 'utf8').trim(); } catch {}
  if (!JWT_SECRET) {
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(JWT_KEY_FILE, JWT_SECRET);
  }
}

module.exports = { DATA_DIR, STORAGE_DIR, BACKUP_DIR, VAULT_NAME, VAULT_ACCESS_KEY, JWT_SECRET };
