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

// Auto-generate a stable vault access key on first run — required to view member list
const VAULT_KEY_FILE = path.join(DATA_DIR, 'vault-key.txt');
let VAULT_ACCESS_KEY;
try { VAULT_ACCESS_KEY = fs.readFileSync(VAULT_KEY_FILE, 'utf8').trim(); } catch {}
if (!VAULT_ACCESS_KEY) {
  VAULT_ACCESS_KEY = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(VAULT_KEY_FILE, VAULT_ACCESS_KEY);
}

module.exports = { DATA_DIR, STORAGE_DIR, BACKUP_DIR, VAULT_NAME, VAULT_ACCESS_KEY };
