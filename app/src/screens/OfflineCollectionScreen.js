import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, RefreshControl, Modal, ScrollView, Dimensions,
  StatusBar, SafeAreaView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { Feather, Ionicons } from '@expo/vector-icons';
import CachedImage from '../components/CachedImage';
import { useTheme } from '../context/ThemeContext';
import { savePost } from '../utils/api';
import { removeOfflineMedia } from '../utils/offline';

// Prefer the permanent decrypted local copies; fall back to the remote URL
// per index for entries saved before local copies existed (or failed slots)
function displayUrls(post) {
  const remote = post?.imageUrls?.length ? post.imageUrls : (post?.imageUrl ? [post.imageUrl] : []);
  if (!post?.localPaths?.length) return remote;
  return post.localPaths.map((p, i) => p || remote[i]).filter(Boolean);
}

const OFFLINE_KEY = 'fv_offline_posts';
const { width: W, height: H } = Dimensions.get('window');

function GalleryModal({ post, onClose }) {
  const [page, setPage] = useState(0);
  const scrollRef = useRef(null);
  const urls = displayUrls(post);

  const handleScroll = (e) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / W);
    setPage(idx);
  };

  if (!post) return null;

  return (
    <Modal visible animationType="fade" transparent={false} onRequestClose={onClose} statusBarTranslucent>
      <StatusBar hidden />
      <View style={gallery.container}>
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={16}
        >
          {urls.map((uri, i) => (
            <View key={i} style={gallery.page}>
              <CachedImage uri={uri} style={gallery.image} resizeMode="contain" />
            </View>
          ))}
        </ScrollView>

        {urls.length > 1 && (
          <View style={gallery.dots}>
            {urls.map((_, i) => (
              <View key={i} style={[gallery.dot, i === page && gallery.dotActive]} />
            ))}
          </View>
        )}

        <View style={gallery.overlay} pointerEvents="none">
          <Text style={gallery.author}>{post.author}</Text>
          {!!post.caption && <Text style={gallery.caption} numberOfLines={3}>{post.caption}</Text>}
        </View>

        <TouchableOpacity style={gallery.closeBtn} onPress={onClose} hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }} accessibilityRole="button" accessibilityLabel="Close gallery">
          <Feather name="x" size={22} color="#fff" />
        </TouchableOpacity>

        {urls.length > 1 && (
          <View style={gallery.pageCount} pointerEvents="none">
            <Text style={gallery.pageCountText}>{page + 1} / {urls.length}</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

export default function OfflineCollectionScreen() {
  const { colors } = useTheme();
  const [posts, setPosts] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [viewing, setViewing] = useState(null);

  const load = async () => {
    try {
      const raw = await AsyncStorage.getItem(OFFLINE_KEY);
      setPosts(raw ? JSON.parse(raw) : []);
    } catch { setPosts([]); }
  };

  useFocusEffect(useCallback(() => { load(); }, []));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handleRemove = (id) => {
    Alert.alert('Remove from Offline?', 'This will remove the post from your saved list.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          const next = posts.filter((p) => p.id !== id);
          setPosts(next);
          await AsyncStorage.setItem(OFFLINE_KEY, JSON.stringify(next));
          removeOfflineMedia(id);
          savePost(id).catch(() => {});
        },
      },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.screenBg }]}>
      {posts.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="bookmark" size={36} color={colors.textSub} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No saved posts</Text>
          <Text style={[styles.emptySub, { color: colors.textSub }]}>
            Tap the bookmark on any post to save it here.{'\n'}Long-press a post to remove it.
          </Text>
        </View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(p) => String(p.id)}
          numColumns={3}
          contentContainerStyle={styles.grid}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
          renderItem={({ item }) => {
            const urls = displayUrls(item);
            const thumbUrl = urls[0] || null;
            const extraCount = urls.length - 1;
            return (
              <TouchableOpacity
                style={[styles.cell, { borderColor: colors.border }]}
                onPress={() => setViewing(item)}
                onLongPress={() => handleRemove(item.id)}
                activeOpacity={0.8}
              >
                <View style={styles.thumbWrap}>
                  {thumbUrl
                    ? <CachedImage uri={thumbUrl} style={styles.thumb} resizeMode="cover" />
                    : <View style={[styles.thumb, { backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }]}>
                        <Feather name="image" size={22} color={colors.textSub} />
                      </View>}
                  {extraCount > 0 && (
                    <View style={styles.multiCount}>
                      <Feather name="copy" size={10} color="#fff" />
                      <Text style={styles.multiCountText}>{extraCount + 1}</Text>
                    </View>
                  )}
                </View>
                <View style={[styles.meta, { backgroundColor: colors.card }]}>
                  <Text style={[styles.metaAuthor, { color: colors.text }]} numberOfLines={1}>{item.author}</Text>
                  {!!item.caption && <Text style={[styles.metaCaption, { color: colors.textSub }]} numberOfLines={1}>{item.caption}</Text>}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {viewing && <GalleryModal post={viewing} onClose={() => setViewing(null)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptySub: { fontSize: 13, textAlign: 'center', lineHeight: 20 },
  grid: { padding: 2 },
  cell: { flex: 1, margin: 2, borderRadius: 6, overflow: 'hidden', borderWidth: 1 },
  thumbWrap: { position: 'relative' },
  thumb: { width: '100%', aspectRatio: 1 },
  multiCount: {
    position: 'absolute', top: 5, right: 5,
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 8, paddingHorizontal: 5, paddingVertical: 2,
  },
  multiCountText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  meta: { padding: 6 },
  metaAuthor: { fontSize: 11, fontWeight: '600' },
  metaCaption: { fontSize: 10, marginTop: 1 },
});

const gallery = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  page: { width: W, height: H, alignItems: 'center', justifyContent: 'center' },
  image: { width: W, height: H },
  overlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: 20, paddingBottom: 48, paddingTop: 80,
  },
  author: { color: '#fff', fontSize: 15, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  caption: { color: 'rgba(255,255,255,0.85)', fontSize: 13, marginTop: 4, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  closeBtn: { position: 'absolute', top: 52, right: 20, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: 8 },
  dots: { position: 'absolute', bottom: 24, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)' },
  dotActive: { backgroundColor: '#fff', width: 18 },
  pageCount: { position: 'absolute', top: 56, left: 0, right: 0, alignItems: 'center' },
  pageCountText: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '600' },
});
