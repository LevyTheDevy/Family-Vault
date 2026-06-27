import React, { useState, useEffect } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import { getDecryptFn } from '../utils/api';

const CONTENT_FIT = { cover: 'cover', contain: 'contain', stretch: 'fill', center: 'scale-down' };
const ENC_CACHE_DIR = FileSystem.cacheDirectory + 'fv-enc/';

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

async function decryptAndCache(uri) {
  const filename = uri.match(/\/storage\/([^?#]+)/)?.[1];
  if (!filename) return null;
  const cacheFile = ENC_CACHE_DIR + filename.replace(/\.enc$/, '.jpg');
  try {
    const info = await FileSystem.getInfoAsync(cacheFile);
    if (info.exists) return cacheFile;
  } catch {}

  const decryptFn = getDecryptFn();
  if (!decryptFn) return null;

  const res = await fetch(uri);
  const encText = await res.text();
  if (!encText.startsWith('enc:')) return uri;

  const base64 = await decryptFn(encText.slice(4));
  await FileSystem.makeDirectoryAsync(ENC_CACHE_DIR, { intermediates: true });
  await FileSystem.writeAsStringAsync(cacheFile, base64, { encoding: FileSystem.EncodingType.Base64 });
  return cacheFile;
}

export default function CachedImage({ uri, style, resizeMode = 'cover', transparent = false, ...props }) {
  const [decryptedUri, setDecryptedUri] = useState(null);
  const encrypted = isEncrypted(uri);

  useEffect(() => {
    if (!encrypted || !uri) return;
    let cancelled = false;
    decryptAndCache(uri).then((u) => { if (!cancelled) setDecryptedUri(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [uri, encrypted]);

  if (!uri) {
    if (transparent) return null;
    return <View style={[{ backgroundColor: '#1a1a1a' }, style]} />;
  }

  if (encrypted) {
    if (!decryptedUri) return <View style={[{ backgroundColor: '#1a1a1a' }, style]} />;
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
