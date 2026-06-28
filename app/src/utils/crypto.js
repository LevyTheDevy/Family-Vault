'use strict';

// AES-256-GCM: prefers @noble/ciphers/webcrypto (crypto.subtle, hardware) with
// automatic fallback to pure-JS aes if subtle is absent (Expo Go without dev build).
// PBKDF2-SHA256 via @noble/hashes — only runs at login, not on every image.

import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { gcm as _gcmWebCrypto } from '@noble/ciphers/webcrypto';
import { gcm as _gcmPureJS } from '@noble/ciphers/aes';
import * as ExpoCrypto from 'expo-crypto';
import QuickCrypto from 'react-native-quick-crypto';

const _hasSubtle = typeof globalThis !== 'undefined' && !!globalThis?.crypto?.subtle;
const _hasQC = typeof QuickCrypto?.createDecipheriv === 'function';
console.log('[FV] subtle?', _hasSubtle, 'qc?', _hasQC);
// await works on both variants: webcrypto returns Promise, pure-JS returns value (await no-ops on non-Promise)
const gcm = _hasSubtle ? _gcmWebCrypto : _gcmPureJS;

const getRandomBytes = (n) => ExpoCrypto.getRandomValues(new Uint8Array(n));

// ── Hex helpers — only for small data (salt, wrapped key, message payloads) ────
const _TO_HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const _FROM_HEX = new Uint8Array(256);
for (let i = 0; i < 10; i++) _FROM_HEX[48 + i] = i;
for (let i = 0; i < 6; i++) { _FROM_HEX[65 + i] = 10 + i; _FROM_HEX[97 + i] = 10 + i; }

const toHex = buf => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const out = new Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = _TO_HEX[b[i]];
  return out.join('');
};
const fromHex = s => {
  const len = s.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0, j = 0; j < len; i += 2, j++)
    out[j] = (_FROM_HEX[s.charCodeAt(i)] << 4) | _FROM_HEX[s.charCodeAt(i + 1)];
  return out;
};

// b64ToBytes: upload path only — reads gallery image as base64 string then converts to Uint8Array.
// charCodeAt loop is unavoidable here without a File.bytes() call on picker URIs.
// This is a cold path (upload, user-initiated) so the ~1s cost in debug is acceptable.
export const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// ── Core AES-256-GCM ────────────────────────────────────────────────────────────

async function aesgcmEncrypt(data, keyBytes) {
  const iv = getRandomBytes(12);
  const ct = await gcm(keyBytes, iv).encrypt(data instanceof Uint8Array ? data : new Uint8Array(data));
  return toHex(iv) + toHex(ct); // enc: text format — for messages/captions (small)
}

async function aesgcmDecrypt(encHex, keyBytes) {
  const iv = fromHex(encHex.slice(0, 24));
  const ct = fromHex(encHex.slice(24));
  return gcm(keyBytes, iv).decrypt(ct); // returns Uint8Array
}

// ── Key management ──────────────────────────────────────────────────────────────

// TODO: bump to 600 000 iterations (OWASP PBKDF2-SHA256 guidance).
// Requires storing `kdfIterations` alongside `kdfSalt` on the server so that
// existing keys (derived at 10 000) can still be unwrapped, then re-wrapped at
// the new count on next login. Don't change the default here without that migration.
async function deriveKey(passwordStr, saltHex, iterations = 10000) {
  const passBytes = new TextEncoder().encode(passwordStr);
  return pbkdf2Async(sha256, passBytes, fromHex(saltHex), { c: iterations, dkLen: 32 });
}

export async function wrapVaultKey(vaultKey, password) {
  const kdfSalt = toHex(getRandomBytes(32));
  const keyBytes = await deriveKey(password, kdfSalt);
  const wrappedVaultKey = await aesgcmEncrypt(vaultKey, keyBytes);
  return { kdfSalt, wrappedVaultKey };
}

export async function unwrapVaultKey(kdfSalt, wrappedVaultKey, password) {
  const keyBytes = await deriveKey(password, kdfSalt);
  return aesgcmDecrypt(wrappedVaultKey, keyBytes); // returns Promise<Uint8Array>
}

export async function unwrapInviteVaultKey(inviteKdfSalt, inviteWrappedVaultKey, rawTokenHex) {
  const keyBytes = await deriveKey(rawTokenHex, inviteKdfSalt, 1);
  return aesgcmDecrypt(inviteWrappedVaultKey, keyBytes);
}

// ── Text encryption (messages, captions) — enc: hex format, small payloads ─────

export async function encryptText(plaintext, vaultKeyBytes) {
  return aesgcmEncrypt(new TextEncoder().encode(plaintext), vaultKeyBytes);
}

export async function decryptText(encHex, vaultKeyBytes) {
  const plain = await aesgcmDecrypt(encHex, vaultKeyBytes);
  return new TextDecoder().decode(plain);
}

// ── Image encryption — raw binary, raw JPEG plaintext ──────────────────────────
//
// Format: [0x01 magic][iv 12B][ciphertext+tag]  (magic is 0x01; legacy text always starts 0x65)
//
// Plaintext is raw JPEG bytes — NOT base64(JPEG). This eliminates:
//   - 33% size overhead through AES on every decrypt
//   - TextEncoder on encrypt, TextDecoder on decrypt
//   - JS format-conversion loops on both paths
//
// Caller (CachedImage) writes the decrypted Uint8Array directly via expo-file-system File.write().
// No base64 string boundary anywhere in the hot path.

export async function encryptImageBin(jpegBytes, vaultKeyBytes) {
  // jpegBytes: Uint8Array of raw JPEG (from b64ToBytes on upload)
  const iv = getRandomBytes(12);
  const ct = await gcm(vaultKeyBytes, iv).encrypt(jpegBytes);
  const combined = new Uint8Array(1 + 12 + ct.length);
  combined[0] = 0x01;
  combined.set(iv, 1);
  combined.set(ct, 13);
  return combined;
}

function _qcGcmDecrypt(keyBytes, iv, ctPlusTag) {
  const ct = ctPlusTag.subarray(0, ctPlusTag.length - 16);
  const tag = ctPlusTag.subarray(ctPlusTag.length - 16);
  const decipher = QuickCrypto.createDecipheriv('aes-256-gcm', keyBytes, iv);
  decipher.setAuthTag(tag);
  const a = decipher.update(ct);
  const b = decipher.final();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function decryptImageBin(bytes, vaultKeyBytes) {
  const iv = bytes.subarray(1, 13);
  const ctPlusTag = bytes.subarray(13);
  if (_hasQC) return _qcGcmDecrypt(vaultKeyBytes, iv, ctPlusTag);
  return gcm(vaultKeyBytes, iv).decrypt(ctPlusTag);
}

// ── Legacy encb: format — for files uploaded before binary format ───────────────
// encb: stored base64(iv || ciphertext). Still needed for backward-compat decrypt.
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function decryptImageText(b64, vaultKeyBytes) {
  const combined = fromB64(b64);
  const plain = await gcm(vaultKeyBytes, combined.slice(0, 12)).decrypt(combined.slice(12));
  return new TextDecoder().decode(plain);
}

// Legacy hex binary — keep existing encrypted files readable
export async function encryptBinary(data, vaultKeyBytes) {
  return aesgcmEncrypt(data, vaultKeyBytes);
}
export async function decryptBinary(encHex, vaultKeyBytes) {
  return aesgcmDecrypt(encHex, vaultKeyBytes);
}
