import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image, Alert,
  ActivityIndicator, TextInput, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Video, ResizeMode } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import { uploadStory, getEncryptImgBinFn } from '../utils/api';
import { processVideoClips, cleanupEncryptedClips } from '../utils/videoProcessing';
import VideoTrimmer from '../components/VideoTrimmer';
import { useTheme } from '../context/ThemeContext';

const DURATIONS = [
  { label: '1 hour', value: 1 },
  { label: '6 hours', value: 6 },
  { label: '24 hours', value: 24 },
  { label: '48 hours', value: 48 },
  { label: '1 week', value: 168 },
];

const PICK_OPTS = { mediaTypes: ['images'], quality: 0.9, allowsEditing: true, aspect: [9, 16] };

// 5s max per clip, up to 5 clips for stories
const STORY_MAX_CLIP_SEC = 5;
const STORY_MAX_CLIPS = 5;

export default function StoryCreateScreen({ navigation }) {
  const { colors } = useTheme();
  const [image, setImage] = useState(null);
  const [videoAsset, setVideoAsset] = useState(null); // { uri, duration (ms) }
  const [trimParams, setTrimParams] = useState(null);  // { startSec, endSec, numClips }
  const [step, setStep] = useState('pick'); // 'pick' | 'trim' | 'caption'
  const [duration, setDuration] = useState(24);
  const [caption, setCaption] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState('');
  const insets = useSafeAreaInsets();

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permission needed');
    const r = await ImagePicker.launchImageLibraryAsync(PICK_OPTS);
    if (!r.canceled) { setImage(r.assets[0].uri); setVideoAsset(null); setStep('caption'); }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permission needed');
    const r = await ImagePicker.launchCameraAsync(PICK_OPTS);
    if (!r.canceled) { setImage(r.assets[0].uri); setVideoAsset(null); setStep('caption'); }
  };

  const pickVideo = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permission needed');
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      quality: 0.9,
      videoMaxDuration: STORY_MAX_CLIPS * STORY_MAX_CLIP_SEC,
    });
    if (!r.canceled) {
      const a = r.assets[0];
      setVideoAsset({ uri: a.uri, duration: a.duration || 0 });
      setImage(null);
      setStep('trim');
    }
  };

  const handlePost = async () => {
    setUploading(true);
    let encryptedClips = null;
    try {
      if (videoAsset && trimParams) {
        const encBinFn = getEncryptImgBinFn();
        if (!encBinFn) throw new Error('Vault not unlocked');

        setProgress('Processing clips…');
        encryptedClips = await processVideoClips(
          videoAsset.uri,
          trimParams.startSec, trimParams.endSec, trimParams.numClips,
          encBinFn,
          (pct) => setProgress(`Processing ${Math.round(pct * 100)}%…`),
        );

        setProgress('Uploading…');
        await uploadStory(null, duration, caption.trim(), encryptedClips);
        cleanupEncryptedClips(encryptedClips).catch(() => {});
      } else if (image) {
        setProgress('Uploading…');
        await uploadStory(image, duration, caption.trim());
      } else {
        throw new Error('No media selected');
      }
      navigation.goBack();
    } catch (e) {
      if (encryptedClips) cleanupEncryptedClips(encryptedClips).catch(() => {});
      Alert.alert('Failed', e.message || 'Could not post daily.');
    } finally {
      setUploading(false);
      setProgress('');
    }
  };

  // ── Trim step (video only) ────────────────────────────────────────────────
  if (step === 'trim' && videoAsset) {
    return (
      <VideoTrimmer
        videoUri={videoAsset.uri}
        durationSec={(videoAsset.duration || 0) / 1000}
        maxClipSec={STORY_MAX_CLIP_SEC}
        maxClips={STORY_MAX_CLIPS}
        onBack={() => setStep('pick')}
        onConfirm={(params) => { setTrimParams(params); setStep('caption'); }}
      />
    );
  }

  // ── Caption / pick step ───────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
      >
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
        ) : videoAsset && trimParams ? (
          <View style={styles.previewWrap}>
            <Video
              source={{ uri: videoAsset.uri }}
              style={styles.preview}
              resizeMode={ResizeMode.COVER}
              shouldPlay isMuted isLooping
            />
            <View style={styles.previewActions}>
              <TouchableOpacity style={styles.previewBtn} onPress={() => setStep('trim')}>
                <Feather name="scissors" size={14} color="#fff" />
                <Text style={styles.previewBtnText}>Re-trim</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.previewBtn} onPress={pickVideo}>
                <Feather name="video" size={14} color="#fff" />
                <Text style={styles.previewBtnText}>Change</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.clipBadge}>
              <Text style={styles.clipBadgeText}>
                {trimParams.numClips} clip{trimParams.numClips > 1 ? 's' : ''} · {Math.round((trimParams.endSec - trimParams.startSec) / trimParams.numClips)}s each
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
                style={[
                  styles.chip,
                  { borderColor: colors.border },
                  duration === d.value && { backgroundColor: colors.accent, borderColor: colors.accent },
                ]}
                onPress={() => setDuration(d.value)}
              >
                <Text style={[
                  styles.chipText,
                  { color: colors.textSub },
                  duration === d.value && { color: colors.accentText, fontWeight: '600' },
                ]}>
                  {d.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={[styles.footer, { borderTopColor: colors.border, paddingBottom: insets.bottom + 16 }]}>
          <TouchableOpacity
            style={[styles.postBtn, { backgroundColor: colors.accent }, ((!image && !trimParams) || uploading) && styles.postBtnDisabled]}
            onPress={handlePost}
            disabled={(!image && !trimParams) || uploading}
          >
            {uploading
              ? <><ActivityIndicator color={colors.accentText} /><Text style={[styles.postBtnText, { color: colors.accentText, marginLeft: 8 }]}>{progress}</Text></>
              : <Text style={[styles.postBtnText, { color: colors.accentText }]}>Post Daily</Text>}
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
