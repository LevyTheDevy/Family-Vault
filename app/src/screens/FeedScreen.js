import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, FlatList, StyleSheet, RefreshControl, Text, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect, useScrollToTop } from '@react-navigation/native';
import PostSlide from '../components/PostSlide';
import PendingPostSlide from '../components/PendingPostSlide';
import StoriesStrip from '../components/StoriesStrip';
import CommentsSheet from '../components/CommentsSheet';
import { fetchPosts, fetchStories, getMemberName, consumeFeedDirty, getVaultUrl } from '../utils/api';
import { subscribeQueue, onUploadComplete, retryUpload, discardUpload } from '../utils/uploadQueue';
import { useTheme } from '../context/ThemeContext';
import { useVault } from '../context/VaultContext';

const PAGE_SIZE = 20;
const STALE_MS = 60_000;

export default function FeedScreen({ navigation }) {
  const { colors } = useTheme();
  const { activeIndex } = useVault();
  const me = getMemberName();
  const [posts, setPosts] = useState([]);
  const [pendingUploads, setPendingUploads] = useState([]);
  const [stories, setStories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activePostId, setActivePostId] = useState(null);
  const [listHeight, setListHeight] = useState(0);
  const [commentPost, setCommentPost] = useState(null);
  const offsetRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  const lastFetchRef = useRef(0);
  const listHeightRef = useRef(0);
  const fetchingRef = useRef(false);
  const hasDataRef = useRef(false);
  const listRef = useRef(null);
  // Tapping the Feed tab while already on it scrolls back to the top
  useScrollToTop(listRef);

  async function loadFeed(reset = true) {
    const off = reset ? 0 : offsetRef.current;
    const { posts: newPosts, hasMore } = await fetchPosts({ limit: PAGE_SIZE, offset: off });
    hasMoreRef.current = hasMore;
    if (reset) {
      setPosts(newPosts);
      hasDataRef.current = newPosts.length > 0;
      offsetRef.current = newPosts.length;
      setActivePostId(newPosts[0]?.id ?? null);
    } else {
      setPosts((prev) => [...prev, ...newPosts]);
      offsetRef.current = off + newPosts.length;
    }
  }

  const load = async () => {
    await Promise.all([
      loadFeed(true),
      fetchStories().catch(() => []).then((s) =>
        setStories(s.filter((st) => !st.expiresAt || new Date(st.expiresAt) > new Date()))
      ),
    ]);
    lastFetchRef.current = Date.now();
  };

  // Background upload queue: pending items render as slides at the top of the
  // feed; when one finishes, the real post slots in without a refetch.
  useEffect(() => {
    const unsubList = subscribeQueue(setPendingUploads);
    const unsubDone = onUploadComplete((item, result) => {
      // An upload targeting a different vault must not leak into this feed
      if (item.vaultUrl !== getVaultUrl()) return;
      if (item.kind === 'story') {
        fetchStories().catch(() => []).then((s) =>
          setStories(s.filter((st) => !st.expiresAt || new Date(st.expiresAt) > new Date())));
      } else if (result) {
        setPosts((prev) => [result, ...prev.filter((p) => p.id !== result.id)]);
        offsetRef.current += 1;
        setActivePostId(result.id);
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
      }
    });
    return () => { unsubList(); unsubDone(); };
  }, []);

  // Only show pending items that belong to the vault currently on screen
  const vaultPending = pendingUploads.filter((i) => i.vaultUrl === getVaultUrl());
  const pendingPosts = vaultPending.filter((i) => i.kind !== 'story');
  const pendingStories = vaultPending.filter((i) => i.kind === 'story');

  const handlePendingStoryPress = useCallback((item) => {
    if (item.status !== 'failed') return;
    Alert.alert("Daily didn't upload", item.error || 'Upload failed', [
      { text: 'Discard', style: 'destructive', onPress: () => discardUpload(item.id) },
      { text: 'Retry', onPress: () => retryUpload(item.id) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, []);

  const onEndReached = useCallback(() => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    loadFeed(false)
      .catch(() => {})
      .finally(() => { loadingMoreRef.current = false; setLoadingMore(false); });
  }, []);

  useFocusEffect(useCallback(() => {
    const dirty = consumeFeedDirty();
    const stale = dirty || Date.now() - lastFetchRef.current > STALE_MS;
    let active = true;

    if (!stale && hasDataRef.current) {
      const timer = setInterval(() => {
        setStories((prev) => prev.filter((st) => !st.expiresAt || new Date(st.expiresAt) > new Date()));
      }, 60_000);
      return () => { active = false; clearInterval(timer); };
    }

    if (!fetchingRef.current) {
      fetchingRef.current = true;
      // Only show full spinner on first load; background refresh keeps existing posts visible
      if (!hasDataRef.current) setLoading(true);
      load()
        .then(() => {
          // Just posted — jump to the top so the new post is what you see
          if (dirty && active) listRef.current?.scrollToOffset({ offset: 0, animated: false });
        })
        .catch(() => {})
        .finally(() => { fetchingRef.current = false; if (active) setLoading(false); });
    }

    const timer = setInterval(() => {
      setStories((prev) => prev.filter((st) => !st.expiresAt || new Date(st.expiresAt) > new Date()));
    }, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, []));

  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    fetchingRef.current = false; // reset guard on vault switch so fresh load runs
    lastFetchRef.current = 0;
    hasDataRef.current = false;
    setLoading(true);
    fetchingRef.current = true;
    load().catch(() => {}).finally(() => { fetchingRef.current = false; setLoading(false); });
  }, [activeIndex]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, []);

  const handleDeleted = useCallback((id) => {
    setPosts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleCommentUpdated = useCallback((updated) => {
    setPosts((prev) => prev.map((p) => p.id === updated.id ? updated : p));
    setCommentPost((cp) => cp?.id === updated.id ? updated : cp);
  }, []);

  const onLayout = useCallback((e) => {
    const h = e.nativeEvent.layout.height;
    listHeightRef.current = h;
    setListHeight(h);
  }, []);

  const getItemLayout = useCallback((_, index) => ({
    length: listHeightRef.current,
    offset: listHeightRef.current * index,
    index,
  }), []);

  // Stable refs required by FlatList — recreating these breaks viewability tracking
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    setActivePostId(viewableItems[0]?.item?.id ?? null);
  }).current;

  const renderItem = useCallback(({ item }) => {
    if (item.__pending) {
      return (
        <PendingPostSlide
          item={item}
          height={listHeight}
          onRetry={() => retryUpload(item.id)}
          onDiscard={() => discardUpload(item.id)}
        />
      );
    }
    return (
      <PostSlide
        post={item}
        height={listHeight}
        isActive={item.id === activePostId}
        onDeleted={handleDeleted}
        onCommentPress={setCommentPost}
      />
    );
  }, [listHeight, activePostId, handleDeleted]);

  const feedData = pendingPosts.length
    ? [...pendingPosts.map((i) => ({ ...i, __pending: true })), ...posts]
    : posts;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <StoriesStrip
        stories={stories}
        pendingStories={pendingStories}
        onPendingPress={handlePendingStoryPress}
        onAdd={() => navigation.navigate('StoryCreate')}
        onView={(storyList) => {
          navigation.navigate('StoryView', { stories: storyList });
          const ids = new Set(storyList.map((s) => s.id));
          setStories((prev) => prev.map((s) =>
            ids.has(s.id) && !(s.views || []).some((v) => v.viewer === me)
              ? { ...s, views: [...(s.views || []), { viewer: me, viewedAt: new Date().toISOString() }] }
              : s
          ));
        }}
      />

      {loading && feedData.length === 0 ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : feedData.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.emptyText, { color: colors.text }]}>No posts yet.</Text>
          <Text style={[styles.emptySub, { color: colors.textSub }]}>Tap + to share a photo.</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          style={styles.list}
          data={feedData}
          keyExtractor={(p) => (p.__pending ? p.id : String(p.id))}
          renderItem={renderItem}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          windowSize={5}
          initialNumToRender={3}
          maxToRenderPerBatch={3}
          onLayout={onLayout}
          getItemLayout={getItemLayout}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.15}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          ListFooterComponent={loadingMore ? (
            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
              <ActivityIndicator color={colors.text} />
            </View>
          ) : null}
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
