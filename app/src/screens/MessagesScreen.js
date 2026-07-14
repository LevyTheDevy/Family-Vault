import React, { useState, useCallback, useLayoutEffect, useEffect, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, Modal, TextInput, ActivityIndicator, RefreshControl, ScrollView,
  KeyboardAvoidingView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import {
  fetchConversations, createConversation, startDM,
  fetchFamilyMembers, deleteConversation, getMemberName, getAvatarUrl,
  onConversationRead,
} from '../utils/api';
import { useTheme } from '../context/ThemeContext';
import { useUnread } from '../context/UnreadContext';
import Avatar from '../components/Avatar';

function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function MessagesScreen({ navigation }) {
  const { colors } = useTheme();
  const { updateFromConversations } = useUnread();
  const [conversations, setConversations] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const me = getMemberName();
  const lastFetchRef = useRef(0);
  const fetchingRef = useRef(false);
  const STALE_MS = 20_000;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => setShowNew(true)}
          hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
          accessibilityRole="button"
          accessibilityLabel="New group chat"
        >
          <Feather name="users" size={18} color={colors.text} />
        </TouchableOpacity>
      ),
    });
  }, [navigation, colors]);

  const loadConvos = async () => {
    // Keep the last known list on a failed fetch — never wipe it to empty
    try {
      const data = await fetchConversations();
      setConversations(data);
      updateFromConversations(data);
    } catch {}
  };

  const loadMembers = async () => {
    try {
      const data = await fetchFamilyMembers();
      setMembers(data.filter((m) => m.name !== me));
    } catch {}
  };

  // Opening a chat marks it read — zero its row here immediately so the list
  // is correct even within the 20s refetch window
  useEffect(() => onConversationRead((convoId) => {
    setConversations((prev) => prev.map((c) => c.id === convoId ? { ...c, unreadCount: 0 } : c));
  }), []);

  useFocusEffect(useCallback(() => {
    if (fetchingRef.current) return;
    const stale = Date.now() - lastFetchRef.current > STALE_MS;
    if (!stale && lastFetchRef.current > 0) return;

    fetchingRef.current = true;
    setLoading(true);
    Promise.all([loadConvos(), loadMembers()])
      .finally(() => { lastFetchRef.current = Date.now(); fetchingRef.current = false; setLoading(false); });
  }, []));

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadConvos(), loadMembers()]);
    lastFetchRef.current = Date.now();
    setRefreshing(false);
  };

  const handleDeleteConversation = (item) => {
    Alert.alert(
      'Delete conversation?',
      `"${item.name}" and all its messages will be removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            try {
              await deleteConversation(item.id);
              await loadConvos();
            } catch (e) {
              Alert.alert('Error', e.message);
            }
          },
        },
      ],
    );
  };

  const handleOpenDM = async (memberName) => {
    // Reuse existing DM from local list to avoid duplicate creation
    const existing = conversations.find(
      (c) => c.isDM && (c.memberNames || []).includes(memberName) && (c.memberNames || []).includes(me),
    );
    if (existing) {
      navigation.navigate('Chat', { conversation: { ...existing, name: memberName } });
      return;
    }
    try {
      const convo = await startDM(memberName);
      await loadConvos();
      navigation.navigate('Chat', { conversation: convo });
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  useEffect(() => {
    if (showNew) setSelected(new Set());
  }, [showNew]);

  const toggleSelected = (name) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const handleCreateGroup = async () => {
    if (!newName.trim() || selected.size === 0) return;
    setCreating(true);
    try {
      const memberNames = [me, ...members.filter((m) => selected.has(m.name)).map((m) => m.name)];
      const convo = await createConversation(newName.trim(), memberNames);
      setShowNew(false);
      setNewName('');
      await loadConvos();
      navigation.navigate('Chat', { conversation: convo });
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally { setCreating(false); }
  };

  const renderConversation = ({ item }) => {
    const last = item.lastMessage;
    const hasMedia = last && (last.imageUrl || last.videoUrl || last.gifUrl);
    const preview = last
      ? `${last.author === me ? 'You' : last.author}: ${hasMedia ? (last.imageUrl ? '[Photo]' : last.videoUrl ? '[Video]' : '[GIF]') : last.text || ''}`
      : 'No messages yet';
    const unread = item.unreadCount || 0;

    return (
      <TouchableOpacity
        style={[styles.row, { borderBottomColor: colors.border }]}
        onPress={() => navigation.navigate('Chat', { conversation: item })}
        onLongPress={() => handleDeleteConversation(item)}
        activeOpacity={0.7}
        delayLongPress={400}
      >
        <View style={[styles.rowAvatar, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name={item.isDM ? 'user' : 'users'} size={18} color={colors.textSub} />
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={[styles.rowName, { color: colors.text }, unread > 0 && styles.rowNameUnread]} numberOfLines={1}>
              {item.name}
            </Text>
            <View style={styles.rowTopRight}>
              {last && <Text style={[styles.rowTime, { color: colors.textSub }]}>{timeAgo(last.createdAt)}</Text>}
              {unread > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
                </View>
              )}
            </View>
          </View>
          <Text style={[styles.rowPreview, { color: unread > 0 ? colors.text : colors.textSub }, unread > 0 && styles.rowPreviewUnread]} numberOfLines={1}>
            {preview}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const dms = conversations.filter((c) => c.isDM);
  const groups = conversations.filter((c) => !c.isDM);

  return (
    <View style={[styles.container, { backgroundColor: colors.screenBg }]}>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : (
        <FlatList
          data={groups}
          keyExtractor={(c) => String(c.id)}
          renderItem={renderConversation}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
          ListHeaderComponent={
            <View>
              {members.length > 0 && (
                <View style={[styles.membersSection, { borderBottomColor: colors.border }]}>
                  <Text style={[styles.membersLabel, { color: colors.textSub }]}>Direct Messages</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.membersScroll}>
                    {members.map((m) => {
                      const existingDM = dms.find((c) => (c.memberNames || []).includes(m.name));
                      const unread = existingDM?.unreadCount || 0;
                      return (
                        <TouchableOpacity key={m.id} style={styles.memberChip} onPress={() => handleOpenDM(m.name)}>
                          <View style={styles.dmAvatarWrap}>
                            <Avatar
                              name={m.name}
                              uri={getAvatarUrl(m.name)}
                              size={52}
                              style={{ borderWidth: 1.5, borderColor: unread > 0 ? colors.accent : colors.border }}
                            />
                            {unread > 0 && <View style={styles.dmBadge}><Text style={styles.dmBadgeText}>{unread > 9 ? '9+' : unread}</Text></View>}
                          </View>
                          <Text style={[styles.memberName, { color: unread > 0 ? colors.text : colors.textSub }]} numberOfLines={1}>{m.name}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}
              {groups.length > 0 && (
                <Text style={[styles.groupsLabel, { color: colors.textSub, borderTopColor: colors.border }]}>Group Chats</Text>
              )}
            </View>
          }
          ListEmptyComponent={
            groups.length === 0 ? (
              <View style={styles.center}>
                <Text style={[styles.emptyText, { color: colors.textSub }]}>No group chats yet</Text>
                <Text style={[styles.emptySub, { color: colors.textMuted }]}>Tap the group icon to create one</Text>
              </View>
            ) : null
          }
        />
      )}

      <Modal visible={showNew} transparent animationType="slide" onRequestClose={() => setShowNew(false)}>
        {/* behavior="padding" keeps the sheet above the keyboard — transparent
            Android modals don't get resized by the system */}
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior="padding">
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => { setShowNew(false); setNewName(''); }} />
          <View style={[styles.modalSheet, { backgroundColor: colors.card }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>New Group Chat</Text>
            <Text style={[styles.modalSub, { color: colors.textSub }]}>You're included automatically</Text>
            <TextInput
              style={[styles.modalInput, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
              placeholder="Group name"
              placeholderTextColor={colors.textSub}
              value={newName}
              onChangeText={setNewName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleCreateGroup}
            />
            <Text style={[styles.pickLabel, { color: colors.textSub }]}>
              Members — tap to add ({selected.size} selected)
            </Text>
            <ScrollView style={styles.memberPicker} keyboardShouldPersistTaps="handled">
              {members.map((m) => {
                const on = selected.has(m.name);
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.pickRow, { borderBottomColor: colors.border }]}
                    onPress={() => toggleSelected(m.name)}
                    activeOpacity={0.7}
                  >
                    <Avatar name={m.name} uri={getAvatarUrl(m.name)} size={32} />
                    <Text style={[styles.pickName, { color: colors.text }]}>{m.name}</Text>
                    <Feather name={on ? 'check-circle' : 'circle'} size={20} color={on ? colors.accent : colors.textSub} />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={[styles.modalCancel, { borderColor: colors.border }]} onPress={() => { setShowNew(false); setNewName(''); }}>
                <Text style={[styles.modalCancelText, { color: colors.textSub }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalCreate, { backgroundColor: colors.accent }, (!newName.trim() || creating || selected.size === 0) && styles.modalCreateDisabled]}
                onPress={handleCreateGroup}
                disabled={!newName.trim() || creating || selected.size === 0}
              >
                {creating
                  ? <ActivityIndicator color={colors.accentText} size="small" />
                  : <Text style={[styles.modalCreateText, { color: colors.accentText }]}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerBtn: { marginRight: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 60 },
  emptyText: { fontSize: 15, fontWeight: '600' },
  emptySub: { fontSize: 13, textAlign: 'center', paddingHorizontal: 32 },

  membersSection: { paddingTop: 16, borderBottomWidth: 0 },
  membersLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: 18, marginBottom: 12 },
  membersScroll: { paddingHorizontal: 14, paddingBottom: 16, gap: 16 },
  memberChip: { alignItems: 'center', gap: 6, width: 62 },
  memberName: { fontSize: 11, textAlign: 'center' },
  dmAvatarWrap: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  dmBadge: {
    position: 'absolute', top: 0, right: 0,
    minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: '#e53935', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  dmBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  groupsLabel: {
    fontSize: 11, fontWeight: '600', textTransform: 'uppercase',
    letterSpacing: 0.8, paddingHorizontal: 18, marginBottom: 4,
    borderTopWidth: 1, paddingTop: 16,
  },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 14, paddingHorizontal: 18,
    borderBottomWidth: 1,
  },
  rowAvatar: {
    width: 46, height: 46, borderRadius: 23,
    borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  rowTopRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { fontSize: 15, fontWeight: '500', flex: 1, marginRight: 8 },
  rowNameUnread: { fontWeight: '700' },
  rowTime: { fontSize: 12 },
  rowPreview: { fontSize: 13 },
  rowPreviewUnread: { fontWeight: '500' },

  badge: {
    minWidth: 20, height: 20, borderRadius: 10,
    backgroundColor: '#e53935', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 24, paddingBottom: 40, gap: 12 },
  modalTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  modalSub: { fontSize: 13, textAlign: 'center', marginTop: -4 },
  modalInput: { borderWidth: 1, borderRadius: 8, padding: 14, fontSize: 15, marginTop: 4 },
  pickLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 4 },
  // flexShrink lets the list yield to the keyboard instead of clipping
  memberPicker: { maxHeight: 240, flexGrow: 0, flexShrink: 1 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  pickName: { flex: 1, fontSize: 14 },
  modalButtons: { flexDirection: 'row', gap: 10, marginTop: 4 },
  modalCancel: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  modalCancelText: { fontSize: 14 },
  modalCreate: { flex: 1, borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  modalCreateDisabled: { opacity: 0.3 },
  modalCreateText: { fontWeight: '700', fontSize: 14 },
});
