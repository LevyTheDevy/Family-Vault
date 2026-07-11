import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import Avatar from '../components/Avatar';
import CachedImage from '../components/CachedImage';
import {
  fetchNotifications, markNotificationsSeen, fetchConversations, getAvatarUrl,
} from '../utils/api';
import { useTheme } from '../context/ThemeContext';
import { useUnread } from '../context/UnreadContext';

function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const VERBS = {
  like: 'liked your post',
  comment: 'commented on your post',
  post: 'shared a new post',
};

export default function NotificationsScreen({ navigation }) {
  const { colors } = useTheme();
  const { refresh } = useUnread();
  const [items, setItems] = useState([]);
  const [unreadConvos, setUnreadConvos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const [notifs, convos] = await Promise.all([
      fetchNotifications().catch(() => null),
      fetchConversations().catch(() => null),
    ]);
    // Keep last known content on a failed fetch instead of wiping to empty
    if (notifs) setItems(notifs);
    if (convos) setUnreadConvos(convos.filter((c) => (c.unreadCount || 0) > 0));
    // Only clear the bell badge when the list actually rendered
    if (notifs) markNotificationsSeen().then(refresh).catch(() => {});
  };

  useFocusEffect(useCallback(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, []));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openChat = (conversation) => {
    navigation.navigate('Messages', { screen: 'Chat', params: { conversation } });
  };

  // Unread chats first, then activity — one list, two row shapes
  const data = [
    ...unreadConvos.map((c) => ({ kind: 'convo', key: `c${c.id}`, convo: c })),
    ...items.map((n) => ({ kind: 'notif', key: `n${n.id}`, notif: n })),
  ];

  const renderItem = ({ item }) => {
    if (item.kind === 'convo') {
      const c = item.convo;
      return (
        <TouchableOpacity
          style={[styles.row, { borderBottomColor: colors.border }]}
          onPress={() => openChat(c)}
          activeOpacity={0.7}
        >
          <View style={[styles.msgIcon, { backgroundColor: colors.accent }]}>
            <Feather name="message-square" size={18} color={colors.accentText} />
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
              {c.name || 'Group chat'}
            </Text>
            <Text style={[styles.rowSub, { color: colors.textSub }]}>
              {c.unreadCount} unread message{c.unreadCount > 1 ? 's' : ''}
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={colors.textSub} />
        </TouchableOpacity>
      );
    }
    const n = item.notif;
    return (
      <View style={[styles.row, { borderBottomColor: colors.border }]}>
        <Avatar name={n.actor} uri={getAvatarUrl(n.actor)} size={40} />
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={2}>
            <Text style={{ fontWeight: '700' }}>{n.actor}</Text>
            {' '}{VERBS[n.type] || n.type}
          </Text>
          <Text style={[styles.rowSub, { color: colors.textSub }]}>{timeAgo(n.createdAt)}</Text>
        </View>
        {!n.seen && <View style={[styles.dot, { backgroundColor: colors.accent }]} />}
        {n.thumbUrl && <CachedImage uri={n.thumbUrl} style={styles.thumb} resizeMode="cover" />}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.screenBg }]}>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : data.length === 0 ? (
        <View style={styles.center}>
          <Feather name="bell-off" size={32} color={colors.textSub} />
          <Text style={[styles.emptyText, { color: colors.text }]}>Nothing yet</Text>
          <Text style={[styles.emptySub, { color: colors.textSub }]}>
            Likes, comments, new posts and messages will show up here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(i) => i.key}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32 },
  emptyText: { fontSize: 16, fontWeight: '600' },
  emptySub: { fontSize: 13, textAlign: 'center' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 14, lineHeight: 19 },
  rowSub: { fontSize: 12 },
  msgIcon: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  thumb: { width: 44, height: 44, borderRadius: 6 },
});
