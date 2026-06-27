'use strict';
/**
 * E2E crypto — PBKDF2-SHA256 (600k iters) + AES-256-GCM via Web Crypto API.
 * Available in Expo SDK 54+ (Hermes exposes global.crypto.subtle).
 * Matches the algorithm used in the admin panel browser.
 *
 * Encoding: all binary stored/transmitted as lowercase hex strings.
 * Wrapped vault key format: hex(iv[12]) + hex(ciphertext+tag[48]) = 120 hex chars
 */

const toHex = buf =>
  Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = s =>
  new Uint8Array(s.match(/.{2}/g).map(b => parseInt(b, 16)));

async function pbkdf2Key(passwordStr, saltHex) {
  const km = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passwordStr), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: 600000, hash: 'SHA-256' },
    km,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function gcmEncrypt(data, aesKey) {
  const raw = await crypto.subtle.exportKey('raw', aesKey);
  const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, data);
  return toHex(iv) + toHex(ct);
}

async function gcmDecrypt(encHex, aesKey) {
  const raw = await crypto.subtle.exportKey('raw', aesKey);
  const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  const iv = fromHex(encHex.slice(0, 24));
  const ct = fromHex(encHex.slice(24));
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct));
}

// ── Key management ────────────────────────────────────────────────────────────

/** Wrap vault key with a user password. Returns { kdfSalt, wrappedVaultKey } for storage. */
export async function wrapVaultKey(vaultKey, password) {
  const kdfSalt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const aesKey = await pbkdf2Key(password, kdfSalt);
  const wrappedVaultKey = await gcmEncrypt(vaultKey, aesKey);
  return { kdfSalt, wrappedVaultKey };
}

/** Unwrap vault key from storage using the user's password. Returns Uint8Array(32). */
export async function unwrapVaultKey(kdfSalt, wrappedVaultKey, password) {
  const aesKey = await pbkdf2Key(password, kdfSalt);
  return gcmDecrypt(wrappedVaultKey, aesKey);
}

/**
 * Unwrap vault key from an invite link.
 * rawTokenHex: the 64-char hex token from the invite URL (/invite/<token>)
 */
export async function unwrapInviteVaultKey(inviteKdfSalt, inviteWrappedVaultKey, rawTokenHex) {
  const aesKey = await pbkdf2Key(rawTokenHex, inviteKdfSalt);
  return gcmDecrypt(inviteWrappedVaultKey, aesKey);
}

// ── Content encryption (Phase 2+) ─────────────────────────────────────────────

/** Encrypt a UTF-8 string with the vault key. Returns hex string. */
export async function encryptText(plaintext, vaultKeyBytes) {
  const k = await crypto.subtle.importKey('raw', vaultKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plaintext));
  return toHex(iv) + toHex(ct);
}

/** Decrypt a hex string produced by encryptText. Returns UTF-8 string. */
export async function decryptText(encHex, vaultKeyBytes) {
  const k = await crypto.subtle.importKey('raw', vaultKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const iv = fromHex(encHex.slice(0, 24));
  const ct = fromHex(encHex.slice(24));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct);
  return new TextDecoder().decode(plain);
}

/** Encrypt binary data with the vault key. Returns hex string. */
export async function encryptBinary(data, vaultKeyBytes) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const k = await crypto.subtle.importKey('raw', vaultKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, bytes);
  return toHex(iv) + toHex(ct);
}

/** Decrypt a hex string produced by encryptBinary. Returns Uint8Array. */
export async function decryptBinary(encHex, vaultKeyBytes) {
  const k = await crypto.subtle.importKey('raw', vaultKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const iv = fromHex(encHex.slice(0, 24));
  const ct = fromHex(encHex.slice(24));
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct));
}
