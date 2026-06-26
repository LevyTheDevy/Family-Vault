import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator, Keyboard, Modal, Dimensions, Image,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { addComment, deleteComment, getMemberName, getAvatarUrl } from '../utils/api';
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

export default function CommentsSheet({ post, onClose, onUpdated }) {
  const { colors } = useTheme();
  const [comments, setComments] = useState(post?.comments || []);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [viewingPin, setViewingPin] = useState(null);
  const inputRef = useRef();
  const listRef = useRef();
  const me = getMemberName();

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
      const comment = await addComment(post.id, trimmed);
      const next = [...comments, comment];
      setComments(next);
      setText('');
      onUpdated?.({ ...post, comments: next });
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not send comment');
    } finally { setSending(false); }
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

          <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
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
              renderItem={({ item }) => (
                <TouchableOpacity onLongPress={() => handleDeleteComment(item)} activeOpacity={0.8}>
                  <View style={[styles.comment, { borderBottomColor: colors.border }]}>
                    <Avatar name={item.author} uri={getAvatarUrl(item.author)} size={34} />
                    <View style={styles.commentBody}>
                      <View style={styles.commentMeta}>
                        <Text style={[styles.commentAuthor, { color: colors.text }]}>{item.author}</Text>
                        <Text style={[styles.commentTime, { color: colors.textSub }]}>{timeAgo(item.createdAt)}</Text>
                      </View>
                      {item.gifUrl ? (
                        <ExpoImage source={{ uri: item.gifUrl }} style={styles.commentGif} contentFit="cover" autoplay />
                      ) : null}
                      {item.text ? (
                        <Text style={[styles.commentText, { color: colors.text }]}>{item.text}</Text>
                      ) : null}
                      {item.imageX != null && (
                        <TouchableOpacity style={styles.pinBadge} onPress={() => setViewingPin(item)}>
                          <Feather name="map-pin" size={11} color={colors.textSub} />
                          <Text style={[styles.pinBadgeText, { color: colors.textSub }]}>View on photo</Text>
                        </TouchableOpacity>
                      )}
                      {item.author === me && (
                        <Text style={[styles.deleteHint, { color: colors.textMuted }]}>Hold to delete</Text>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>
              )}
            />

            <View style={[styles.inputRow, { borderTopColor: colors.border }]}>
              <TouchableOpacity
                style={[styles.gifBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => setShowGifPicker(true)}
                hitSlop={{ top: 8, right: 4, bottom: 8, left: 4 }}
              >
                <Text style={[styles.gifBtnText, { color: colors.textSub }]}>GIF</Text>
              </TouchableOpacity>
              <TextInput
                ref={inputRef}
                style={[styles.input, { backgroundColor: colors.inputBg, color: colors.text, borderColor: colors.border }]}
                placeholder="Add a comment..."
                placeholderTextColor={colors.textSub}
                value={text}
                onChangeText={setText}
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
  sheet: { maxHeight: '65%', minHeight: 240, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTopWidth: 1 },
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
