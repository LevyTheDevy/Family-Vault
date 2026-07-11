import React, { useEffect, useRef } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Animated, ActivityIndicator, Image } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { getMemberName, getAvatarUrl } from '../utils/api';
import { useTheme } from '../context/ThemeContext';
import Avatar from './Avatar';

function GlowRing({ active, size = 58, colors, children }) {
  const anim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      anim.stopAnimation();
      anim.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1.08, duration: 900, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => { loop.stop(); anim.stopAnimation(); anim.setValue(1); };
  }, [active]);

  return (
    <Animated.View style={{ transform: [{ scale: anim }] }}>
      <View style={[
        styles.ring,
        {
          width: size + 6, height: size + 6, borderRadius: (size + 6) / 2,
          borderWidth: active ? 2.5 : 1.5,
          borderColor: active ? colors.accent : colors.textMuted,
          opacity: active ? 1 : 0.45,
        },
      ]}>
        {children}
      </View>
    </Animated.View>
  );
}

export default function StoriesStrip({ stories, onAdd, onView, pendingStories = [], onPendingPress }) {
  const { colors } = useTheme();
  const me = getMemberName();

  const grouped = {};
  for (const s of stories) {
    if (!grouped[s.author]) grouped[s.author] = [];
    grouped[s.author].push(s);
  }
  const items = Object.entries(grouped).map(([author, storyList]) => {
    const hasUnwatched = storyList.some((s) => !(s.views || []).some((v) => v.viewer === me));
    return { author, stories: storyList, isMe: author === me, hasUnwatched };
  });
  items.sort((a, b) => (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0));

  const pendingItems = pendingStories.map((p) => ({ isPending: true, pending: p }));

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      <FlatList
        data={[{ isAdd: true }, ...pendingItems, ...items]}
        keyExtractor={(item) => item.isAdd ? '__add__' : item.isPending ? item.pending.id : item.author}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          if (item.isAdd) {
            return (
              <TouchableOpacity style={styles.item} onPress={onAdd}>
                <View style={[styles.addCircle, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.addPlus, { color: colors.text }]}>+</Text>
                </View>
                <Text style={[styles.label, { color: colors.textSub }]}>Your daily</Text>
              </TouchableOpacity>
            );
          }
          if (item.isPending) {
            const failed = item.pending.status === 'failed';
            return (
              <TouchableOpacity style={styles.item} onPress={() => onPendingPress?.(item.pending)} activeOpacity={failed ? 0.7 : 1}>
                <View style={[styles.pendingCircle, { backgroundColor: colors.card, borderColor: failed ? '#e53935' : colors.accent }]}>
                  {item.pending.payload?.previewUri && (
                    <Image source={{ uri: item.pending.payload.previewUri }} style={styles.pendingThumb} />
                  )}
                  <View style={styles.pendingOverlay}>
                    {failed
                      ? <Feather name="alert-triangle" size={18} color="#ff6b6b" />
                      : <ActivityIndicator size="small" color="#fff" />}
                  </View>
                </View>
                <Text style={[styles.label, { color: failed ? '#e53935' : colors.textSub }]}>
                  {failed ? 'Tap to retry' : 'Posting…'}
                </Text>
              </TouchableOpacity>
            );
          }
          return (
            <TouchableOpacity style={styles.item} onPress={() => onView(item.stories)}>
              <GlowRing active={item.hasUnwatched} colors={colors}>
                <Avatar name={item.author} uri={getAvatarUrl(item.author)} size={52} />
              </GlowRing>
              <Text style={[styles.label, { color: item.hasUnwatched ? colors.text : colors.textSub }]} numberOfLines={1}>
                {item.isMe ? 'You' : item.author.split(' ')[0]}
              </Text>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { height: 100, borderBottomWidth: 1 },
  list: { paddingHorizontal: 12, alignItems: 'center', gap: 4 },
  item: { alignItems: 'center', width: 68, gap: 4 },
  addCircle: {
    width: 58, height: 58, borderRadius: 29, borderWidth: 1,
    borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center',
  },
  addPlus: { fontSize: 26, lineHeight: 30, fontWeight: '200' },
  pendingCircle: {
    width: 58, height: 58, borderRadius: 29, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  pendingThumb: { ...StyleSheet.absoluteFillObject, opacity: 0.55 },
  pendingOverlay: { alignItems: 'center', justifyContent: 'center' },
  ring: { alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 10, textAlign: 'center', maxWidth: 64, fontWeight: '500' },
});
