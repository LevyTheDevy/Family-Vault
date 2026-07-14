import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Keyboard, Dimensions, Alert, Modal,
  Animated, PanResponder,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import CachedImage from '../components/CachedImage';
import { Video, ResizeMode } from 'expo-av';
import {
  fetchMessages, fetchMessagesDigest, sendMessage, getMemberName, deleteConversation,
  addConversationMember, removeConversationMember, fetchFamilyMembers,
  sendChatMedia, markConversationRead, deleteChatMessage, getAvatarUrl,
  reactToMessage, isGifEnabled,
} from '../utils/api';
import GifPickerModal from '../components/GifPickerModal';
import Avatar from '../components/Avatar';
import { useTheme } from '../context/ThemeContext';
import { useUnread } from '../context/UnreadContext';

const POLL_MS = 3000;
const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '🔥', '👏'];

function fmt(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function insertDateSeparators(messages) {
  const result = [];
  let lastDate = null;
  for (const msg of messages) {
    const day = new Date(msg.createdAt).toDateString();
    if (day !== lastDate) {
      result.push({ type: 'separator', id: `sep-${msg.id}`, date: msg.createdAt });
      lastDate = day;
    }
    result.push({ type: 'message', ...msg });
  }
  return result;
}

function ReadReceipt({ allRead, someSeen, accentColor, mutedColor }) {
  const color = allRead ? accentColor : mutedColor;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
      <Feather name="check" size={11} color={color} />
      {(someSeen || allRead) && (
        <Feather name="check" size={11} color={color} style={{ marginLeft: -5 }} />
      )}
    </View>
  );
}

// Swipeable message row — swipe right to reply
function SwipeRow({ onReply, children }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_, g) => {
        if (g.dx > 0 && g.dx < 70) translateX.setValue(g.dx);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx > 45) onReply?.();
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 10 }).start();
      },
    })
  ).current;

  return (
    <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
      {children}
    </Animated.View>
  );
}

export default function ChatScreen({ route, navigation }) {
  const { conversation } = route.params;
  const { colors, isLight } = useTheme();
  const { refresh: refreshBadges } = useUnread();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [keyboardH, setKeyboardH] = useState(0);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [previewMedia, setPreviewMedia] = useState(null);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [groupMembers, setGroupMembers] = useState(conversation.memberNames || []);
  const [allMembers, setAllMembers] = useState([]);
  const [replyTo, setReplyTo] = useState(null); // { id, author, text }
  const [contextMsg, setContextMsg] = useState(null); // message with emoji picker open
  const [mentionQuery, setMentionQuery] = useState(null);
  const listRef = useRef();
  const inputRef = useRef();
  const pollRef = useRef();
  const mountedRef = useRef(true);
  const me = getMemberName();
  const insets = useSafeAreaInsets();
  const originalWindowH = useRef(Dimensions.get('window').height);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  const isGroupChat = !conversation.isDM;
  const isCreator = conversation.createdBy === me;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row', gap: 16, marginRight: 16 }}>
          {isGroupChat && (
            <TouchableOpacity
              onPress={() => {
                fetchFamilyMembers().then(setAllMembers).catch(() => {});
                setShowGroupInfo(true);
              }}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Group members"
            >
              <Feather name="users" size={18} color={colors.text} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleDelete} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <Text style={{ color: '#ff4444', fontSize: 14 }}>Delete</Text>
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, conversation, isGroupChat, colors]);

  const handleDelete = () => {
    Alert.alert('Delete conversation?', 'All messages will be permanently removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try { await deleteConversation(conversation.id); navigation.goBack(); }
          catch (e) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  // Cheap change fingerprint: id + read count + reaction count per message.
  // Polls fetch the same 200 messages every 3s; when nothing changed we skip
  // setMessages entirely so the list doesn't re-render, and skip the
  // redundant mark-read round trip.
  const lastFpRef = useRef('');
  const pollBusyRef = useRef(false);
  // Server-side digest: polls fetch ~100 bytes and only do the full messages
  // fetch when it changes. The stored digest is always the PRE-fetch snapshot,
  // so a change landing between digest and full fetch costs one extra fetch —
  // never a permanent miss. Old servers (404) fall back to full polling.
  const digestRef = useRef('');
  const digestSupportedRef = useRef(true);
  const fingerprint = (msgs) => msgs.map((m) =>
    `${m.id}:${m.readBy?.length || 0}:${Object.values(m.reactions || {}).reduce((s, a) => s + a.length, 0)}`
  ).join('|');

  const load = async (silent = false) => {
    // On a slow tunnel one fetch can outlive the 3s poll interval — skip the
    // tick instead of stacking requests that can resolve out of order
    if (silent && pollBusyRef.current) return;
    pollBusyRef.current = true;
    try {
      let pendingDigest = null;
      if (silent && digestSupportedRef.current) {
        try {
          const d = await fetchMessagesDigest(conversation.id);
          if (d?.digest && d.digest === digestRef.current) return; // nothing changed
          pendingDigest = d?.digest || null;
        } catch {
          digestSupportedRef.current = false;
        }
      }
      const data = await fetchMessages(conversation.id);
      if (!mountedRef.current) return;
      if (pendingDigest) digestRef.current = pendingDigest;
      const fp = fingerprint(data);
      if (silent && fp === lastFpRef.current) return;
      lastFpRef.current = fp;
      setMessages(data);
      if (!silent) setLoading(false);
      // Refresh badges once the server confirms the read, so the unread
      // count drops without needing a manual refresh on the Messages screen
      markConversationRead(conversation.id).then(refreshBadges).catch(() => {});
    } catch { if (mountedRef.current && !silent) setLoading(false); }
    finally { pollBusyRef.current = false; }
  };

  useEffect(() => {
    mountedRef.current = true;
    load();
    pollRef.current = setInterval(() => load(true), POLL_MS);
    return () => { mountedRef.current = false; clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    const TAB_BAR_H = () => 58 + insetsRef.current.bottom;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      const screenH = Dimensions.get('screen').height;
      const currentWindowH = Dimensions.get('window').height;
      const alreadyHandled = Math.max(0, originalWindowH.current - currentWindowH);
      const totalOverlap = Math.max(0, (screenH - e.endCoordinates.screenY) - TAB_BAR_H());
      setKeyboardH(Math.max(0, totalOverlap - alreadyHandled));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardH(0);
      originalWindowH.current = Dimensions.get('window').height;
    });
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Only auto-scroll to new messages when the user is already at (or near)
  // the bottom — never yank them away while they're reading history.
  // Own sends always scroll (nearBottomRef is forced true first).
  const nearBottomRef = useRef(true);
  const handleScroll = (e) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    nearBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 120;
  };

  useEffect(() => {
    if (messages.length > 0 && nearBottomRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
    }
  }, [messages.length]);

  const handleTextChange = (val) => {
    setText(val);
    const match = val.match(/@(\w*)$/);
    setMentionQuery(match ? match[1] : null);
  };

  const insertMention = (name) => {
    const newText = text.replace(/@\w*$/, `@${name} `);
    setText(newText);
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  const mentionSuggestions = mentionQuery !== null && isGroupChat
    ? groupMembers.filter((n) => n.toLowerCase().startsWith(mentionQuery.toLowerCase()) && n.toLowerCase() !== me.toLowerCase())
    : [];

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    const prevReply = replyTo;
    const replyId = replyTo?.id || null;
    setSending(true);
    setText('');
    setReplyTo(null);
    setMentionQuery(null);
    nearBottomRef.current = true;
    try {
      const msg = await sendMessage(conversation.id, trimmed, null, replyId);
      setMessages((prev) => [...prev, msg]);
      markConversationRead(conversation.id).catch(() => {});
    } catch {
      // Restore the draft AND the reply target so nothing is lost
      setText(trimmed);
      setReplyTo(prevReply);
    }
    finally { setSending(false); }
  };

  const handleSendGif = async (gif) => {
    setShowGifPicker(false);
    setSending(true);
    nearBottomRef.current = true;
    try {
      const msg = await sendMessage(conversation.id, '', gif.gifUrl);
      setMessages((prev) => [...prev, msg]);
    } catch { Alert.alert('Error', 'Could not send GIF. Check your connection.'); }
    finally { setSending(false); }
  };

  const handleSendMedia = async (uri, mimeType) => {
    setShowAttachMenu(false);
    setSending(true);
    nearBottomRef.current = true;
    try {
      const msg = await sendChatMedia(conversation.id, uri, mimeType);
      setMessages((prev) => [...prev, msg]);
    } catch (e) { Alert.alert('Error', e.message); }
    finally { setSending(false); }
  };

  const handleDeleteMessage = (msgId) => {
    setContextMsg(null);
    Alert.alert('Delete message?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await deleteChatMessage(conversation.id, msgId);
            setMessages((prev) => prev.filter((m) => m.id !== msgId));
          } catch (e) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  const handleReact = async (msg, emoji) => {
    setContextMsg(null);
    try {
      const updated = await reactToMessage(conversation.id, msg.id, emoji);
      setMessages((prev) => prev.map((m) => m.id === updated.id ? { ...m, reactions: updated.reactions } : m));
    } catch { }
  };

  const openGallery = async () => {
    setShowAttachMenu(false);
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permission needed');
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.85, videoMaxDuration: 120 });
    if (!r.canceled) {
      const asset = r.assets[0];
      const isVideo = asset.type === 'video';
      const ext = asset.uri.split('.').pop()?.toLowerCase() || (isVideo ? 'mp4' : 'jpg');
      await handleSendMedia(asset.uri, isVideo ? `video/${ext === 'mov' ? 'quicktime' : ext}` : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
    }
  };

  const openCamera = async () => {
    setShowAttachMenu(false);
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Camera permission needed');
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.85 });
    if (!r.canceled) {
      const asset = r.assets[0];
      const isVideo = asset.type === 'video';
      const ext = asset.uri.split('.').pop()?.toLowerCase() || (isVideo ? 'mp4' : 'jpg');
      await handleSendMedia(asset.uri, isVideo ? `video/${ext === 'mov' ? 'quicktime' : ext}` : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
    }
  };

  const items = insertDateSeparators(messages);
  // groupMembers tracks live add/remove; the route param is a snapshot
  const totalMembers = groupMembers.length || conversation.memberNames?.length || 2;

  if (loading) {
    return <View style={[styles.center, { backgroundColor: colors.screenBg }]}><ActivityIndicator color={colors.text} /></View>;
  }

  const bubbleMeColor = colors.accent;
  const bubbleMeText = '#ffffff';
  const bubbleOtherColor = colors.bubble;
  const bubbleOtherText = colors.bubbleText;

  return (
    <View style={[styles.container, { backgroundColor: colors.screenBg, paddingBottom: keyboardH }]}>
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => String(item.id)}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        scrollEventThrottle={100}
        onContentSizeChange={() => { if (nearBottomRef.current) listRef.current?.scrollToEnd({ animated: false }); }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={[styles.emptyText, { color: colors.textSub }]}>No messages yet</Text>
            <Text style={[styles.emptySub, { color: colors.textMuted }]}>Start the conversation</Text>
          </View>
        }
        renderItem={({ item, index }) => {
          if (item.type === 'separator') {
            return (
              <View style={styles.dateSep}>
                <View style={[styles.dateLine, { backgroundColor: colors.border }]} />
                <Text style={[styles.dateText, { color: colors.textSub }]}>{fmtDate(item.date)}</Text>
                <View style={[styles.dateLine, { backgroundColor: colors.border }]} />
              </View>
            );
          }

          const isMe = item.author === me;
          const prevItem = items[index - 1];
          const nextItem = items[index + 1];
          const sameAuthorAsPrev = prevItem?.type === 'message' && prevItem.author === item.author;
          const sameAuthorAsNext = nextItem?.type === 'message' && nextItem.author === item.author;

          const readBy = item.readBy || [item.author];
          const allRead = isMe && readBy.length >= totalMembers;
          const someSeen = isMe && readBy.length > 1;

          const reactions = item.reactions || {};
          const reactionEntries = Object.entries(reactions).filter(([, users]) => users.length > 0);

          // Tail radius adjustments (grouped bubbles reduce corner radius)
          const tailMe = !sameAuthorAsNext ? 4 : 18;
          const tailOther = !sameAuthorAsNext ? 4 : 18;

          const bgColor = isMe ? bubbleMeColor : bubbleOtherColor;
          const txtColor = isMe ? bubbleMeText : bubbleOtherText;

          return (
            <View style={{ marginBottom: sameAuthorAsNext ? 2 : 8 }}>
              {/* Reply preview bar */}
              {item.replyPreview && (
                <View style={[
                  styles.replyPreviewBar,
                  isMe ? styles.replyPreviewBarMe : styles.replyPreviewBarOther,
                  { borderLeftColor: isMe ? 'rgba(255,255,255,0.6)' : colors.accent, backgroundColor: isMe ? 'rgba(255,255,255,0.15)' : colors.card },
                ]}>
                  <Text style={[styles.replyPreviewAuthor, { color: isMe ? 'rgba(255,255,255,0.8)' : colors.accent }]} numberOfLines={1}>
                    {item.replyPreview.author}
                  </Text>
                  <Text style={[styles.replyPreviewText, { color: isMe ? 'rgba(255,255,255,0.7)' : colors.textSub }]} numberOfLines={1}>
                    {item.replyPreview.text || '📷 Media'}
                  </Text>
                </View>
              )}

              <SwipeRow onReply={() => setReplyTo({ id: item.id, author: item.author, text: item.text })}>
                <View style={[styles.msgRow, isMe ? styles.msgRowMe : styles.msgRowOther]}>
                  {!isMe && (
                    <View style={styles.avatarCol}>
                      {!sameAuthorAsPrev
                        ? <Avatar name={item.author} uri={getAvatarUrl(item.author)} size={30} />
                        : <View style={{ width: 30 }} />
                      }
                    </View>
                  )}

                  <TouchableOpacity
                    activeOpacity={0.85}
                    onLongPress={() => setContextMsg(item)}
                    delayLongPress={400}
                    style={{ maxWidth: '80%' }}
                  >
                    <View style={[
                      styles.bubble,
                      {
                        backgroundColor: bgColor,
                        borderBottomRightRadius: isMe ? tailMe : 18,
                        borderBottomLeftRadius: isMe ? 18 : tailOther,
                        borderWidth: isMe ? 0 : (isLight ? 1 : 0),
                        borderColor: colors.border,
                      },
                    ]}>
                      {!isMe && isGroupChat && !sameAuthorAsPrev && (
                        <Text style={[styles.bubbleAuthor, { color: bubbleMeColor }]}>{item.author}</Text>
                      )}

                      {item.postRef ? (
                        <TouchableOpacity
                          activeOpacity={item.postRef.isRestricted || !item.postRef.imageUrl ? 1 : 0.85}
                          onPress={() => {
                            if (!item.postRef.isRestricted && item.postRef.imageUrl)
                              setPreviewMedia({ uri: item.postRef.imageUrl, type: 'image' });
                          }}
                        >
                          <View style={styles.postRefCard}>
                            {item.postRef.isRestricted ? (
                              <View style={[styles.postRefThumb, { backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center', gap: 6 }]}>
                                <Feather name="lock" size={22} color="rgba(255,255,255,0.55)" />
                                <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>Content restricted</Text>
                              </View>
                            ) : item.postRef.imageUrl ? (
                              <CachedImage uri={item.postRef.imageUrl} style={styles.postRefThumb} resizeMode="cover" />
                            ) : null}
                            <View style={styles.postRefMeta}>
                              <Text style={[styles.postRefAuthor, { color: isMe ? 'rgba(255,255,255,0.9)' : colors.text }]}>
                                {item.postRef.author}
                              </Text>
                              {!!item.postRef.caption && (
                                <Text style={[styles.postRefCaption, { color: isMe ? 'rgba(255,255,255,0.7)' : colors.textSub }]} numberOfLines={2}>
                                  {item.postRef.caption}
                                </Text>
                              )}
                            </View>
                          </View>
                        </TouchableOpacity>
                      ) : item.gifUrl ? (
                        <TouchableOpacity activeOpacity={0.9} onPress={() => setPreviewMedia({ uri: item.gifUrl, type: 'gif' })}>
                          <ExpoImage source={{ uri: item.gifUrl }} style={styles.msgMedia} contentFit="cover" autoplay />
                        </TouchableOpacity>
                      ) : item.imageUrl ? (
                        <TouchableOpacity activeOpacity={0.9} onPress={() => setPreviewMedia({ uri: item.imageUrl, type: 'image' })}>
                          <CachedImage uri={item.imageUrl} style={styles.msgMedia} resizeMode="cover" />
                        </TouchableOpacity>
                      ) : item.videoUrl ? (
                        <TouchableOpacity activeOpacity={0.9} onPress={() => setPreviewMedia({ uri: item.videoUrl, type: 'video' })}>
                          <View style={styles.msgMedia}>
                            <Video source={{ uri: item.videoUrl }} style={StyleSheet.absoluteFillObject} resizeMode={ResizeMode.COVER} shouldPlay={false} isMuted />
                            <View style={styles.msgVidPlay}><Feather name="play" size={20} color="#fff" /></View>
                          </View>
                        </TouchableOpacity>
                      ) : null}

                      {item.text ? (
                        <Text style={[styles.bubbleText, { color: txtColor }]}>
                          {item.text.split(/(@\w+)/g).map((part, i) =>
                            /^@\w+$/.test(part)
                              ? <Text key={i} style={{ fontWeight: '700' }}>{part}</Text>
                              : part
                          )}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                </View>
              </SwipeRow>

              <View style={[styles.msgMeta, isMe ? styles.msgMetaMe : styles.msgMetaOther]}>
                <Feather name="lock" size={9} color={colors.textSub} style={{ marginRight: 2, opacity: 0.6 }} />
                <Text style={[styles.metaTime, { color: colors.textSub }]}>{fmt(item.createdAt)}</Text>
                {isMe && <ReadReceipt allRead={allRead} someSeen={someSeen} accentColor={colors.accent} mutedColor={colors.textSub} />}
              </View>

              {/* Reaction pills */}
              {reactionEntries.length > 0 && (
                <View style={[styles.reactionsRow, isMe ? styles.reactionsRowMe : styles.reactionsRowOther]}>
                  {reactionEntries.map(([emoji, users]) => (
                    <TouchableOpacity
                      key={emoji}
                      style={[styles.reactionPill, { backgroundColor: users.includes(me) ? (isLight ? '#e8f0fe' : '#1a2a3a') : (isLight ? '#f0f0f5' : '#1e1e1e'), borderColor: users.includes(me) ? bubbleMeColor : colors.border }]}
                      onPress={() => handleReact(item, emoji)}
                    >
                      <Text style={styles.reactionEmoji}>{emoji}</Text>
                      {users.length > 1 && <Text style={[styles.reactionCount, { color: colors.textSub }]}>{users.length}</Text>}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          );
        }}
      />

      {/* Reaction + context menu modal */}
      {contextMsg && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setContextMsg(null)} statusBarTranslucent>
          <TouchableOpacity style={styles.contextBackdrop} activeOpacity={1} onPress={() => setContextMsg(null)}>
            <View style={[styles.contextSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              {/* Quick emoji row */}
              <View style={styles.emojiRow}>
                {QUICK_EMOJIS.map((e) => {
                  const alreadyReacted = (contextMsg.reactions?.[e] || []).includes(me);
                  return (
                    <TouchableOpacity
                      key={e}
                      style={[styles.emojiBtn, alreadyReacted && { backgroundColor: isLight ? '#e8f0fe' : '#1a2a3a' }]}
                      onPress={() => handleReact(contextMsg, e)}
                    >
                      <Text style={styles.emojiBtnText}>{e}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={[styles.contextDivider, { backgroundColor: colors.border }]} />
              {/* Reply */}
              <TouchableOpacity style={styles.contextAction} onPress={() => {
                setReplyTo({ id: contextMsg.id, author: contextMsg.author, text: contextMsg.text });
                setContextMsg(null);
              }}>
                <Feather name="corner-up-left" size={16} color={colors.text} />
                <Text style={[styles.contextActionText, { color: colors.text }]}>Reply</Text>
              </TouchableOpacity>
              {/* Delete (own messages only) */}
              {contextMsg.author === me && (
                <TouchableOpacity style={styles.contextAction} onPress={() => handleDeleteMessage(contextMsg.id)}>
                  <Feather name="trash-2" size={16} color="#ff4444" />
                  <Text style={[styles.contextActionText, { color: '#ff4444' }]}>Delete</Text>
                </TouchableOpacity>
              )}
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      <GifPickerModal visible={showGifPicker} onClose={() => setShowGifPicker(false)} onSelect={handleSendGif} />

      {/* Media preview */}
      <Modal visible={!!previewMedia} transparent animationType="fade" onRequestClose={() => setPreviewMedia(null)} statusBarTranslucent>
        <View style={styles.previewBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFillObject} activeOpacity={1} onPress={() => setPreviewMedia(null)} />
          {previewMedia?.type === 'gif'
            ? <ExpoImage source={{ uri: previewMedia.uri }} style={styles.previewMedia} contentFit="contain" autoplay />
            : previewMedia?.type === 'video'
              ? <Video source={{ uri: previewMedia.uri }} style={styles.previewMedia} resizeMode={ResizeMode.CONTAIN} shouldPlay useNativeControls isLooping />
              : <CachedImage uri={previewMedia?.uri} style={styles.previewMedia} resizeMode="contain" />
          }
          <TouchableOpacity style={styles.previewClose} onPress={() => setPreviewMedia(null)} hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}>
            <Feather name="x" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Group info modal */}
      {isGroupChat && (
        <Modal visible={showGroupInfo} transparent animationType="slide" onRequestClose={() => setShowGroupInfo(false)} statusBarTranslucent>
          <View style={styles.infoBackdrop}>
            <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setShowGroupInfo(false)} />
            <View style={[styles.infoSheet, { backgroundColor: colors.surface }]}>
              <View style={[styles.infoHandle, { backgroundColor: colors.border }]} />
              <Text style={[styles.infoTitle, { color: colors.text }]}>{conversation.name}</Text>
              <Text style={[styles.infoSub, { color: colors.textSub }]}>{groupMembers.length} members</Text>
              <FlatList
                data={groupMembers}
                keyExtractor={(n) => n}
                // flexShrink makes the list scroll inside the maxHeight sheet
                // instead of clipping past the bottom edge
                style={{ flexGrow: 0, flexShrink: 1 }}
                renderItem={({ item }) => (
                  <View style={[styles.infoMemberRow, { borderBottomColor: colors.border }]}>
                    <Avatar name={item} uri={getAvatarUrl(item)} size={34} />
                    <Text style={[styles.infoMemberName, { color: colors.text }]}>{item}{item === conversation.createdBy ? ' ·  creator' : ''}</Text>
                    {isCreator && item !== me && (
                      <TouchableOpacity onPress={async () => {
                        // Only trust the response if it carries the member list —
                        // never blank the sheet on an old-server response
                        try { const u = await removeConversationMember(conversation.id, item); if (u.memberNames) setGroupMembers(u.memberNames); }
                        catch (e) { Alert.alert('Error', e.message); }
                      }}>
                        <Feather name="user-minus" size={16} color="#ff4444" />
                      </TouchableOpacity>
                    )}
                  </View>
                )}
                ListFooterComponent={isCreator ? (() => {
                  const addable = allMembers.filter((m) => !groupMembers.includes(m.name));
                  return (
                    <>
                      <Text style={[styles.infoAddLabel, { color: colors.textSub, borderTopColor: colors.border }]}>Add members</Text>
                      {addable.length === 0 ? (
                        <Text style={[styles.infoEmptyAdd, { color: colors.textSub }]}>
                          Everyone in the vault is already in this group.
                        </Text>
                      ) : addable.map((m) => (
                        <TouchableOpacity key={m.id} style={[styles.infoMemberRow, { borderBottomColor: colors.border }]} onPress={async () => {
                          try { const u = await addConversationMember(conversation.id, m.name); if (u.memberNames) setGroupMembers(u.memberNames); }
                          catch (e) { Alert.alert('Error', e.message); }
                        }}>
                          <Avatar name={m.name} uri={getAvatarUrl(m.name)} size={34} />
                          <Text style={[styles.infoMemberName, { color: colors.text }]}>{m.name}</Text>
                          <Feather name="plus" size={16} color={colors.text} />
                        </TouchableOpacity>
                      ))}
                    </>
                  );
                })() : null}
              />
            </View>
          </View>
        </Modal>
      )}

      {/* Attach menu */}
      <Modal visible={showAttachMenu} transparent animationType="slide" onRequestClose={() => setShowAttachMenu(false)} statusBarTranslucent>
        <View style={styles.attachBackdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setShowAttachMenu(false)} />
          <View style={[styles.attachSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.attachHandle, { backgroundColor: colors.border }]} />
            <TouchableOpacity style={[styles.attachRow, { borderBottomColor: colors.border }]} onPress={openCamera}>
              <View style={[styles.attachIcon, { backgroundColor: colors.card }]}><Feather name="camera" size={20} color={colors.text} /></View>
              <Text style={[styles.attachLabel, { color: colors.text }]}>Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.attachRow, { borderBottomColor: colors.border }]} onPress={openGallery}>
              <View style={[styles.attachIcon, { backgroundColor: colors.card }]}><Feather name="image" size={20} color={colors.text} /></View>
              <Text style={[styles.attachLabel, { color: colors.text }]}>Photo & Video</Text>
            </TouchableOpacity>
            {isGifEnabled() && (
              <TouchableOpacity style={styles.attachRow} onPress={() => { setShowAttachMenu(false); setShowGifPicker(true); }}>
                <View style={[styles.attachIcon, { backgroundColor: colors.card }]}><Text style={[styles.attachGifLabel, { color: colors.text }]}>GIF</Text></View>
                <Text style={[styles.attachLabel, { color: colors.text }]}>GIF</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>

      {/* Reply-to bar */}
      {replyTo && (
        <View style={[styles.replyBar, { backgroundColor: colors.card, borderTopColor: colors.border, borderLeftColor: bubbleMeColor }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.replyBarAuthor, { color: bubbleMeColor }]}>{replyTo.author}</Text>
            <Text style={[styles.replyBarText, { color: colors.textSub }]} numberOfLines={1}>{replyTo.text || '📷 Media'}</Text>
          </View>
          <TouchableOpacity onPress={() => setReplyTo(null)} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <Feather name="x" size={18} color={colors.textSub} />
          </TouchableOpacity>
        </View>
      )}

      {/* @mention suggestions */}
      {mentionSuggestions.length > 0 && (
        <View style={[styles.mentionList, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {mentionSuggestions.map((name) => (
            <TouchableOpacity
              key={name}
              style={[styles.mentionRow, { borderBottomColor: colors.border }]}
              onPress={() => insertMention(name)}
            >
              <Avatar name={name} uri={getAvatarUrl(name)} size={26} />
              <Text style={[styles.mentionName, { color: colors.text }]}>{name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Input row */}
      <View style={[styles.inputRow, { borderTopColor: colors.border, backgroundColor: colors.surface }]}>
        <TouchableOpacity
          style={[styles.plusBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => setShowAttachMenu(true)}
          hitSlop={{ top: 8, right: 4, bottom: 8, left: 4 }}
          accessibilityRole="button"
          accessibilityLabel="Attach photo, video, or GIF"
        >
          <Feather name="plus" size={20} color={colors.textSub} />
        </TouchableOpacity>
        <TextInput
          ref={inputRef}
          style={[styles.input, { backgroundColor: colors.inputBg, color: colors.text, borderColor: colors.border }]}
          placeholder="Message…  @mention"
          placeholderTextColor={colors.textSub}
          value={text}
          onChangeText={handleTextChange}
          returnKeyType="send"
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          multiline
          maxLength={2000}
        />
        <TouchableOpacity
          style={[styles.sendBtn, { backgroundColor: bubbleMeColor }, (!text.trim() || sending) && styles.sendBtnOff]}
          onPress={handleSend}
          disabled={!text.trim() || sending}
        >
          {sending
            ? <ActivityIndicator color="#fff" size="small" />
            : <Feather name="arrow-up" size={18} color="#fff" />
          }
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 6 },
  emptyText: { fontSize: 15, fontWeight: '600' },
  emptySub: { fontSize: 13 },

  dateSep: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 14 },
  dateLine: { flex: 1, height: 1 },
  dateText: { fontSize: 11, fontWeight: '500' },

  msgRow: { flexDirection: 'row', alignItems: 'flex-end' },
  msgRowMe: { justifyContent: 'flex-end' },
  msgRowOther: { justifyContent: 'flex-start' },

  avatarCol: { marginRight: 6, alignSelf: 'flex-end', marginBottom: 2 },

  bubble: { borderRadius: 18, paddingHorizontal: 13, paddingVertical: 8, maxWidth: '100%', overflow: 'hidden' },
  bubbleAuthor: { fontSize: 11, fontWeight: '700', marginBottom: 2 },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  msgMeta: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2, marginBottom: 1 },
  msgMetaMe: { justifyContent: 'flex-end', paddingRight: 4 },
  msgMetaOther: { justifyContent: 'flex-start', paddingLeft: 36 },
  metaTime: { fontSize: 10 },

  msgMedia: { width: 200, height: 150, borderRadius: 12, marginBottom: 2, backgroundColor: '#111' },
  msgVidPlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },

  // Reply preview inside bubble
  postRefCard: { borderRadius: 8, overflow: 'hidden', marginBottom: 4, width: 200 },
  postRefThumb: { width: '100%', height: 130 },
  postRefMeta: { padding: 8, gap: 2, backgroundColor: 'rgba(0,0,0,0.15)' },
  postRefAuthor: { fontSize: 12, fontWeight: '700' },
  postRefCaption: { fontSize: 12 },
  replyPreviewBar: { borderLeftWidth: 3, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 4, marginHorizontal: 2, maxWidth: '80%' },
  replyPreviewBarMe: { alignSelf: 'flex-end' },
  replyPreviewBarOther: { alignSelf: 'flex-start', marginLeft: 36 },
  replyPreviewAuthor: { fontSize: 11, fontWeight: '700', marginBottom: 1 },
  replyPreviewText: { fontSize: 12 },

  // Reaction pills
  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3, paddingHorizontal: 4 },
  reactionsRowMe: { justifyContent: 'flex-end', paddingRight: 8 },
  reactionsRowOther: { paddingLeft: 36 },
  reactionPill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  reactionEmoji: { fontSize: 14 },
  reactionCount: { fontSize: 11, fontWeight: '600' },

  // Context menu
  contextBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  contextSheet: { borderRadius: 16, overflow: 'hidden', minWidth: 220, borderWidth: 1 },
  emojiRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 12, paddingVertical: 14 },
  emojiBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  emojiBtnText: { fontSize: 24 },
  contextDivider: { height: 1 },
  contextAction: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14 },
  contextActionText: { fontSize: 15 },

  // Reply bar above input
  replyBar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderLeftWidth: 3 },
  replyBarAuthor: { fontSize: 12, fontWeight: '700', marginBottom: 1 },
  replyBarText: { fontSize: 12 },

  // @mention
  mentionList: { borderTopWidth: 1, borderBottomWidth: 1, overflow: 'hidden' },
  mentionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  mentionName: { fontSize: 14, fontWeight: '600' },

  // Input
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1 },
  plusBtn: { borderRadius: 8, padding: 9, borderWidth: 1, marginBottom: 1, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, borderWidth: 1, maxHeight: 120 },
  sendBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', marginBottom: 1 },
  sendBtnOff: { opacity: 0.3 },

  // Media preview
  previewBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center' },
  previewMedia: { width: '100%', height: '80%' },
  previewClose: { position: 'absolute', top: 52, right: 20, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: 8 },

  // Attach
  attachBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  attachSheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTopWidth: 1, paddingBottom: 32 },
  attachHandle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  attachRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 24, paddingVertical: 14, borderBottomWidth: 1 },
  attachIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  attachLabel: { fontSize: 16 },
  attachGifLabel: { fontSize: 13, fontWeight: '700' },

  // Group info
  infoBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  infoSheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '75%' },
  infoHandle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  infoTitle: { fontSize: 16, fontWeight: '700', textAlign: 'center', paddingHorizontal: 20 },
  infoSub: { fontSize: 12, textAlign: 'center', marginTop: 2, marginBottom: 12 },
  infoMemberRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 11, borderBottomWidth: 1 },
  infoMemberName: { flex: 1, fontSize: 14 },
  infoAddLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6, borderTopWidth: 1 },
  infoEmptyAdd: { fontSize: 13, paddingHorizontal: 20, paddingVertical: 10, paddingBottom: 24 },
});
