import React, { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image, Alert,
  TextInput, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Video, ResizeMode } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import VideoTrim, { showEditor } from 'react-native-video-trim';
import { enqueueStory } from '../utils/uploadQueue';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';

const DURATIONS = [
  { label: '1 hour', value: 1 },
  { label: '6 hours', value: 6 },
  { label: '24 hours', value: 24 },
  { label: '48 hours', value: 48 },
  { label: '1 week', value: 168 },
];

const PICK_OPTS = { mediaTypes: ['images'], quality: 0.9, allowsEditing: true, aspect: [9, 16] };
const STORY_MAX_DURATION_MS = 30000; // 30s for story video

export default function StoryCreateScreen({ navigation }) {
  const { colors } = useTheme();
  const toast = useToast();
  const [image, setImage] = useState(null);
  const [trimmedVideo, setTrimmedVideo] = useState(null); // { uri, durationMs }
  const [duration, setDuration] = useState(24);
  const [caption, setCaption] = useState('');
  const trimSubs = useRef([]);
  const insets = useSafeAreaInsets();

  const cleanupTrimSubs = () => {
    trimSubs.current.forEach((s) => s?.remove());
    trimSubs.current = [];
  };

  const openTrimEditor = (asset) => {
    cleanupTrimSubs();
    trimSubs.current = [
      VideoTrim.onFinishTrimming(({ outputPath, startTime, endTime }) => {
        cleanupTrimSubs();
        setTrimmedVideo({ uri: outputPath, durationMs: endTime - startTime });
        setImage(null);
      }),
      VideoTrim.onCancel(() => cleanupTrimSubs()),
      VideoTrim.onError(({ message }) => {
        cleanupTrimSubs();
        Alert.alert('Could not trim video', message);
      }),
    ];
    showEditor(asset.uri, {
      maxDuration: STORY_MAX_DURATION_MS,
      enableSaveDialog: false,
      enableCancelDialog: false,
      headerText: 'Trim Daily',
      saveButtonText: 'Use Clip',
      cancelButtonText: 'Back',
    });
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permission needed');
    const r = await ImagePicker.launchImageLibraryAsync(PICK_OPTS);
    if (!r.canceled) { setImage(r.assets[0].uri); setTrimmedVideo(null); }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permission needed');
    const r = await ImagePicker.launchCameraAsync(PICK_OPTS);
    if (!r.canceled) { setImage(r.assets[0].uri); setTrimmedVideo(null); }
  };

  const pickVideo = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permission needed');
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], quality: 0.9 });
    if (!r.canceled) openTrimEditor(r.assets[0]);
  };

  // Optimistic posting: the background queue encrypts + uploads; the stories
  // strip shows a "Posting…" ring (or tap-to-retry on failure)
  const postedRef = useRef(false);
  const handlePost = () => {
    if (postedRef.current) return; // instant button — guard double-taps
    postedRef.current = true;
    if (trimmedVideo) {
      enqueueStory({
        videoUri: trimmedVideo.uri,
        durationMs: trimmedVideo.durationMs,
        durationHours: duration,
        caption: caption.trim(),
      });
    } else if (image) {
      enqueueStory({ imageUri: image, durationHours: duration, caption: caption.trim() });
    } else {
      return;
    }
    toast?.info('Posting your daily…');
    navigation.goBack();
  };

  const hasMedia = !!(image || trimmedVideo);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.cancelText, { color: colors.textSub }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.text }]}>New Daily</Text>
          <View style={{ width: 52 }} />
        </View>

        {/* Preview */}
        {image ? (
          <View style={styles.previewWrap}>
            <Image source={{ uri: image }} style={styles.preview} resizeMode="cover" />
            <View style={styles.previewActions}>
              <TouchableOpacity style={styles.previewBtn} onPress={takePhoto}>
                <Feather name="camera" size={14} color="#fff" />
                <Text style={styles.previewBtnText}>Retake</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.previewBtn} onPress={pickImage}>
                <Feather name="image" size={14} color="#fff" />
                <Text style={styles.previewBtnText}>Change</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : trimmedVideo ? (
          <View style={styles.previewWrap}>
            <Video
              source={{ uri: trimmedVideo.uri }}
              style={styles.preview}
              resizeMode={ResizeMode.COVER}
              shouldPlay isMuted isLooping
            />
            <View style={styles.previewActions}>
              <TouchableOpacity style={styles.previewBtn} onPress={pickVideo}>
                <Feather name="video" size={14} color="#fff" />
                <Text style={styles.previewBtnText}>Change</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.clipBadge}>
              <Text style={styles.clipBadgeText}>
                {Math.round((trimmedVideo.durationMs || 0) / 1000)}s clip
              </Text>
            </View>
          </View>
        ) : (
          <View style={[styles.placeholder, { borderColor: colors.border, backgroundColor: colors.card }]}>
            <Feather name="camera" size={40} color={colors.border} />
            <Text style={[styles.placeholderText, { color: colors.textSub }]}>Select a photo or video for your daily</Text>
            <View style={styles.mediaRow}>
              <TouchableOpacity style={[styles.mediaBtn, { borderColor: colors.border, backgroundColor: colors.surface }]} onPress={takePhoto}>
                <Feather name="camera" size={18} color={colors.text} />
                <Text style={[styles.mediaBtnText, { color: colors.text }]}>Camera</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.mediaBtn, { borderColor: colors.border, backgroundColor: colors.surface }]} onPress={pickImage}>
                <Feather name="image" size={18} color={colors.text} />
                <Text style={[styles.mediaBtnText, { color: colors.text }]}>Photo</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.mediaBtn, { borderColor: colors.border, backgroundColor: colors.surface }]} onPress={pickVideo}>
                <Feather name="video" size={18} color={colors.text} />
                <Text style={[styles.mediaBtnText, { color: colors.text }]}>Video</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: colors.textSub }]}>Caption</Text>
          <TextInput
            style={[styles.captionInput, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
            placeholder="Add a caption…"
            placeholderTextColor={colors.textSub}
            value={caption}
            onChangeText={setCaption}
            multiline
            maxLength={300}
          />
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: colors.textSub }]}>Expires after</Text>
          <View style={styles.durationRow}>
            {DURATIONS.map((d) => (
              <TouchableOpacity
                key={d.value}
                style={[styles.chip, { borderColor: colors.border }, duration === d.value && { backgroundColor: colors.accent, borderColor: colors.accent }]}
                onPress={() => setDuration(d.value)}
              >
                <Text style={[styles.chipText, { color: colors.textSub }, duration === d.value && { color: colors.accentText, fontWeight: '600' }]}>
                  {d.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={[styles.footer, { borderTopColor: colors.border, paddingBottom: insets.bottom + 16 }]}>
          <TouchableOpacity
            style={[styles.postBtn, { backgroundColor: colors.accent }, !hasMedia && styles.postBtnDisabled]}
            onPress={handlePost}
            disabled={!hasMedia}
          >
            <Text style={[styles.postBtnText, { color: colors.accentText }]}>Post Daily</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  cancelText: { fontSize: 15 },
  title: { fontSize: 16, fontWeight: '600' },
  previewWrap: { position: 'relative', height: 340 },
  preview: { width: '100%', height: '100%' },
  previewActions: { position: 'absolute', bottom: 10, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 10 },
  previewBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12 },
  previewBtnText: { color: '#fff', fontSize: 13 },
  clipBadge: { position: 'absolute', top: 10, left: 10, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 8, paddingVertical: 4, paddingHorizontal: 10 },
  clipBadgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  placeholder: { height: 280, alignItems: 'center', justifyContent: 'center', gap: 16, margin: 16, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed' },
  placeholderText: { fontSize: 13 },
  mediaRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16 },
  mediaBtn: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 13, alignItems: 'center', gap: 6 },
  mediaBtnText: { fontSize: 13 },
  section: { padding: 16, gap: 10 },
  sectionLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  captionInput: { borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 15, minHeight: 80, textAlignVertical: 'top' },
  durationRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 14 },
  chipText: { fontSize: 13 },
  footer: { padding: 16, borderTopWidth: 1, marginTop: 'auto', flexDirection: 'row' },
  postBtn: { flex: 1, borderRadius: 8, paddingVertical: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  postBtnDisabled: { opacity: 0.3 },
  postBtnText: { fontWeight: '700', fontSize: 15 },
});
