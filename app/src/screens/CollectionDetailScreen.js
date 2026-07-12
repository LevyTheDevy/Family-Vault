import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, FlatList, StyleSheet, ActivityIndicator, Text,
  TouchableOpacity, Alert, Modal, ScrollView,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import {
  fetchCollectionPosts, deleteCollection, getMemberName,
  addCollectionMember, removeCollectionMember, fetchFamilyMembers,
} from '../utils/api';
import PostSlide from '../components/PostSlide';
import CommentsSheet from '../components/CommentsSheet';
import { useTheme } from '../context/ThemeContext';

export default function CollectionDetailScreen({ route, navigation }) {
  const { colors } = useTheme();
  const { collection: initialCollection } = route.params;
  const [collection, setCollection] = useState(initialCollection);
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listHeight, setListHeight] = useState(0);
  const [activePostId, setActivePostId] = useState(null);
  const [commentPost, setCommentPost] = useState(null);
  const listHeightRef = useRef(0);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    setActivePostId(viewableItems[0]?.item?.id ?? null);
  }).current;
  const [showMembers, setShowMembers] = useState(false);
  const [allMembers, setAllMembers] = useState([]);
  const me = getMemberName();
  const isOwner = collection.author === me;
  const memberNames = collection.memberNames || [collection.author];

  useEffect(() => {
    fetchCollectionPosts(collection.id)
      .then(setPosts)
      // A network failure lands here too — don't mislabel it "Access denied"
      .catch((e) => Alert.alert('Could not load collection', e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleDeleteCollection = () => {
    Alert.alert(
      'Delete Collection?',
      `"${collection.name}" will be removed. Photos stay in the vault.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            try { await deleteCollection(collection.id); navigation.goBack(); }
            catch (e) { Alert.alert('Error', e.message || 'Could not delete collection'); }
          },
        },
      ]
    );
  };

  const openMembers = async () => {
    const all = await fetchFamilyMembers().catch(() => []);
    setAllMembers(all);
    setShowMembers(true);
  };

  const handleAddMember = async (memberName) => {
    try {
      const updated = await addCollectionMember(collection.id, memberName);
      setCollection({ ...collection, memberNames: updated.memberNames || memberNames });
    } catch (e) { Alert.alert('Error', e.message); }
  };

  const handleRemoveMember = (memberName) => {
    Alert.alert('Remove member?', `${memberName} will lose access to this collection.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          try {
            const updated = await removeCollectionMember(collection.id, memberName);
            setCollection({ ...collection, memberNames: updated.memberNames || memberNames });
          } catch (e) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  React.useLayoutEffect(() => {
    navigation.setOptions({
      title: collection.name,
      headerRight: () => (
        <View style={{ flexDirection: 'row', gap: 16, marginRight: 16 }}>
          <TouchableOpacity onPress={openMembers} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <Feather name="users" size={18} color={colors.text} />
          </TouchableOpacity>
          {isOwner && (
            <TouchableOpacity onPress={handleDeleteCollection} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <Feather name="trash-2" size={18} color="#ff4444" />
            </TouchableOpacity>
          )}
        </View>
      ),
    });
  }, [collection, colors]);

  const handleRemovedFromCollection = (postId) => setPosts((prev) => prev.filter((p) => p.id !== postId));
  const handleCommentUpdated = (updated) => {
    setPosts((prev) => prev.map((p) => p.id === updated.id ? updated : p));
    setCommentPost((cp) => cp?.id === updated.id ? updated : cp);
  };

  const currentMembers = collection.memberNames || [collection.author];
  const nonMembers = allMembers.filter((m) => !currentMembers.includes(m.name));

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.screenBg }]}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.screenBg }]}>
      {posts.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.emptyText, { color: colors.textSub }]}>No photos in this collection.</Text>
          <Text style={[styles.emptySub, { color: colors.textMuted }]}>Add photos from the feed using the menu.</Text>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          data={posts}
          keyExtractor={(p) => String(p.id)}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          // Cap mounted full-screen slides — each decrypts + decodes a feed-res
          // bitmap, so an unbounded window exhausts native heap (gray images).
          windowSize={5}
          initialNumToRender={3}
          maxToRenderPerBatch={3}
          removeClippedSubviews
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            listHeightRef.current = h;
            setListHeight(h);
          }}
          getItemLayout={(_, index) => ({
            length: listHeightRef.current,
            offset: listHeightRef.current * index,
            index,
          })}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          renderItem={({ item }) => (
            <PostSlide
              post={item}
              height={listHeight}
              isActive={item.id === activePostId}
              collectionId={collection.id}
              onRemovedFromCollection={handleRemovedFromCollection}
              onDeleted={handleRemovedFromCollection}
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

      <Modal visible={showMembers} transparent animationType="slide" onRequestClose={() => setShowMembers(false)} statusBarTranslucent>
        <View style={styles.modalBackdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setShowMembers(false)} />
          <View style={[styles.modalSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.modalHandle, { backgroundColor: colors.border }]} />
            <Text style={[styles.modalTitle, { color: colors.text }]}>Collection Access</Text>
            <Text style={[styles.modalSub, { color: colors.textSub }]}>
              {isOwner ? 'Manage who can view this collection' : 'Members with access'}
            </Text>

            <ScrollView style={styles.modalScroll}>
              <Text style={[styles.sectionLabel, { color: colors.textSub }]}>Members ({currentMembers.length})</Text>
              {currentMembers.map((name) => (
                <View key={name} style={[styles.memberRow, { borderBottomColor: colors.border }]}>
                  <View style={[styles.memberAvatar, { backgroundColor: colors.card }]}>
                    <Text style={[styles.memberAvatarText, { color: colors.text }]}>{name[0].toUpperCase()}</Text>
                  </View>
                  <Text style={[styles.memberName, { color: colors.text }]}>
                    {name}{name === collection.author ? ' (creator)' : ''}
                  </Text>
                  {isOwner && name !== me && (
                    <TouchableOpacity onPress={() => handleRemoveMember(name)} style={styles.removeBtn}>
                      <Feather name="x" size={14} color="#ff4444" />
                    </TouchableOpacity>
                  )}
                </View>
              ))}

              {isOwner && nonMembers.length > 0 && (
                <>
                  <Text style={[styles.sectionLabel, { color: colors.textSub, marginTop: 16 }]}>Add family members</Text>
                  {nonMembers.map((m) => (
                    <TouchableOpacity
                      key={m.id}
                      style={[styles.memberRow, { borderBottomColor: colors.border }]}
                      onPress={() => handleAddMember(m.name)}
                    >
                      <View style={[styles.memberAvatar, { backgroundColor: colors.card }]}>
                        <Text style={[styles.memberAvatarText, { color: colors.text }]}>{m.name[0].toUpperCase()}</Text>
                      </View>
                      <Text style={[styles.memberName, { color: colors.text }]}>{m.name}</Text>
                      <Feather name="plus" size={16} color={colors.text} />
                    </TouchableOpacity>
                  ))}
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyText: { fontSize: 15 },
  emptySub: { fontSize: 12, textAlign: 'center', paddingHorizontal: 32 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalSheet: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    borderTopWidth: 1, maxHeight: '70%',
  },
  modalHandle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  modalTitle: { fontSize: 16, fontWeight: '700', textAlign: 'center', paddingHorizontal: 20 },
  modalSub: { fontSize: 12, textAlign: 'center', marginTop: 2, marginBottom: 10 },
  // flexShrink makes the list scroll inside the maxHeight sheet instead of clipping
  modalScroll: { paddingHorizontal: 20, marginBottom: 30, flexGrow: 0, flexShrink: 1 },
  sectionLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, marginTop: 4 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1 },
  memberAvatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  memberAvatarText: { fontSize: 14, fontWeight: '600' },
  memberName: { flex: 1, fontSize: 14 },
  removeBtn: { padding: 6 },
});
