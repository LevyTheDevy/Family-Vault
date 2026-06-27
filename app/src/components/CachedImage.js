import React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';

const CONTENT_FIT = { cover: 'cover', contain: 'contain', stretch: 'fill', center: 'scale-down' };

// Stable cache key from filename only (excludes token so re-login doesn't bust cache)
function cacheKey(uri) {
  if (!uri) return undefined;
  const storage = uri.match(/\/storage\/([^?#]+)/);
  if (storage) return storage[1];
  const avatar = uri.match(/\/members\/([^/]+)\/avatar(?:.*[?&]v=(\d+))?/);
  if (avatar) return `avatar_${decodeURIComponent(avatar[1])}_${avatar[2] || '0'}`;
  return undefined;
}

export default function CachedImage({ uri, style, resizeMode = 'cover', transparent = false, ...props }) {
  if (!uri) {
    if (transparent) return null;
    return <View style={[{ backgroundColor: '#1a1a1a' }, style]} />;
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
