import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator, Keyboard, Modal, Dimensions, Image,
  useWindowDimensions,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { addComment, deleteComment, reactToComment, getMemberName, getAvatarUrl, isGifEnabled, fetchFamilyMembers } from '../utils/api';
import Avatar from './Avatar';
import GifPickerModal from './GifPickerModal';
import { useTheme } from '../context/ThemeContext';

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function renderMentionText(txt, textStyle) {
  if (!txt) return null;
  const parts = txt.split(/(@\w+)/g);
  return (
    <Text style={textStyle}>
      {parts.map((part, i) =>
        /^@\w+$/.test(part)
          ? <Text key={i} style={{ fontWeight: '700' }}>{part}</Text>
          : part
      )}
    </Text>
  );
}

export default function CommentsSheet({ post, onClose, onUpdated }) {
  const { colors } = useTheme();
  const [comments, setComments] = useState(post?.comments || []);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [viewingPin, setViewingPin] = useState(null);
  const [members, setMembers] = useState([]);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [replyingTo, setReplyingTo] = useState(null); // { id, author }
  const [emojiTarget, setEmojiTarget] = useState(null); // comment to react to
  const inputRef = useRef();
  const listRef = useRef();
  const me = getMemberName();
  const { height: windowH } = useWindowDimensions();

  useEffect(() => {
    fetchFamilyMembers().then((m) => setMembers(m)).catch(() => {});
  }, []);

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

  const mentionSuggestions = mentionQuery !== null
    ? members.filter((m) => m.name.toLowerCase().startsWith(mentionQuery.toLowerCase()))
    : [];

  // The sheet needs a real height: with only maxHeight, the flex:1 list inside
  // collapsed to its 240px minHeight and comments showed through a ~120px
  // letterbox. 65% of the window normally; when the keyboard is up, shrink
  // just enough that the whole sheet stays on screen above it.
  const sheetHeight = Math.max(280, Math.min(windowH * 0.65, windowH - keyboardHeight - 60));

  useEffect(() => { setComments(post?.comments || []); }, [post?.id]);

  useEffect(() => {
    const screenH = Dimensions.get('screen').height;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardHeight(Math.max(0, screenH - e.endCoordinates.screenY));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, []);

  const close = () => { Keyboard.dismiss(); onClose(); };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const comment = await addComment(post.id, trimmed, null, null, null, 0, replyingTo?.id || null);
      const next = [...comments, comment];
      setComments(next);
      setText('');
      setReplyingTo(null);
      setMentionQuery(null);
      onUpdated?.({ ...post, comments: next });
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not send comment');
    } finally { setSending(false); }
  };

  const handleReact = async (comment, emoji) => {
    setEmojiTarget(null);
    try {
      const { reactions } = await reactToComment(post.id, comment.id, emoji);
      setComments((prev) => prev.map((c) => c.id === comment.id ? { ...c, reactions } : c));
    } catch {}
  };

  const startReply = (comment) => {
    setReplyingTo({ id: comment.id, author: comment.author });
    const prefix = `@${comment.author} `;
    setText((t) => t.startsWith(prefix) ? t : prefix);
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  const handleSendGif = async (gif) => {
    setShowGifPicker(false);
    setSending(true);
    try {
      const comment = await addComment(post.id, '', gif.gifUrl);
      const next = [...comments, comment];
      setComments(next);
      onUpdated?.({ ...post, comments: next });
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not send GIF');
    } finally { setSending(false); }
  };

  const handleDeleteComment = (comment) => {
    if (comment.author !== me) return;
    Alert.alert('Delete comment?', comment.text || 'This GIF comment', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await deleteComment(post.id, comment.id);
            const next = comments.filter((c) => c.id !== comment.id);
            setComments(next);
            onUpdated?.({ ...post, comments: next });
          } catch (e) { Alert.alert('Error', e.message || 'Could not delete'); }
        },
      },
    ]);
  };

  const pinImageUrl = viewingPin && (post?.imageUrls?.[viewingPin.imageIndex || 0] || post?.imageUrl);

  return (
    <>
      <Modal transparent animationType="slide" statusBarTranslucent onRequestClose={close}>
        <View style={[styles.wrapper, { paddingBottom: keyboardHeight }]}>
          <TouchableOpacity style={styles.dismissArea} activeOpacity={1} onPress={close} />

          <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border, height: sheetHeight }]}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />

            <View style={[styles.header, { borderBottomColor: colors.border }]}>
              <Text style={[styles.title, { color: colors.text }]}>Comments</Text>
              <TouchableOpacity onPress={close} hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}>
                <Text style={[styles.doneBtn, { color: colors.textSub }]}>Done</Text>
              </TouchableOpacity>
            </View>

            <FlatList
              ref={listRef}
              data={comments}
              keyExtractor={(c) => String(c.id)}
              contentContainerStyle={styles.listContent}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text style={[styles.empty, { color: colors.textSub }]}>No comments yet. Be the first!</Text>
              }
              renderItem={({ item }) => {
                const myReaction = item.reactions && Object.entries(item.reactions).find(([, names]) => names.some(n => n.toLowerCase() === me.toLowerCase()));
                const reactionEntries = item.reactions ? Object.entries(item.reactions).filter(([, names]) => names.length > 0) : [];
                const replyParent = item.replyToId ? comments.find(c => c.id === item.replyToId) : null;
                return (
                  <TouchableOpacity
                    onLongPress={() => setEmojiTarget(item)}
                    onPress={() => {}}
                    activeOpacity={0.85}
                    delayLongPress={350}
                  >
                    <View style={[styles.comment, { borderBottomColor: colors.border }]}>
                      <Avatar name={item.author} uri={getAvatarUrl(item.author)} size={34} />
                      <View style={styles.commentBody}>
                        <View style={styles.commentMeta}>
                          <Text style={[styles.commentAuthor, { color: colors.text }]}>{item.author}</Text>
                          <Text style={[styles.commentTime, { color: colors.textSub }]}>{timeAgo(item.createdAt)}</Text>
                        </View>
                        {replyParent && (
                          <View style={[styles.replyContext, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                            <Text style={[styles.replyContextAuthor, { color: colors.textSub }]}>@{replyParent.author}</Text>
                            {replyParent.text ? (
                              <Text style={[styles.replyContextText, { color: colors.textMuted }]} numberOfLines={1}>{replyParent.text}</Text>
                            ) : <Text style={[styles.replyContextText, { color: colors.textMuted }]}>GIF</Text>}
                          </View>
                        )}
                        {item.gifUrl ? (
                          <ExpoImage source={{ uri: item.gifUrl }} style={styles.commentGif} contentFit="cover" autoplay />
                        ) : null}
                        {item.text ? renderMentionText(item.text, [styles.commentText, { color: colors.text }]) : null}
                        {reactionEntries.length > 0 && (
                          <View style={styles.reactionsRow}>
                            {reactionEntries.map(([emoji, names]) => (
                              <TouchableOpacity
                                key={emoji}
                                style={[styles.reactionBadge, { backgroundColor: colors.surface, borderColor: myReaction?.[0] === emoji ? colors.accent : colors.border }]}
                                onPress={() => handleReact(item, emoji)}
                              >
                                <Text style={styles.reactionEmoji}>{emoji}</Text>
                                <Text style={[styles.reactionCount, { color: colors.textSub }]}>{names.length}</Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        )}
                        <View style={styles.commentActions}>
                          {item.imageX != null && (
                            <TouchableOpacity style={styles.pinBadge} onPress={() => setViewingPin(item)}>
                              <Feather name="map-pin" size={11} color={colors.textSub} />
                              <Text style={[styles.pinBadgeText, { color: colors.textSub }]}>View on photo</Text>
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity style={styles.replyBtn} onPress={() => startReply(item)}>
                            <Text style={[styles.replyBtnText, { color: colors.textSub }]}>Reply</Text>
                          </TouchableOpacity>
                          {item.author === me && (
                            <TouchableOpacity style={styles.replyBtn} onPress={() => handleDeleteComment(item)}>
                              <Text style={[styles.replyBtnText, { color: colors.textSub }]}>Delete</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />

            {replyingTo && (
              <View style={[styles.replyBanner, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.replyBannerText, { color: colors.textSub }]}>Replying to <Text style={{ fontWeight: '700', color: colors.text }}>@{replyingTo.author}</Text></Text>
                <TouchableOpacity onPress={() => { setReplyingTo(null); setText(''); }} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <Feather name="x" size={14} color={colors.textSub} />
                </TouchableOpacity>
              </View>
            )}

            {mentionSuggestions.length > 0 && (
              <View style={[styles.mentionList, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {mentionSuggestions.map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.mentionRow, { borderBottomColor: colors.border }]}
                    onPress={() => insertMention(m.name)}
                  >
                    <Avatar name={m.name} uri={getAvatarUrl(m.name)} size={24} />
                    <Text style={[styles.mentionName, { color: colors.text }]}>{m.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <View style={[styles.inputRow, { borderTopColor: colors.border }]}>
              {isGifEnabled() && (
                <TouchableOpacity
                  style={[styles.gifBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={() => setShowGifPicker(true)}
                  hitSlop={{ top: 8, right: 4, bottom: 8, left: 4 }}
                >
                  <Text style={[styles.gifBtnText, { color: colors.textSub }]}>GIF</Text>
                </TouchableOpacity>
              )}
              <TextInput
                ref={inputRef}
                style={[styles.input, { backgroundColor: colors.inputBg, color: colors.text, borderColor: colors.border }]}
                placeholder="Add a comment… @mention"
                placeholderTextColor={colors.textSub}
                value={text}
                onChangeText={handleTextChange}
                returnKeyType="send"
                onSubmitEditing={handleSend}
                blurOnSubmit={false}
                maxLength={500}
              />
              <TouchableOpacity
                style={[styles.sendBtn, { backgroundColor: colors.accent }, (!text.trim() || sending) && styles.sendBtnDisabled]}
                onPress={handleSend}
                disabled={!text.trim() || sending}
              >
                {sending
                  ? <ActivityIndicator color={colors.accentText} size="small" />
                  : <Text style={[styles.sendText, { color: colors.accentText }]}>Post</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <GifPickerModal visible={showGifPicker} onClose={() => setShowGifPicker(false)} onSelect={handleSendGif} />

      {/* Emoji reaction picker */}
      <Modal visible={!!emojiTarget} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setEmojiTarget(null)}>
        <TouchableOpacity style={styles.emojiBackdrop} activeOpacity={1} onPress={() => setEmojiTarget(null)}>
          <View style={[styles.emojiPicker, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.emojiTitle, { color: colors.textSub }]}>React</Text>
            <View style={styles.emojiRow}>
              {['❤️','😂','😮','😢','😡','👍','🔥','🙌'].map((e) => (
                <TouchableOpacity key={e} style={styles.emojiBtn} onPress={() => emojiTarget && handleReact(emojiTarget, e)}>
                  <Text style={styles.emojiChar}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Photo pin viewer — always dark (viewing a photo) */}
      <Modal visible={!!viewingPin} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setViewingPin(null)}>
        <View style={styles.pinViewWrap}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setViewingPin(null)} />
          {pinImageUrl && <Image source={{ uri: pinImageUrl }} style={styles.pinViewImage} resizeMode="contain" />}
          {viewingPin && (
            <View style={[styles.pinDot, { left: `${(viewingPin.imageX * 100).toFixed(1)}%`, top: `${(viewingPin.imageY * 100).toFixed(1)}%` }]} />
          )}
          {viewingPin?.text ? (
            <View style={styles.pinCaption}>
              <Text style={styles.pinCaptionText}>{viewingPin.text}</Text>
            </View>
          ) : null}
          <TouchableOpacity style={styles.pinViewClose} onPress={() => setViewingPin(null)}>
            <Feather name="x" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  dismissArea: { flex: 1 },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTopWidth: 1 },
  handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 2 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1 },
  title: { fontSize: 15, fontWeight: '600' },
  doneBtn: { fontSize: 14 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  empty: { textAlign: 'center', paddingVertical: 32, fontSize: 13 },
  comment: { flexDirection: 'row', gap: 10, paddingVertical: 11, borderBottomWidth: 1 },
  avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatarText: { fontSize: 14, fontWeight: '600' },
  commentBody: { flex: 1 },
  commentMeta: { flexDirection: 'row', gap: 6, alignItems: 'baseline', marginBottom: 3 },
  commentAuthor: { fontSize: 13, fontWeight: '600' },
  commentTime: { fontSize: 11 },
  commentText: { fontSize: 14, lineHeight: 19 },
  commentGif: { width: '100%', height: 140, borderRadius: 8, marginTop: 4 },
  deleteHint: { fontSize: 10, marginTop: 3 },
  pinBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  pinBadgeText: { fontSize: 11, textDecorationLine: 'underline' },
  mentionList: { borderWidth: 1, borderRadius: 8, marginHorizontal: 12, marginBottom: 4, overflow: 'hidden' },
  mentionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  mentionName: { fontSize: 14, fontWeight: '600' },
  replyBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth },
  replyBannerText: { fontSize: 13 },
  replyContext: { borderLeftWidth: 2, paddingLeft: 8, paddingVertical: 3, borderRadius: 4, marginBottom: 4 },
  replyContextAuthor: { fontSize: 12, fontWeight: '600' },
  replyContextText: { fontSize: 12, lineHeight: 16 },
  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4 },
  reactionBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderRadius: 12, paddingHorizontal: 7, paddingVertical: 3 },
  reactionEmoji: { fontSize: 14 },
  reactionCount: { fontSize: 12, fontWeight: '600' },
  commentActions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  replyBtn: { paddingVertical: 2 },
  replyBtnText: { fontSize: 12, fontWeight: '600' },
  emojiBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  emojiPicker: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10, width: 300 },
  emojiTitle: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, textAlign: 'center' },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 4 },
  emojiBtn: { padding: 8 },
  emojiChar: { fontSize: 26 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 12, borderTopWidth: 1 },
  gifBtn: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1 },
  gifBtnText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  input: { flex: 1, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, borderWidth: 1 },
  sendBtn: { borderRadius: 22, paddingVertical: 10, paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center', minWidth: 52 },
  sendBtnDisabled: { opacity: 0.3 },
  sendText: { fontWeight: '700', fontSize: 13 },
  pinViewWrap: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  pinViewImage: { width: '100%', height: '100%', position: 'absolute' },
  pinDot: { position: 'absolute', width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.9)', borderWidth: 3, borderColor: '#000', marginLeft: -10, marginTop: -10 },
  pinCaption: { position: 'absolute', bottom: 60, left: 20, right: 20, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  pinCaptionText: { color: '#fff', fontSize: 14, textAlign: 'center' },
  pinViewClose: { position: 'absolute', top: 52, right: 20, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 16, padding: 8 },
});
