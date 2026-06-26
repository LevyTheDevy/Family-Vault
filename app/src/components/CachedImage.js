import React, { useState, useEffect, useRef } from 'react';
import { View, Image, StyleSheet } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

const CACHE_DIR = FileSystem.cacheDirectory + 'fv/';

function cacheKeyFor(uri) {
  const storagePart = uri.match(/\/storage\/([^?#]+)/);
  if (storagePart) return storagePart[1].replace(/[^a-zA-Z0-9._-]/g, '_');

  const avatarPart = uri.match(/\/members\/([^/]+)\/avatar(?:.*[?&]v=(\d+))?/);
  if (avatarPart) {
    const name = decodeURIComponent(avatarPart[1]).replace(/[^a-zA-Z0-9]/g, '_');
    return `avatar_${name}_${avatarPart[2] || '0'}.jpg`;
  }

  return null;
}

async function download(uri, cachePath) {
  await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true }).catch(() => {});
  const result = await FileSystem.downloadAsync(uri, cachePath);
  if (result.status !== 200) {
    FileSystem.deleteAsync(cachePath, { idempotent: true }).catch(() => {});
    throw new Error(`HTTP ${result.status}`);
  }
  return result.uri;
}

/**
 * transparent: when true, renders nothing while loading/error so the background
 * (e.g. Avatar initials) shows through until the image is fully decoded.
 */
export default function CachedImage({ uri, style, resizeMode = 'cover', transparent = false, ...props }) {
  const [localUri, setLocalUri] = useState(null);
  const [ready, setReady] = useState(false);   // true only after onLoad fires (native decode done)
  const [failed, setFailed] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    setLocalUri(null);
    setReady(false);
    setFailed(false);

    if (!uri) { setFailed(true); return; }

    const key = cacheKeyFor(uri);

    (async () => {
      if (!key) {
        // Unknown URL pattern — skip disk cache
        if (!cancelRef.current) setLocalUri(uri);
        return;
      }

      const cachePath = CACHE_DIR + key;

      // Try cache first
      try {
        const info = await FileSystem.getInfoAsync(cachePath);
        // Require a minimum file size to guard against truncated previous downloads
        if (info.exists && (info.size ?? 0) > 512 && !cancelRef.current) {
          setLocalUri(cachePath);
          return;
        }
        // Corrupt / empty cache file — delete it before re-downloading
        if (info.exists) FileSystem.deleteAsync(cachePath, { idempotent: true }).catch(() => {});
      } catch {}

      // Download fresh
      try {
        const resultUri = await download(uri, cachePath);
        if (!cancelRef.current) setLocalUri(resultUri);
      } catch {
        if (!cancelRef.current) setFailed(true);
      }
    })();

    return () => { cancelRef.current = true; };
  }, [uri]);

  // ─── Error / no URI ────────────────────────────────────────────────────────
  if (failed) {
    if (transparent) return null;
    return <View style={[styles.placeholder, style]} />;
  }

  // ─── Still fetching from disk/network ──────────────────────────────────────
  if (!localUri) {
    if (transparent) return null;
    return <View style={[styles.placeholder, style]} />;
  }

  // ─── URI available — render image, show placeholder until decode completes ─
  //
  // The Image is kept invisible (opacity 0) until onLoad fires.
  // onLoad fires AFTER the native layer has fully decoded the bitmap into a
  // texture, so there is never a gray / half-loaded flash.

  if (transparent) {
    // Avatar mode: no placeholder background needed — initials show through.
    return (
      <Image
        source={{ uri: localUri }}
        style={[style, !ready && styles.invisible]}
        resizeMode={resizeMode}
        onLoad={() => setReady(true)}
        onError={() => {
          // Cached file corrupt — delete so next mount re-downloads
          if (localUri !== uri) FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
          setFailed(true);
        }}
        {...props}
      />
    );
  }

  // Normal mode: placeholder sits behind the invisible image until decode done.
  return (
    <View style={[style, styles.wrap]}>
      {!ready && <View style={[StyleSheet.absoluteFillObject, styles.placeholder]} />}
      <Image
        source={{ uri: localUri }}
        style={[StyleSheet.absoluteFillObject, !ready && styles.invisible]}
        resizeMode={resizeMode}
        onLoad={() => setReady(true)}
        onError={() => {
          if (localUri !== uri) FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
          setFailed(true);
        }}
        {...props}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  placeholder: { backgroundColor: '#1a1a1a' },
  invisible: { opacity: 0 },
});
