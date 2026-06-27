import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  Modal, FlatList, ScrollView, useWindowDimensions,
  Animated, TextInput, Keyboard, Dimensions, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CachedImage from './CachedImage';
import { Video, ResizeMode } from 'expo-av';
import { Feather, Ionicons } from '@expo/vector-icons';
import {
  getMemberName, likePost, savePost, deletePost,
  removeFromCollection, fetchCollections, addToCollection, addComment, getAvatarUrl,
  fetchConversations, startDM, sendMessage,
} from '../utils/api';
import Avatar from './Avatar';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import ZoomableImageViewer from './ZoomableImageViewer';

const OFFLINE_KEY = 'fv_offline_posts';

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function PostSlide({
  post: initialPost, height, isActive = false, onDeleted, onCommentPress,
  collectionId, onRemovedFromCollection,
}) {
  const { colors } = useTheme();
  const toast = useToast();
  const [post, setPost] = useState(initialPost);
  const [showMenu, setShowMenu] = useState(false);
  const [showCollections, setShowCollections] = useState(false);
  const [collections, setCollections] = useState([]);
  const [imageIndex, setImageIndex] = useState(0);
  const [pinState, setPinState] = useState(null);
  const [pinText, setPinText] = useState('');
  const [pinKeyboardH, setPinKeyboardH] = useState(0);
  const [pinSending, setPinSending] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(true);
  const [zoomUri, setZoomUri] = useState(null);
  const [showSend, setShowSend] = useState(false);
  const [sendConvos, setSendConvos] = useState([]);
  const [sendLoading, setSendLoading] = useState(false);
  const videoRef = useRef(null);
  const lastTap = useRef(0);
  const tapTimer = useRef(null);
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;
  const [heartVisible, setHeartVisible] = useState(false);
  const saveScale = useRef(new Animated.Value(0)).current;
  const saveOpacity = useRef(new Animated.Value(0)).current;
  const [saveVisible, setSaveVisible] = useState(false);
  const me = getMemberName();
  const { width, height: windowHeight } = useWindowDimensions();
  const slideHeight = height || windowHeight;

  React.useEffect(() => { setPost(initialPost); }, [initialPost]);

  // Pause video when scrolled off screen, resume when scrolled back
  useEffect(() => {
    if (!post.videoUrl) return;
    setIsPlaying(isActive);
  }, [isActive]);

  useEffect(() => {
    const screenH = Dimensions.get('screen').height;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      setPinKeyboardH(Math.max(0, screenH - e.endCoordinates.screenY));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setPinKeyboardH(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const handleImageLongPress = (e, imgIdx) => {
    const { locationX, locationY } = e.nativeEvent;
    setPinState({ x: locationX / width, y: locationY / slideHeight, posX: locationX, posY: locationY, imageIndex: imgIdx });
    setPinText('');
  };

  const cancelPin = () => { setPinState(null); setPinText(''); };

  const submitPinComment = async () => {
    if (!pinText.trim() || pinSending) return;
    const state = pinState;
    cancelPin();
    setPinSending(true);
    try {
      const comment = await addComment(post.id, pinText.trim(), null, state.x, state.y, state.imageIndex);
      const updatedPost = { ...post, comments: [...(post.comments || []), comment] };
      setPost(updatedPost);
      onCommentPress?.(updatedPost);
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not add comment');
    } finally { setPinSending(false); }
  };

  const isVideoPost = post.mediaType === 'video' || !!post.videoUrl;
  const imageUrls = post.imageUrls || (post.imageUrl ? [post.imageUrl] : []);
  const isLiked = post.likes?.includes(me);
  const isSaved = post.savedBy?.includes(me);
  const isOwn = post.author === me;

  const handleLike = async () => {
    const nowLiked = !isLiked;
    setPost((p) => ({ ...p, likes: nowLiked ? [...(p.likes || []), me] : p.likes.filter((n) => n !== me) }));
    try {
      const { likes } = await likePost(post.id);
      setPost((p) => ({ ...p, likes }));
    } catch {
      setPost((p) => ({ ...p, likes: nowLiked ? p.likes.filter((n) => n !== me) : [...(p.likes || []), me] }));
      toast?.error('Could not reach vault');
    }
  };

  const playSaveAnimation = () => {
    setSaveVisible(true);
    saveScale.setValue(0);
    saveOpacity.setValue(1);
    Animated.parallel([
      Animated.spring(saveScale, { toValue: 1, useNativeDriver: true, damping: 8, stiffness: 120, mass: 0.8 }),
      Animated.sequence([Animated.delay(500), Animated.timing(saveOpacity, { toValue: 0, duration: 350, useNativeDriver: true })]),
    ]).start(() => setSaveVisible(false));
  };

  const playHeartAnimation = () => {
    setHeartVisible(true);
    heartScale.setValue(0);
    heartOpacity.setValue(1);
    Animated.parallel([
      Animated.spring(heartScale, { toValue: 1, useNativeDriver: true, damping: 8, stiffness: 120, mass: 0.8 }),
      Animated.sequence([Animated.delay(500), Animated.timing(heartOpacity, { toValue: 0, duration: 350, useNativeDriver: true })]),
    ]).start(() => setHeartVisible(false));
  };

  const handleImageTap = (url) => {
    const now = Date.now();
    if (now - lastTap.current < 320) {
      // double-tap: like
      clearTimeout(tapTimer.current);
      tapTimer.current = null;
      if (!isLiked) handleLike();
      playHeartAnimation();
    } else {
      // single tap: open zoom viewer after delay (cancelled by double-tap)
      tapTimer.current = setTimeout(() => {
        tapTimer.current = null;
        setZoomUri(url);
      }, 330);
    }
    lastTap.current = now;
  };

  const handleSave = async () => {
    if (isSaved) {
      setPost((p) => ({ ...p, savedBy: p.savedBy.filter((n) => n !== me) }));
      try {
        await savePost(post.id);
        const raw = await AsyncStorage.getItem(OFFLINE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        await AsyncStorage.setItem(OFFLINE_KEY, JSON.stringify(list.filter((p) => p.id !== post.id)));
      } catch {}
      return;
    }
    try {
      const raw = await AsyncStorage.getItem(OFFLINE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (!list.find((p) => p.id === post.id)) {
        const allUrls = imageUrls.length > 0 ? imageUrls : (post.thumbnailUrl ? [post.thumbnailUrl] : []);
        list.unshift({ id: post.id, imageUrls: allUrls, imageUrl: allUrls[0] || null, author: post.author, caption: post.caption || '', savedAt: new Date().toISOString() });
        await AsyncStorage.setItem(OFFLINE_KEY, JSON.stringify(list));
      }
      setPost((p) => ({ ...p, savedBy: [...(p.savedBy || []), me] }));
      savePost(post.id).then(({ savedBy }) => setPost((p) => ({ ...p, savedBy }))).catch(() => {});
      playSaveAnimation();
    } catch (e) {
      Alert.alert('Save failed', e.message || 'Could not save post');
    }
  };

  const openSendSheet = async () => {
    setSendLoading(true);
    setShowSend(true);
    try {
      const convos = await fetchConversations();
      setSendConvos(convos);
    } catch { setSendConvos([]); }
    finally { setSendLoading(false); }
  };

  const handleSendToConvo = async (convo) => {
    setShowSend(false);
    try {
      const target = convo.isDM
        ? await startDM(convo.memberNames?.find((n) => n !== me) || convo.name)
        : convo;
      const postRef = { id: post.id, imageUrl: imageUrls[0] || '', author: post.author, caption: post.caption || '' };
      await sendMessage(target.id, '', null, null, postRef);
      toast?.success(`Sent to ${target.name || convo.name}`);
    } catch (e) {
      Alert.alert('Failed', e.message);
    }
  };

  const handleDelete = () => {
    Alert.alert('Delete post?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try { await deletePost(post.id); onDeleted?.(post.id); }
          catch (e) { Alert.alert('Error', e.message || 'Could not delete post'); }
        },
      },
    ]);
  };

  const handleRemoveFromCollection = () => {
    Alert.alert('Remove from collection?', 'The photo stays in the vault.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          try { await removeFromCollection(collectionId, post.id); onRemovedFromCollection?.(post.id); }
          catch (e) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  const openCollectionPicker = async () => {
    setShowMenu(false);
    const cols = await fetchCollections().catch(() => []);
    setCollections(cols);
    setShowCollections(true);
  };

  const handleAddToCollection = async (colId) => {
    setShowCollections(false);
    try { await addToCollection(colId, post.id); Alert.alert('Added', 'Photo added to collection.'); }
    catch (e) { Alert.alert('Error', e.message); }
  };

  return (
    <View style={[styles.container, { height: slideHeight }]}>

      {isVideoPost ? (
        <TouchableOpacity activeOpacity={1} onPress={() => setIsPlaying((p) => !p)} style={StyleSheet.absoluteFillObject}>
          <Video
            ref={videoRef}
            source={{ uri: post.videoUrl }}
            style={StyleSheet.absoluteFillObject}
            resizeMode={ResizeMode.COVER}
            shouldPlay={isPlaying}
            isLooping
            isMuted={isMuted}
            posterSource={post.thumbnailUrl ? { uri: post.thumbnailUrl } : undefined}
            usePoster={!!post.thumbnailUrl}
          />
          {!isPlaying && (
            <View style={styles.playOverlay} pointerEvents="none">
              <View style={styles.playBtn}><Feather name="play" size={36} color="#fff" /></View>
            </View>
          )}
          {post.durationSecs != null && (
            <View style={styles.durBadge} pointerEvents="none">
              <Text style={styles.durText}>
                {Math.floor(post.durationSecs / 60)}:{String(Math.floor(post.durationSecs % 60)).padStart(2, '0')}
              </Text>
            </View>
          )}
          <TouchableOpacity style={styles.muteBtn} onPress={(e) => { e.stopPropagation?.(); setIsMuted((m) => !m); }} hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}>
            <Feather name={isMuted ? 'volume-x' : 'volume-2'} size={16} color="#fff" />
          </TouchableOpacity>
        </TouchableOpacity>
      ) : (
        <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} scrollEnabled={imageUrls.length > 1}
          style={StyleSheet.absoluteFillObject}
          onMomentumScrollEnd={(e) => setImageIndex(Math.round(e.nativeEvent.contentOffset.x / width))}>
          {imageUrls.map((url, idx) => (
            <TouchableOpacity key={idx} activeOpacity={1} onPress={() => handleImageTap(url)}
              onLongPress={(e) => handleImageLongPress(e, idx)} delayLongPress={600}
              style={{ width, height: slideHeight }}>
              <CachedImage uri={url} style={styles.image} resizeMode="cover" />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {heartVisible && (
        <Animated.View style={[styles.heartOverlay, { opacity: heartOpacity, transform: [{ scale: heartScale.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1.3] }) }] }]} pointerEvents="none">
          <Ionicons name="heart" size={90} color="rgba(255,255,255,0.92)" />
        </Animated.View>
      )}
      {saveVisible && (
        <Animated.View style={[styles.heartOverlay, { opacity: saveOpacity, transform: [{ scale: saveScale.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1.3] }) }] }]} pointerEvents="none">
          <Ionicons name="bookmark" size={80} color="rgba(255,255,255,0.92)" />
        </Animated.View>
      )}

      {imageUrls.length > 1 && (
        <View style={styles.dots}>
          {imageUrls.map((_, i) => (
            <View key={i} style={[styles.dot, i === imageIndex && styles.dotActive]} />
          ))}
        </View>
      )}

      <TouchableOpacity style={styles.menuButton} onPress={() => setShowMenu(true)} hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}>
        <Feather name="more-vertical" size={20} color="#fff" />
      </TouchableOpacity>

      <View style={styles.bottomLeft} pointerEvents="none">
        <View style={styles.authorRow}>
          <Avatar name={post.author} uri={getAvatarUrl(post.author)} size={28} />
          <Text style={styles.author}>{post.author}</Text>
        </View>
        {!!post.caption && <Text style={styles.caption} numberOfLines={3}>{post.caption}</Text>}
        <Text style={styles.timestamp}>{timeAgo(post.createdAt)}</Text>
      </View>

      <View style={styles.actions}>
        {isOwn && (
          <TouchableOpacity style={styles.action} onPress={openSendSheet} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <Ionicons name="paper-plane-outline" size={26} color="#fff" />
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.action} onPress={handleLike} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={28} color="#fff" />
          <Text style={styles.actionCount}>{post.likes?.length || 0}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.action} onPress={() => onCommentPress?.(post)} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <Ionicons name="chatbubble-outline" size={26} color="#fff" />
          <Text style={styles.actionCount}>{post.comments?.length || 0}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.action} onPress={handleSave} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={26} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Options modal — themed */}
      <Modal visible={showMenu} transparent animationType="fade" onRequestClose={() => setShowMenu(false)} statusBarTranslucent>
        <TouchableOpacity style={styles.menuBackdrop} activeOpacity={1} onPress={() => setShowMenu(false)}>
          <View style={[styles.menuSheet, { backgroundColor: colors.card }]}>
            {collectionId && (
              <TouchableOpacity style={[styles.menuItem, { borderBottomColor: colors.border }]} onPress={() => { setShowMenu(false); handleRemoveFromCollection(); }}>
                <Text style={styles.menuItemDestructive}>Remove from Collection</Text>
              </TouchableOpacity>
            )}
            {isOwn && (
              <TouchableOpacity style={[styles.menuItem, { borderBottomColor: colors.border }]} onPress={() => { setShowMenu(false); handleDelete(); }}>
                <Text style={styles.menuItemDestructive}>Delete Post</Text>
              </TouchableOpacity>
            )}
            {imageUrls.length > 0 && (
              <TouchableOpacity style={[styles.menuItem, { borderBottomColor: colors.border }]} onPress={() => { setShowMenu(false); setZoomUri(imageUrls[imageIndex] ?? imageUrls[0]); }}>
                <Text style={[styles.menuItemText, { color: colors.text }]}>View Full Screen</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.menuItem, { borderBottomColor: colors.border }]} onPress={openCollectionPicker}>
              <Text style={[styles.menuItemText, { color: colors.text }]}>Add to Collection</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.menuItem, styles.menuItemLast]} onPress={() => setShowMenu(false)}>
              <Text style={[styles.menuItemCancel, { color: colors.textSub }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {pinState && (
        <View style={[styles.pinDot, { left: pinState.posX - 8, top: pinState.posY - 8 }]} pointerEvents="none" />
      )}

      {/* Pin comment modal — themed */}
      <Modal visible={!!pinState} transparent animationType="fade" statusBarTranslucent onRequestClose={cancelPin}>
        <View style={[styles.pinModalWrap, { paddingBottom: pinKeyboardH }]}>
          <TouchableOpacity style={styles.pinModalDismiss} activeOpacity={1} onPress={cancelPin} />
          <View style={[styles.pinModalSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.pinModalHandle, { backgroundColor: colors.border }]} />
            <Text style={[styles.pinModalHint, { color: colors.textSub }]}>Comment on this spot</Text>
            <View style={styles.pinModalInputRow}>
              <TextInput
                style={[styles.pinModalInput, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
                placeholder="Add a comment..."
                placeholderTextColor={colors.textSub}
                value={pinText}
                onChangeText={setPinText}
                autoFocus
                returnKeyType="send"
                onSubmitEditing={submitPinComment}
                maxLength={200}
              />
              <TouchableOpacity
                style={[styles.pinModalSendBtn, { backgroundColor: colors.accent }, (!pinText.trim() || pinSending) && { opacity: 0.3 }]}
                onPress={submitPinComment}
                disabled={!pinText.trim() || pinSending}
              >
                {pinSending
                  ? <ActivityIndicator color={colors.accentText} size="small" />
                  : <Text style={[styles.pinModalSendText, { color: colors.accentText }]}>Post</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Send post to conversation — owner only */}
      <Modal visible={showSend} transparent animationType="slide" onRequestClose={() => setShowSend(false)} statusBarTranslucent>
        <View style={styles.menuBackdrop}>
          <View style={[styles.collectionSheet, { backgroundColor: colors.card }]}>
            <Text style={[styles.collectionTitle, { color: colors.text, borderBottomColor: colors.border }]}>Send to…</Text>
            {sendLoading ? (
              <ActivityIndicator style={{ padding: 32 }} color={colors.text} />
            ) : sendConvos.length === 0 ? (
              <Text style={[styles.collectionEmpty, { color: colors.textSub }]}>No conversations yet.</Text>
            ) : (
              <FlatList
                data={sendConvos}
                keyExtractor={(c) => String(c.id)}
                renderItem={({ item }) => (
                  <TouchableOpacity style={[styles.collectionRow, { borderBottomColor: colors.border }]} onPress={() => handleSendToConvo(item)}>
                    <Feather name={item.isDM ? 'user' : 'users'} size={16} color={colors.textSub} style={{ marginRight: 12 }} />
                    <Text style={[styles.collectionName, { color: colors.text }]}>{item.name}</Text>
                  </TouchableOpacity>
                )}
              />
            )}
            <TouchableOpacity style={styles.menuItem} onPress={() => setShowSend(false)}>
              <Text style={[styles.menuItemCancel, { color: colors.textSub }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ZoomableImageViewer visible={!!zoomUri} uri={zoomUri} onClose={() => setZoomUri(null)} />

      {/* Collection picker — themed */}
      <Modal visible={showCollections} transparent animationType="slide" onRequestClose={() => setShowCollections(false)} statusBarTranslucent>
        <View style={styles.menuBackdrop}>
          <View style={[styles.collectionSheet, { backgroundColor: colors.card }]}>
            <Text style={[styles.collectionTitle, { color: colors.text, borderBottomColor: colors.border }]}>Add to Collection</Text>
            {collections.length === 0
              ? <Text style={[styles.collectionEmpty, { color: colors.textSub }]}>No collections yet.{'\n'}Create one in the Collections tab.</Text>
              : (
                <FlatList
                  data={collections}
                  keyExtractor={(c) => String(c.id)}
                  renderItem={({ item }) => (
                    <TouchableOpacity style={[styles.collectionRow, { borderBottomColor: colors.border }]} onPress={() => handleAddToCollection(item.id)}>
                      <Text style={[styles.collectionName, { color: colors.text }]}>{item.name}</Text>
                      <Text style={[styles.collectionCount, { color: colors.textSub }]}>{item.postCount} posts</Text>
                    </TouchableOpacity>
                  )}
                />
              )
            }
            <TouchableOpacity style={[styles.menuItem, styles.menuItemLast]} onPress={() => setShowCollections(false)}>
              <Text style={[styles.menuItemCancel, { color: colors.textSub }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', backgroundColor: '#000' },
  image: { ...StyleSheet.absoluteFillObject },
  heartOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  dots: { position: 'absolute', top: 14, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.35)' },
  dotActive: { backgroundColor: '#fff', width: 8, height: 8, borderRadius: 4 },
  menuButton: { position: 'absolute', top: 14, right: 14, padding: 6, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 16 },
  bottomLeft: { position: 'absolute', bottom: 28, left: 16, right: 72 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  author: { color: '#fff', fontWeight: '700', fontSize: 14, textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  caption: { color: '#fff', fontSize: 13, lineHeight: 18, marginBottom: 4, textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  timestamp: { color: 'rgba(255,255,255,0.7)', fontSize: 11, textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  actions: { position: 'absolute', bottom: 28, right: 10, alignItems: 'center', gap: 18, backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 30, paddingVertical: 12, paddingHorizontal: 8 },
  action: { alignItems: 'center', gap: 3 },
  actionCount: { color: '#fff', fontSize: 11, textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  menuSheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 36 },
  menuItem: { paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1 },
  menuItemLast: { borderBottomWidth: 0 },
  menuItemText: { fontSize: 16 },
  menuItemDestructive: { color: '#ff4444', fontSize: 16 },
  menuItemCancel: { fontSize: 16, textAlign: 'center' },
  pinDot: { position: 'absolute', width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.92)', borderWidth: 2, borderColor: '#000', zIndex: 20 },
  pinModalWrap: { flex: 1, justifyContent: 'flex-end' },
  pinModalDismiss: { flex: 1 },
  pinModalSheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTopWidth: 1, padding: 14, paddingBottom: 28 },
  pinModalHandle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10 },
  pinModalHint: { fontSize: 11, textAlign: 'center', marginBottom: 10 },
  pinModalInputRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  pinModalInput: { flex: 1, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, borderWidth: 1 },
  pinModalSendBtn: { borderRadius: 22, paddingVertical: 10, paddingHorizontal: 16 },
  pinModalSendText: { fontWeight: '700', fontSize: 13 },
  playOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.3)' },
  playBtn: { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', paddingLeft: 4 },
  durBadge: { position: 'absolute', top: 14, left: 14, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  durText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  muteBtn: { position: 'absolute', bottom: 90, right: 14, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 16, padding: 7 },
  collectionSheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 36, maxHeight: '60%' },
  collectionTitle: { fontSize: 15, fontWeight: '600', textAlign: 'center', paddingVertical: 16, borderBottomWidth: 1 },
  collectionEmpty: { fontSize: 13, textAlign: 'center', padding: 28, lineHeight: 20 },
  collectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 15, paddingHorizontal: 24, borderBottomWidth: 1 },
  collectionName: { fontSize: 15 },
  collectionCount: { fontSize: 13 },
});

export default React.memo(PostSlide);
