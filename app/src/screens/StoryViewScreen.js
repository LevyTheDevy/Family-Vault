import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Animated, Alert, Modal, FlatList, ScrollView,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { deleteStory, getMemberName, viewStory, reactToStory, fetchStoryViewers, likeDaily } from '../utils/api';
import CachedImage from '../components/CachedImage';

const STORY_DURATION = 5000;
const REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '🔥', '👏'];

export default function StoryViewScreen({ route, navigation }) {
  const { stories } = route.params;
  const [index, setIndex] = useState(0);
  const [myReaction, setMyReaction] = useState(
    () => stories[0]?.reactions?.find((r) => r.author === getMemberName())?.emoji ?? null
  );
  const [isLiked, setIsLiked] = useState(
    () => stories[0]?.likes?.includes(getMemberName()) ?? false
  );
  const [showInfoPanel, setShowInfoPanel] = useState(false);
  const [viewerInfo, setViewerInfo] = useState(null);
  const [paused, setPaused] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const animRef = useRef(null);
  const me = getMemberName();

  const story = stories[index];

  // Sync reaction + like state when story changes (user navigates between stories)
  useEffect(() => {
    const r = story?.reactions?.find((r) => r.author === me);
    setMyReaction(r?.emoji ?? null);
    setIsLiked(story?.likes?.includes(me) ?? false);
    if (story) viewStory(story.id).catch(() => {});
  }, [story?.id]);

  const startProgress = () => {
    progress.setValue(0);
    animRef.current = Animated.timing(progress, {
      toValue: 1,
      duration: STORY_DURATION,
      useNativeDriver: false,
    });
    animRef.current.start(({ finished }) => {
      if (finished) advance();
    });
  };

  const stopProgress = () => animRef.current?.stop();

  useEffect(() => {
    if (!paused) startProgress();
    else stopProgress();
    return () => stopProgress();
  }, [index, paused]);

  const advance = () => {
    if (index < stories.length - 1) setIndex((i) => i + 1);
    else navigation.goBack();
  };

  const goBack = () => {
    if (index > 0) { stopProgress(); setIndex((i) => i - 1); }
  };

  const handleDelete = () => {
    if (story.author !== me) return;
    Alert.alert('Delete story?', 'This story will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try { await deleteStory(story.id); navigation.goBack(); }
          catch (e) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  const handleLike = async () => {
    const prev = isLiked;
    setIsLiked(!prev);
    try { await likeDaily(story.id); }
    catch { setIsLiked(prev); }
  };

  const handleReact = async (emoji) => {
    // Capture current state before the optimistic update so the catch revert is correct
    const prev = myReaction;
    const next = prev === emoji ? null : emoji;
    setMyReaction(next);
    try {
      await reactToStory(story.id, emoji);
    } catch {
      setMyReaction(prev); // revert using captured value, not stale closure
    }
  };

  const openInfoPanel = async () => {
    setPaused(true);
    setShowInfoPanel(true);
    try {
      const data = await fetchStoryViewers(story.id);
      setViewerInfo(data);
    } catch { setViewerInfo(null); }
  };

  const closeInfoPanel = () => {
    setShowInfoPanel(false);
    setViewerInfo(null);
    setPaused(false);
  };

  if (!story) return null;

  const isOwner = story.author === me;
  const viewCount = story.views?.length ?? 0;

  // Group reactions by emoji for the info panel
  const reactionGroups = viewerInfo?.reactions?.reduce((acc, r) => {
    if (!acc[r.emoji]) acc[r.emoji] = [];
    acc[r.emoji].push(r.author);
    return acc;
  }, {}) ?? {};

  return (
    <View style={styles.container}>
      <CachedImage uri={story.imageUrl} style={styles.image} resizeMode="cover" />

      {/* Progress bars */}
      <View style={styles.progressRow}>
        {stories.map((_, i) => (
          <View key={i} style={styles.progressTrack}>
            <Animated.View
              style={[styles.progressFill, {
                width: i < index
                  ? '100%'
                  : i === index
                    ? progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
                    : '0%',
              }]}
            />
          </View>
        ))}
      </View>

      {/* Header row */}
      <View style={styles.storyHeader}>
        <View style={styles.authorRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{story.author[0].toUpperCase()}</Text>
          </View>
          <View>
            <Text style={styles.authorName}>{story.author}</Text>
            <Text style={styles.expiryText}>Expires {new Date(story.expiresAt).toLocaleString()}</Text>
          </View>
        </View>
        <View style={styles.headerRight}>
          {isOwner && (
            <TouchableOpacity onPress={handleDelete} style={styles.deleteBtn}>
              <Text style={styles.deleteBtnText}>Delete</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Caption overlay */}
      {!!story.caption && (
        <View style={styles.captionWrap} pointerEvents="none">
          <Text style={styles.captionText}>{story.caption}</Text>
        </View>
      )}

      {/* Tap zones (left/right to navigate stories) */}
      <View style={styles.tapZones} pointerEvents="box-none">
        <TouchableOpacity style={styles.tapLeft} onPress={goBack} />
        <TouchableOpacity style={styles.tapRight} onPress={advance} />
      </View>

      {/* Bottom area: like + reactions + owner viewer count */}
      <View style={styles.bottomBar} pointerEvents="box-none">
        {/* Like button */}
        <TouchableOpacity style={styles.likeBtn} onPress={handleLike} pointerEvents="auto">
          <Feather name="heart" size={24} color={isLiked ? '#ff4d6d' : 'rgba(255,255,255,0.85)'} />
        </TouchableOpacity>

        {/* Reaction emoji row */}
        <View style={styles.reactionRow} pointerEvents="auto">
          {REACTION_EMOJIS.map((emoji) => (
            <TouchableOpacity
              key={emoji}
              style={[styles.reactionBtn, myReaction === emoji && styles.reactionBtnActive]}
              onPress={() => handleReact(emoji)}
            >
              <Text style={styles.reactionEmoji}>{emoji}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Owner: view count — plain text, no emoji */}
        {isOwner && (
          <TouchableOpacity style={styles.viewerBadge} onPress={openInfoPanel} pointerEvents="auto">
            <Feather name="eye" size={13} color="#aaa" />
            <Text style={styles.viewerBadgeText}>{viewCount} {viewCount === 1 ? 'view' : 'views'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Info panel — owner only, shows viewers + reactions */}
      <Modal
        visible={showInfoPanel}
        transparent
        animationType="slide"
        onRequestClose={closeInfoPanel}
        statusBarTranslucent
      >
        <View style={styles.panelBackdrop}>
          <TouchableOpacity style={styles.panelDismiss} onPress={closeInfoPanel} activeOpacity={1} />
          <View style={styles.panelSheet}>
            <View style={styles.panelHandle} />
            <Text style={styles.panelTitle}>Daily Insights</Text>

            {viewerInfo === null ? (
              <View style={styles.panelCenter}>
                <Text style={styles.panelLoadingText}>Loading...</Text>
              </View>
            ) : (
              <ScrollView style={styles.panelScroll} keyboardShouldPersistTaps="handled">
                {/* Views */}
                <Text style={styles.panelSection}>
                  👁  Seen by {viewerInfo.views.length === 0 ? 'no one yet' : ''}
                </Text>
                {viewerInfo.views.map((name) => (
                  <View key={name} style={styles.panelRow}>
                    <View style={styles.panelAvatar}>
                      <Text style={styles.panelAvatarText}>{name[0].toUpperCase()}</Text>
                    </View>
                    <Text style={styles.panelName}>{name}</Text>
                  </View>
                ))}

                {/* Reactions grouped by emoji */}
                {Object.keys(reactionGroups).length > 0 && (
                  <>
                    <Text style={[styles.panelSection, { marginTop: 20 }]}>Reactions</Text>
                    {Object.entries(reactionGroups).map(([emoji, names]) => (
                      <View key={emoji} style={styles.reactionGroup}>
                        <Text style={styles.reactionGroupEmoji}>{emoji}</Text>
                        <View style={styles.reactionGroupNames}>
                          {names.map((n) => (
                            <View key={n} style={styles.panelRow}>
                              <View style={styles.panelAvatar}>
                                <Text style={styles.panelAvatarText}>{n[0].toUpperCase()}</Text>
                              </View>
                              <Text style={styles.panelName}>{n}</Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    ))}
                  </>
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  image: { ...StyleSheet.absoluteFillObject },

  progressRow: {
    position: 'absolute', top: 52, left: 12, right: 12,
    flexDirection: 'row', gap: 3, zIndex: 10,
  },
  progressTrack: { flex: 1, height: 2, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 1, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#fff', borderRadius: 1 },

  storyHeader: {
    position: 'absolute', top: 62, left: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 10,
  },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#222', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)',
  },
  avatarText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  authorName: { color: '#fff', fontWeight: '600', fontSize: 14 },
  expiryText: { color: 'rgba(255,255,255,0.5)', fontSize: 10 },
  captionWrap: { position: 'absolute', bottom: 220, left: 0, right: 0, paddingHorizontal: 24, alignItems: 'center' },
  captionText: { color: '#fff', fontSize: 16, fontWeight: '500', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 8, lineHeight: 22, backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  headerRight: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  deleteBtn: {
    backgroundColor: 'rgba(255,60,60,0.3)', borderRadius: 6,
    paddingVertical: 5, paddingHorizontal: 10,
  },
  deleteBtnText: { color: '#ff6666', fontSize: 12 },
  closeBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  closeBtnText: { color: '#fff', fontSize: 16 },

  tapZones: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', zIndex: 5 },
  tapLeft: { flex: 1 },
  tapRight: { flex: 1 },

  // Bottom bar: like + reactions + owner viewer count
  bottomBar: {
    position: 'absolute', bottom: 52, left: 0, right: 0,
    alignItems: 'center', gap: 14, zIndex: 10,
  },
  likeBtn: {
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 24,
    padding: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  viewerBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20,
    paddingVertical: 6, paddingHorizontal: 14,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  viewerBadgeText: { color: '#aaa', fontSize: 13 },

  reactionRow: {
    flexDirection: 'row', gap: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 36,
    paddingVertical: 8, paddingHorizontal: 16,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  reactionBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
  },
  reactionBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    transform: [{ scale: 1.15 }],
  },
  reactionEmoji: { fontSize: 22 },

  // Info panel (owner)
  panelBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  panelDismiss: { flex: 1 },
  panelSheet: {
    backgroundColor: '#0d0d0d', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    maxHeight: '60%', borderTopWidth: 1, borderColor: '#1e1e1e',
  },
  panelHandle: {
    width: 38, height: 4, backgroundColor: '#2a2a2a',
    borderRadius: 2, alignSelf: 'center', marginTop: 10,
  },
  panelTitle: {
    color: '#fff', fontSize: 15, fontWeight: '700',
    textAlign: 'center', paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#1a1a1a',
  },
  panelCenter: { padding: 40, alignItems: 'center' },
  panelLoadingText: { color: '#444', fontSize: 13 },
  panelScroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24 },
  panelSection: { color: '#555', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10, marginTop: 4 },
  panelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#111' },
  panelAvatar: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center',
  },
  panelAvatarText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  panelName: { color: '#ccc', fontSize: 14 },
  reactionGroup: { marginBottom: 8 },
  reactionGroupEmoji: { fontSize: 20, marginBottom: 4 },
  reactionGroupNames: { paddingLeft: 4 },
});
