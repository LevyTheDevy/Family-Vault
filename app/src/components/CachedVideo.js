import React, { useState, useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Video } from 'expo-av';
import CachedImage from './CachedImage';
import * as LegacyFS from 'expo-file-system/legacy';
import { File as FSFile } from 'expo-file-system';
import { getDecryptImgBinFn } from '../utils/api';
import { useVault } from '../context/VaultContext';

const VIDEO_CACHE_DIR = LegacyFS.cacheDirectory + 'fv-video/';

// Module-level caches — survive component remounts (same pattern as CachedImage)
const _videoMemCache = new Map(); // filename → local decrypted path
const _videoInflight = new Map(); // cachePath → Promise

function isEncryptedVideo(uri) {
  // Matches /storage/something.enc (with optional query params)
  return !!(uri?.match(/\/storage\/[^?#]+\.enc($|\?)/));
}

function getFilename(uri) {
  return uri?.match(/\/storage\/([^?#]+)/)?.[1] ?? null;
}

function getCachedVideoUri(uri) {
  if (!isEncryptedVideo(uri)) return null;
  const filename = getFilename(uri);
  return filename ? (_videoMemCache.get(filename) ?? null) : null;
}

async function decryptAndCacheVideo(uri) {
  const filename = getFilename(uri);
  if (!filename) return null;

  // Preserve original extension (e.g. .mp4.enc → .mp4, or default to .mp4)
  const ext = filename.replace(/\.enc$/, '').split('.').pop() || 'mp4';
  const cachePath = VIDEO_CACHE_DIR + filename.replace(/\.enc$/, `.${ext}`);

  if (_videoMemCache.has(filename)) return _videoMemCache.get(filename);

  try {
    const info = await LegacyFS.getInfoAsync(cachePath);
    if (info.exists && info.size > 0) {
      _videoMemCache.set(filename, cachePath);
      return cachePath;
    }
  } catch {}

  if (_videoInflight.has(cachePath)) return _videoInflight.get(cachePath);

  const decBin = getDecryptImgBinFn();
  if (!decBin) return null;

  const promise = (async () => {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);

    if (bytes[0] !== 0x01 && bytes[0] !== 0x02) {
      // Not encrypted — serve directly (shouldn't happen, but handle gracefully)
      return uri;
    }

    const t0 = performance.now();
    const videoBytes = await decBin(bytes);
    const t1 = performance.now();

    await LegacyFS.makeDirectoryAsync(VIDEO_CACHE_DIR, { intermediates: true });
    await new FSFile(cachePath).write(videoBytes);
    const t2 = performance.now();

    console.log(`[FV] video ${filename.slice(-24)}: decrypt=${Math.round(t1-t0)}ms write=${Math.round(t2-t1)}ms sz=${bytes.length}`);
    _videoMemCache.set(filename, cachePath);
    return cachePath;
  })();

  _videoInflight.set(cachePath, promise);
  promise.finally(() => _videoInflight.delete(cachePath));
  return promise;
}

export default function CachedVideo({ uri, style, shouldPlay = false, isLooping = false, isMuted = true, resizeMode, onLoad, onPlaybackStatusUpdate, posterUri, ...props }) {
  const { cryptoReady } = useVault();
  const encrypted = isEncryptedVideo(uri);
  const [localUri, setLocalUri] = useState(() => getCachedVideoUri(uri));
  const [loading, setLoading] = useState(encrypted && !getCachedVideoUri(uri));

  useEffect(() => {
    if (!encrypted || !uri) return;
    const cached = getCachedVideoUri(uri);
    if (cached) { setLocalUri(cached); setLoading(false); return; }

    let cancelled = false;
    setLocalUri(null);
    setLoading(true);

    decryptAndCacheVideo(uri)
      .then((u) => { if (!cancelled && u) { setLocalUri(u); setLoading(false); } })
      .catch(() => {
        if (cancelled) return;
        // Single retry after 2s for transient failures
        setTimeout(() => {
          if (cancelled) return;
          decryptAndCacheVideo(uri)
            .then((u) => { if (!cancelled && u) { setLocalUri(u); setLoading(false); } })
            .catch(() => { if (!cancelled) setLoading(false); });
        }, 2000);
      });

    return () => { cancelled = true; };
  }, [uri, encrypted, cryptoReady]);

  if (!uri) return <View style={[{ backgroundColor: '#000' }, style]} />;

  if (encrypted && !localUri) {
    return (
      <View style={[{ backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' }, style]}>
        {posterUri && (
          <CachedImage uri={posterUri} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
        )}
        {loading && <ActivityIndicator color="rgba(255,255,255,0.4)" size="small" />}
      </View>
    );
  }

  return (
    <Video
      source={{ uri: localUri || uri }}
      style={[{ backgroundColor: '#000' }, style]}
      shouldPlay={shouldPlay}
      isLooping={isLooping}
      isMuted={isMuted}
      resizeMode={resizeMode}
      onLoad={onLoad}
      onPlaybackStatusUpdate={onPlaybackStatusUpdate}
      {...props}
    />
  );
}
