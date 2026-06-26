import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, FlatList, StyleSheet, RefreshControl, Text, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import PostSlide from '../components/PostSlide';
import StoriesStrip from '../components/StoriesStrip';
import CommentsSheet from '../components/CommentsSheet';
import { fetchPosts, fetchStories, getMemberName } from '../utils/api';
import { useTheme } from '../context/ThemeContext';

export default function FeedScreen({ navigation }) {
  const { colors } = useTheme();
  const me = getMemberName();
  const [posts, setPosts] = useState([]);
  const [stories, setStories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [listHeight, setListHeight] = useState(0);
  const [commentPost, setCommentPost] = useState(null);

  const load = async () => {
    const [p, s] = await Promise.all([
      fetchPosts().catch(() => []),
      fetchStories().catch(() => []),
    ]);
    setPosts(p);
    setStories(s.filter((st) => !st.expiresAt || new Date(st.expiresAt) > new Date()));
  };

  useFocusEffect(useCallback(() => {
    setLoading(true);
    load().finally(() => setLoading(false));

    // Drop expired stories while the screen stays open
    const timer = setInterval(() => {
      setStories((prev) => prev.filter((st) => !st.expiresAt || new Date(st.expiresAt) > new Date()));
    }, 60_000);
    return () => clearInterval(timer);
  }, []));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handleDeleted = (id) => setPosts((prev) => prev.filter((p) => p.id !== id));

  const handleCommentUpdated = (updated) => {
    setPosts((prev) => prev.map((p) => p.id === updated.id ? updated : p));
    setCommentPost((cp) => cp?.id === updated.id ? updated : cp);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <StoriesStrip
        stories={stories}
        onAdd={() => navigation.navigate('StoryCreate')}
        onView={(storyList) => {
          navigation.navigate('StoryView', { stories: storyList });
          // Optimistically mark all as viewed so glow clears immediately
          const ids = new Set(storyList.map((s) => s.id));
          setStories((prev) => prev.map((s) =>
            ids.has(s.id) && !(s.views || []).some((v) => v.viewer === me)
              ? { ...s, views: [...(s.views || []), { viewer: me, viewedAt: new Date().toISOString() }] }
              : s
          ));
        }}
      />

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : posts.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.emptyText, { color: colors.text }]}>No posts yet.</Text>
          <Text style={[styles.emptySub, { color: colors.textSub }]}>Tap + to share a photo.</Text>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          data={posts}
          keyExtractor={(p) => String(p.id)}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
          renderItem={({ item }) => (
            <PostSlide
              post={item}
              height={listHeight}
              onDeleted={handleDeleted}
              onCommentPress={setCommentPost}
            />
          )}
        />
      )}

      {commentPost && (
        <CommentsSheet
          post={commentPost}
          onClose={() => setCommentPost(null)}
          onUpdated={handleCommentUpdated}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyText: { fontSize: 16, fontWeight: '600' },
  emptySub: { fontSize: 13 },
});
