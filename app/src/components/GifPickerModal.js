import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Modal,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { searchGifs } from '../utils/api';

export default function GifPickerModal({ visible, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!visible) { setQuery(''); setGifs([]); setError(null); }
  }, [visible]);

  const search = async (q) => {
    if (!q.trim()) { setGifs([]); setError(null); setLoading(false); return; }
    setLoading(true);
    try {
      const data = await searchGifs(q);
      setGifs(data.results || []);
      setError(data.error || null); // server explains config/network failures
    } catch { setGifs([]); setError('Could not reach the vault.'); }
    finally { setLoading(false); }
  };

  const handleQueryChange = (q) => {
    setQuery(q);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(q), 420);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>GIFs</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <Text style={styles.closeBtn}>Done</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.searchWrap}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search GIFs..."
              placeholderTextColor="#444"
              value={query}
              onChangeText={handleQueryChange}
              autoFocus
              clearButtonMode="while-editing"
            />
          </View>

          {loading ? (
            <View style={styles.center}><ActivityIndicator color="#fff" /></View>
          ) : gifs.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>
                {error || (query.trim() ? 'No GIFs found' : 'Search for GIFs above')}
              </Text>
            </View>
          ) : (
            <FlatList
              data={gifs}
              keyExtractor={(g) => g.id}
              numColumns={2}
              contentContainerStyle={styles.grid}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.gifCell}
                  onPress={() => onSelect(item)}
                  activeOpacity={0.75}
                >
                  <ExpoImage
                    source={{ uri: item.previewUrl }}
                    style={styles.gif}
                    contentFit="cover"
                    autoplay
                  />
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
  sheet: {
    height: '72%', backgroundColor: '#0d0d0d',
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    borderTopWidth: 1, borderColor: '#1e1e1e',
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 18, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#1a1a1a',
  },
  title: { color: '#fff', fontWeight: '600', fontSize: 15 },
  closeBtn: { color: '#888', fontSize: 14 },
  searchWrap: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#111' },
  searchInput: {
    backgroundColor: '#1a1a1a', color: '#fff',
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 14, borderWidth: 1, borderColor: '#2a2a2a',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 40 },
  emptyText: { color: '#8e8e93', fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  grid: { padding: 6 },
  gifCell: {
    flex: 1, margin: 3, borderRadius: 8, overflow: 'hidden',
    backgroundColor: '#111', aspectRatio: 1.5,
  },
  gif: { flex: 1 },
});
