import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import CachedImage from './CachedImage';

const PALETTE = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444','#14b8a6','#f97316','#06b6d4'];

function nameColor(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export default function Avatar({ name = '', uri, size = 36, style }) {
  const initials = (name || '?').split(' ').filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
  const bg = nameColor(name);
  const r = size / 2;

  return (
    <View style={[{ width: size, height: size, borderRadius: r, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, style]}>
      <Text style={{ color: '#fff', fontSize: size * 0.38, fontWeight: '600', lineHeight: size * 0.48 }}>{initials}</Text>
      {uri && (
        <CachedImage
          uri={uri}
          style={StyleSheet.absoluteFillObject}
          resizeMode="cover"
          transparent
        />
      )}
    </View>
  );
}
