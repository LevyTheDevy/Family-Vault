import React, { useState, useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import { File as FSFile } from 'expo-file-system';
import { getDecryptFn, getDecryptImgFn, getDecryptImgBinFn } from '../utils/api';
import { useVault } from '../context/VaultContext';

const CONTENT_FIT = { cover: 'cover', contain: 'contain', stretch: 'fill', center: 'scale-down' };
const ENC_CACHE_DIR = FileSystem.cacheDirectory + 'fv-enc/';

// Module-level maps survive component remounts (FlatList virtualization, tab switches)
const _inflight = new Map(); // cacheFile → Promise  (prevents double-decrypt of same file)
const _memCache = new Map(); // filename  → local path (avoids disk I/O after first decrypt)

// Wipe all decrypted media — called on vault switch/disconnect so one vault's
// plaintext images never survive into another vault's session.
export async function clearDecryptedCache() {
  _memCache.clear();
  await FileSystem.deleteAsync(ENC_CACHE_DIR, { idempotent: true }).catch(() => {});
}

// Evict oldest decrypted files until the cache fits the cap. Runs at app start,
// before any image renders, so _memCache never holds paths to pruned files.
export async function pruneDecryptedCache(maxBytes = 500 * 1024 * 1024) {
  try {
    const names = await FileSystem.readDirectoryAsync(ENC_CACHE_DIR).catch(() => []);
    if (!names.length) return;
    const files = [];
    for (const n of names) {
      const info = await FileSystem.getInfoAsync(ENC_CACHE_DIR + n, { size: true }).catch(() => null);
      if (info?.exists) files.push({ path: ENC_CACHE_DIR + n, size: info.size || 0, mtime: info.modificationTime || 0 });
    }
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= maxBytes) return;
    files.sort((a, b) => a.mtime - b.mtime);
    for (const f of files) {
      if (total <= maxBytes) break;
      await FileSystem.deleteAsync(f.path, { idempotent: true }).catch(() => {});
      total -= f.size;
    }
  } catch {}
}

// Resolve a /storage/ URL to a decrypted local file, decrypting on demand.
// Used by the offline-save pipeline. Returns null for non-encrypted URLs
// (caller downloads those directly).
export async function getDecryptedLocalPath(uri) {
  if (!uri || !isEncrypted(uri)) return null;
  try {
    const p = await decryptAndCache(uri);
    return p && p !== uri ? p : null;
  } catch { return null; }
}

function getCachedUri(uri) {
  if (!uri || !isEncrypted(uri)) return null;
  const filename = uri.match(/\/storage\/([^?#]+)/)?.[1];
  return filename ? (_memCache.get(filename) ?? null) : null;
}

function cacheKey(uri) {
  if (!uri) return undefined;
  const storage = uri.match(/\/storage\/([^?#]+)/);
  if (storage) return storage[1];
  const avatar = uri.match(/\/members\/([^/]+)\/avatar(?:.*[?&]v=(\d+))?/);
  if (avatar) return `avatar_${decodeURIComponent(avatar[1])}_${avatar[2] || '0'}`;
  return undefined;
}

function isEncrypted(uri) {
  const filename = uri?.match(/\/storage\/([^?#]+)/)?.[1];
  return !!(filename && filename.endsWith('.enc'));
}

// A write killed mid-flight (e.g. by an OOM kill — the exact failure that
// produces gray images) leaves a truncated JPEG on disk. Without this check the
// disk-hit path below would treat that stub as valid and serve it forever.
// We verify the SOI (FF D8) and EOI (FF D9) markers via a FileHandle so only
// 4 bytes are read, regardless of image size. Any error → treat as corrupt.
function isIntactJpegFile(path) {
  let handle;
  try {
    const file = new FSFile(path);
    const size = file.size;
    if (!size || size < 4) return false;
    handle = file.open();
    const head = handle.readBytes(2);
    handle.offset = size - 2;
    const tail = handle.readBytes(2);
    return head[0] === 0xFF && head[1] === 0xD8 && tail[0] === 0xFF && tail[1] === 0xD9;
  } catch {
    return false;
  } finally {
    try { handle?.close(); } catch {}
  }
}

async function decryptAndCache(uri) {
  const filename = uri.match(/\/storage\/([^?#]+)/)?.[1];
  if (!filename) return null;
  const cacheFile = ENC_CACHE_DIR + filename.replace(/\.enc$/, '.jpg');

  // In-memory hit — instant, no disk I/O
  if (_memCache.has(filename)) return _memCache.get(filename);

  // Disk hit — file already decrypted by a previous session.
  // For the re-encoded JPEG variants (feed/thumb — the ones in the gray-image
  // bug) validate integrity before trusting the file: a truncated file from a
  // prior interrupted write self-heals here (deleted + re-decrypted below)
  // instead of being cached as a permanent gray image. Full-res keeps the
  // original (possibly PNG/HEIC) bytes, so we can't assert JPEG markers there.
  const isJpegVariant = /_feed\.jpg$|_thumb\.jpg$/.test(cacheFile);
  try {
    const info = await FileSystem.getInfoAsync(cacheFile);
    if (info.exists) {
      if (!isJpegVariant || isIntactJpegFile(cacheFile)) { _memCache.set(filename, cacheFile); return cacheFile; }
      await FileSystem.deleteAsync(cacheFile, { idempotent: true });
    }
  } catch {}

  // Dedup — return the existing promise if a decrypt is already running for this file
  if (_inflight.has(cacheFile)) return _inflight.get(cacheFile);

  if (!getDecryptFn() && !getDecryptImgBinFn()) return null;

  const promise = (async () => {
    const t0 = performance.now();
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // arrayBuffer() returns raw bytes with zero JS processing — no charCodeAt/fromHex loops
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const t1 = performance.now();

    // Format detection is deterministic, not probabilistic:
    // 0x01 → new binary format [magic(1)][iv(12)][ct+tag]
    // 0x65 ('e') → legacy text: enc: (hex) or encb: (base64) — both start with ASCII 'e'
    // These can never collide: we control the 0x01 magic; legacy text is always 0x65.
    let jpegBytes = null; // Uint8Array — for new binary path
    let base64 = null;    // string — for legacy text paths

    if (bytes[0] === 0x01 || bytes[0] === 0x02) {
      // Binary path: 0x01 = AES-256-GCM (native OpenSSL via quick-crypto), 0x02 = legacy nacl (pure-JS, slow — delete old posts)
      // Dispatch is inside the bound fn in VaultContext — CachedImage just passes bytes through
      const decBin = getDecryptImgBinFn();
      if (!decBin) return null;
      jpegBytes = await decBin(bytes);
    } else if (bytes[0] === 0x65) {
      // Legacy text: enc: (hex) or encb: (base64) — both start with ASCII 'e' (0x65)
      const text = new TextDecoder().decode(bytes);
      if (text.startsWith('encb:')) {
        const fn = getDecryptImgFn() || getDecryptFn();
        base64 = await fn(text.slice(5));
      } else if (text.startsWith('enc:')) {
        base64 = await getDecryptFn()(text.slice(4));
      } else {
        return uri;
      }
    } else {
      return uri;
    }
    const t2 = performance.now();

    if (!jpegBytes && !base64) return null;
    await FileSystem.makeDirectoryAsync(ENC_CACHE_DIR, { intermediates: true });
    if (jpegBytes) {
      // expo-file-system File.write(Uint8Array) — native byte write, no JS base64 boundary
      await new FSFile(cacheFile).write(jpegBytes);
    } else {
      await FileSystem.writeAsStringAsync(cacheFile, base64, { encoding: FileSystem.EncodingType.Base64 });
    }
    const t3 = performance.now();

    console.log(`[FV] img ${filename.slice(-20)}: net=${Math.round(t1-t0)}ms decrypt=${Math.round(t2-t1)}ms write=${Math.round(t3-t2)}ms total=${Math.round(t3-t0)}ms sz=${bytes.length}`);
    _memCache.set(filename, cacheFile);
    return cacheFile;
  })();

  _inflight.set(cacheFile, promise);
  promise.finally(() => _inflight.delete(cacheFile));
  return promise;
}

export default function CachedImage({ uri, style, resizeMode = 'cover', transparent = false, ...props }) {
  const { cryptoReady } = useVault();
  const encrypted = isEncrypted(uri);
  // Initialise synchronously from memCache — avoids gray flash on FlatList remount
  const [decryptedUri, setDecryptedUri] = useState(() => getCachedUri(uri));

  useEffect(() => {
    if (!encrypted || !uri) return;
    const cached = getCachedUri(uri);
    if (cached) { setDecryptedUri(cached); return; }
    let cancelled = false;
    let retryTimer;
    setDecryptedUri(null);
    decryptAndCache(uri)
      .then((u) => { if (!cancelled && u) setDecryptedUri(u); })
      .catch(() => {
        if (cancelled) return;
        // Auto-retry once after 2s for transient failures (server cold-start, network blip)
        retryTimer = setTimeout(() => {
          if (cancelled) return;
          decryptAndCache(uri)
            .then((u) => { if (!cancelled && u) setDecryptedUri(u); })
            .catch(() => {});
        }, 2000);
      });
    return () => { cancelled = true; clearTimeout(retryTimer); };
  }, [uri, encrypted, cryptoReady]);

  if (!uri) {
    if (transparent) return null;
    return <View style={[{ backgroundColor: '#1a1a1a' }, style]} />;
  }

  if (encrypted) {
    if (!decryptedUri) {
      return (
        <View style={[{ backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' }, style]}>
          <ActivityIndicator color="rgba(255,255,255,0.35)" size="small" />
        </View>
      );
    }
    return (
      <Image
        source={{ uri: decryptedUri }}
        style={[!transparent && { backgroundColor: '#1a1a1a' }, style]}
        contentFit={CONTENT_FIT[resizeMode] || 'cover'}
        transition={150}
        {...props}
      />
    );
  }

  const key = cacheKey(uri);
  return (
    <Image
      source={key ? { uri, cacheKey: key } : { uri }}
      style={[!transparent && { backgroundColor: '#1a1a1a' }, style]}
      contentFit={CONTENT_FIT[resizeMode] || 'cover'}
      cachePolicy="disk"
      transition={150}
      {...props}
    />
  );
}
