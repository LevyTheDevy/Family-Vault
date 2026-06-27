'use strict';

// Pure-JS crypto — no Web Crypto API required (works in Hermes/Expo Go)
// PBKDF2-SHA256 via @noble/hashes, AES-256-GCM via @noble/ciphers
// Random bytes via tweetnacl (already installed, proven in RN)

import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { gcm } from '@noble/ciphers/aes';
import * as ExpoCrypto from 'expo-crypto';

const getRandomBytes = (n) => ExpoCrypto.getRandomValues(new Uint8Array(n));

const toHex = buf =>
  Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = s =>
  new Uint8Array(s.match(/.{2}/g).map(b => parseInt(b, 16)));

async function deriveKey(passwordStr, saltHex, iterations = 10000) {
  const passBytes = new TextEncoder().encode(passwordStr);
  const saltBytes = fromHex(saltHex);
  return pbkdf2Async(sha256, passBytes, saltBytes, { c: iterations, dkLen: 32 });
}

// Format: hex(iv[12]) + hex(ciphertext+tag) — matches server-side Node.js AES-GCM
function aesgcmEncrypt(data, keyBytes) {
  const iv = getRandomBytes(12);
  const ct = gcm(keyBytes, iv).encrypt(data instanceof Uint8Array ? data : new Uint8Array(data));
  return toHex(iv) + toHex(ct);
}

function aesgcmDecrypt(encHex, keyBytes) {
  const iv = fromHex(encHex.slice(0, 24));
  const ct = fromHex(encHex.slice(24));
  return gcm(keyBytes, iv).decrypt(ct);
}

// ── Key management ─────────────────────────────────────────────────────────────

export async function wrapVaultKey(vaultKey, password) {
  const kdfSalt = toHex(getRandomBytes(32));
  const keyBytes = await deriveKey(password, kdfSalt);
  const wrappedVaultKey = aesgcmEncrypt(vaultKey, keyBytes);
  return { kdfSalt, wrappedVaultKey };
}

export async function unwrapVaultKey(kdfSalt, wrappedVaultKey, password) {
  const keyBytes = await deriveKey(password, kdfSalt);
  return aesgcmDecrypt(wrappedVaultKey, keyBytes);
}

export async function unwrapInviteVaultKey(inviteKdfSalt, inviteWrappedVaultKey, rawTokenHex) {
  const keyBytes = await deriveKey(rawTokenHex, inviteKdfSalt, 1); // token has 256-bit entropy; iteration count irrelevant
  return aesgcmDecrypt(inviteWrappedVaultKey, keyBytes);
}

// ── Content encryption (Phase 2+) ──────────────────────────────────────────────

export async function encryptText(plaintext, vaultKeyBytes) {
  return aesgcmEncrypt(new TextEncoder().encode(plaintext), vaultKeyBytes);
}

export async function decryptText(encHex, vaultKeyBytes) {
  const plain = aesgcmDecrypt(encHex, vaultKeyBytes);
  return new TextDecoder().decode(plain);
}

export async function encryptBinary(data, vaultKeyBytes) {
  return aesgcmEncrypt(data, vaultKeyBytes);
}

export async function decryptBinary(encHex, vaultKeyBytes) {
  return aesgcmDecrypt(encHex, vaultKeyBytes);
}
