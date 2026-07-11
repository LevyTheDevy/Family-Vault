import React, { useState, useCallback, useLayoutEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, TextInput, Modal, ActivityIndicator, RefreshControl,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CachedImage from '../components/CachedImage';
import { useFocusEffect } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import { fetchCollections, createCollection, deleteCollection, getMemberName } from '../utils/api';
import { useTheme } from '../context/ThemeContext';

const FAV_KEY = 'fv_fav_collections';
export const OFFLINE_KEY = 'fv_offline_posts';

function Thumbnail({ uri, colors }) {
  if (!uri) return <View style={[styles.folderThumbEmpty, { backgroundColor: colors.card }]} />;
  return <CachedImage uri={uri} style={styles.folderThumb} resizeMode="cover" />;
}

export default function CollectionsScreen({ navigation }) {
  const { colors } = useTheme();
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [favorites, setFavorites] = useState(new Set());
  const [offlineCount, setOfflineCount] = useState(0);
  const [offlineThumb, setOfflineThumb] = useState(null);
  const me = getMemberName();

  const loadFavorites = async () => {
    try {
      const raw = await AsyncStorage.getItem(FAV_KEY);
      setFavorites(raw ? new Set(JSON.parse(raw)) : new Set());
    } catch { }
  };

  const toggleFavorite = async (id) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      AsyncStorage.setItem(FAV_KEY, JSON.stringify([...next])).catch(() => {});
      return next;
    });
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => setShowCreate(true)}
          hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
        >
          <Text style={[styles.headerBtnText, { color: colors.text }]}>+ New</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, colors]);

  const loadOffline = async () => {
    try {
      const raw = await AsyncStorage.getItem(OFFLINE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      setOfflineCount(list.length);
      const first = list[0];
      setOfflineThumb((first?.imageUrls?.[0]) || first?.imageUrl || null);
    } catch {}
  };

  const load = async () => {
    // Keep the last known list if the fetch fails — don't wipe to empty
    try { setCollections(await fetchCollections()); } catch {}
  };

  useFocusEffect(useCallback(() => {
    setLoading(true);
    Promise.all([load(), loadFavorites(), loadOffline()]).finally(() => setLoading(false));
  }, []));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const c = await createCollection(newName.trim());
      setCollections((prev) => [...prev, { ...c, postCount: 0, thumbnailUrl: null }]);
      setShowCreate(false);
      setNewName('');
    } catch (e) { Alert.alert('Error', e.message); }
    finally { setCreating(false); }
  };

  const handleDelete = (col) => {
    if (col.author !== me) return Alert.alert('Cannot delete', 'You can only delete your own collections.');
    Alert.alert('Delete collection?', `"${col.name}" will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try { await deleteCollection(col.id); setCollections((prev) => prev.filter((c) => c.id !== col.id)); }
          catch (e) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.screenBg }]}>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : (
        <FlatList
          data={[{ id: 'offline', isOffline: true }, ...[...collections].sort((a, b) => (favorites.has(b.id) ? 1 : 0) - (favorites.has(a.id) ? 1 : 0))]}
          keyExtractor={(c) => String(c.id)}
          numColumns={2}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
          renderItem={({ item }) => {
            if (item.isOffline) {
              return (
                <TouchableOpacity
                  style={[styles.folder, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={() => navigation.navigate('OfflineCollection')}
                >
                  <View style={[styles.folderThumb, { overflow: 'hidden' }]}>
                    {offlineThumb
                      ? <CachedImage uri={offlineThumb} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                      : <View style={[StyleSheet.absoluteFillObject, { backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }]}>
                          <Feather name="download" size={28} color={colors.textSub} />
                        </View>}
                  </View>
                  <View style={styles.folderInfo}>
                    <Text style={[styles.folderName, { color: colors.text }]}>Offline</Text>
                    <Text style={[styles.folderCount, { color: colors.textSub }]}>{offlineCount} saved · Device only</Text>
                  </View>
                </TouchableOpacity>
              );
            }
            const isFav = favorites.has(item.id);
            return (
              <TouchableOpacity
                style={[styles.folder, { backgroundColor: colors.card, borderColor: isFav ? '#f5c518' : colors.border }]}
                onPress={() => navigation.navigate('CollectionDetail', { collection: item })}
                onLongPress={() => handleDelete(item)}
              >
                <Thumbnail uri={item.thumbnailUrl} colors={colors} />
                <TouchableOpacity
                  style={styles.starBtn}
                  onPress={() => toggleFavorite(item.id)}
                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                >
                  <Feather name="star" size={14} color={isFav ? '#f5c518' : colors.textSub} />
                </TouchableOpacity>
                <View style={styles.folderInfo}>
                  <View style={styles.folderNameRow}>
                    <Text style={[styles.folderName, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
                    {!item.isOwner && <Feather name="lock" size={11} color={colors.textSub} />}
                  </View>
                  <Text style={[styles.folderCount, { color: colors.textSub }]}>
                    {item.postCount} {item.postCount === 1 ? 'photo' : 'photos'}
                    {' · '}{item.memberCount || 1} {(item.memberCount || 1) === 1 ? 'member' : 'members'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => setShowCreate(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={[styles.modalSheet, { backgroundColor: colors.card }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>New Collection</Text>
            <TextInput
              style={[styles.modalInput, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
              placeholder="Collection name"
              placeholderTextColor={colors.textSub}
              value={newName}
              onChangeText={setNewName}
              autoFocus
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalCancel, { borderColor: colors.border }]}
                onPress={() => { setShowCreate(false); setNewName(''); }}
              >
                <Text style={[styles.modalCancelText, { color: colors.textSub }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalCreate, { backgroundColor: colors.accent }, !newName.trim() && styles.modalCreateDisabled]}
                onPress={handleCreate}
                disabled={!newName.trim() || creating}
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
  headerBtnText: { fontSize: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 60 },
  emptyText: { fontSize: 15, fontWeight: '600' },
  emptySub: { fontSize: 12 },
  grid: { padding: 12 },
  row: { gap: 12 },
  folder: { flex: 1, marginBottom: 12, borderRadius: 10, overflow: 'hidden', borderWidth: 1 },
  folderThumb: { width: '100%', aspectRatio: 1 },
  folderThumbEmpty: { width: '100%', aspectRatio: 1 },
  starBtn: { position: 'absolute', top: 6, right: 6, backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 12, padding: 5 },
  folderInfo: { padding: 10, gap: 3 },
  folderNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  folderName: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  folderCount: { fontSize: 11 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 24, paddingBottom: 40, gap: 16 },
  modalTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  modalInput: { borderWidth: 1, borderRadius: 8, padding: 14, fontSize: 15 },
  modalButtons: { flexDirection: 'row', gap: 10 },
  modalCancel: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  modalCancelText: { fontSize: 14 },
  modalCreate: { flex: 1, borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  modalCreateDisabled: { opacity: 0.3 },
  modalCreateText: { fontWeight: '700', fontSize: 14 },
});
