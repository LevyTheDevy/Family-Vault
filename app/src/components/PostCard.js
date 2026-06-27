import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import CachedImage from './CachedImage';

const WIDTH = Dimensions.get('window').width - 24;

function timeAgo(isoString) {
  const diff = (Date.now() - new Date(isoString).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function PostCard({ post }) {
  return (
    <View style={styles.card}>
      <CachedImage
        uri={post.imageUrl}
        style={styles.image}
        resizeMode="cover"
      />
      <View style={styles.footer}>
        <Text style={styles.author}>{post.author}</Text>
        <Text style={styles.time}>{timeAgo(post.createdAt)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#111',
    borderRadius: 8,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#1a1a1a',
  },
  image: {
    width: WIDTH,
    height: WIDTH * 0.75,
    backgroundColor: '#111',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  author: { color: '#fff', fontSize: 13, fontWeight: '600' },
  time: { color: '#444', fontSize: 12 },
});
