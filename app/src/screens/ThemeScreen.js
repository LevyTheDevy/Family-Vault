import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert,
} from 'react-native';
import { Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Feather } from '@expo/vector-icons';
import { useTheme, ACCENT_PRESETS } from '../context/ThemeContext';

const MODES = [
  { key: 'dark', label: 'Dark', icon: 'moon', desc: 'Classic dark theme' },
  { key: 'light', label: 'Light', icon: 'sun', desc: 'Light mode for daytime' },
  { key: 'custom', label: 'Custom', icon: 'sliders', desc: 'Pick base and accent color' },
];

export default function ThemeScreen() {
  const {
    colors, mode, setMode,
    customAccent, setAccent,
    customBase, setCustomBase,
    bgImageUri, setBgImage,
  } = useTheme();

  const pickBgImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to set a background.');
      return;
    }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: true,
      aspect: [9, 16],
    });
    if (!r.canceled) {
      // Copy out of the picker cache — the OS clears cache files, which made
      // custom wallpapers silently disappear days later. Unique filename per
      // pick so Image never serves a stale cached copy.
      let uri = r.assets[0].uri;
      try {
        const dest = `${FileSystem.documentDirectory}fv-wallpaper-${Date.now()}.jpg`;
        await FileSystem.copyAsync({ from: uri, to: dest });
        if (bgImageUri?.startsWith(FileSystem.documentDirectory)) {
          FileSystem.deleteAsync(bgImageUri, { idempotent: true }).catch(() => {});
        }
        uri = dest;
      } catch {}
      setBgImage(uri);
    }
  };

  const removeBgImage = () => {
    Alert.alert('Remove background?', 'This will clear the app background image.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: () => {
          if (bgImageUri?.startsWith(FileSystem.documentDirectory)) {
            FileSystem.deleteAsync(bgImageUri, { idempotent: true }).catch(() => {});
          }
          setBgImage(null);
        },
      },
    ]);
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.screenBg }]} contentContainerStyle={styles.content}>

      {/* Theme mode */}
      <Text style={[styles.sectionLabel, { color: colors.textSub }]}>Theme</Text>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {MODES.map((m, idx) => {
          const active = mode === m.key;
          return (
            <TouchableOpacity
              key={m.key}
              style={[
                styles.modeRow,
                idx < MODES.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.border },
              ]}
              onPress={() => setMode(m.key)}
              activeOpacity={0.7}
            >
              <View style={[styles.modeIconWrap, { backgroundColor: colors.surface }]}>
                <Feather name={m.icon} size={18} color={active ? colors.accent : colors.textSub} />
              </View>
              <View style={styles.modeBody}>
                <Text style={[styles.modeLabel, { color: colors.text }]}>{m.label}</Text>
                <Text style={[styles.modeDesc, { color: colors.textSub }]}>{m.desc}</Text>
              </View>
              {active && <Feather name="check" size={18} color={colors.accent} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Custom mode options */}
      {mode === 'custom' && (
        <>
          {/* Base theme picker */}
          <Text style={[styles.sectionLabel, { color: colors.textSub }]}>Base Theme</Text>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, padding: 14 }]}>
            <Text style={[styles.baseSublabel, { color: colors.textSub }]}>
              Accent color is applied on top of this base
            </Text>
            <View style={styles.baseSegment}>
              <TouchableOpacity
                style={[
                  styles.baseOption,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  customBase === 'dark' && { borderColor: colors.accent, borderWidth: 2 },
                ]}
                onPress={() => setCustomBase('dark')}
                activeOpacity={0.8}
              >
                <Feather name="moon" size={16} color={customBase === 'dark' ? colors.accent : colors.textSub} />
                <Text style={[styles.baseOptionText, { color: customBase === 'dark' ? colors.accent : colors.textSub }]}>
                  Dark
                </Text>
                {customBase === 'dark' && <Feather name="check" size={13} color={colors.accent} />}
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.baseOption,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  customBase === 'light' && { borderColor: colors.accent, borderWidth: 2 },
                ]}
                onPress={() => setCustomBase('light')}
                activeOpacity={0.8}
              >
                <Feather name="sun" size={16} color={customBase === 'light' ? colors.accent : colors.textSub} />
                <Text style={[styles.baseOptionText, { color: customBase === 'light' ? colors.accent : colors.textSub }]}>
                  Light
                </Text>
                {customBase === 'light' && <Feather name="check" size={13} color={colors.accent} />}
              </TouchableOpacity>
            </View>
          </View>

          {/* Accent color picker */}
          <Text style={[styles.sectionLabel, { color: colors.textSub }]}>Accent Color</Text>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, padding: 16 }]}>
            <View style={styles.accentGrid}>
              {ACCENT_PRESETS.map((c) => {
                // Black accent on a dark base (or white on light) makes every
                // accent-colored control invisible — don't offer it
                const invisible = (customBase === 'light' ? '#ffffff' : '#000000') === c;
                if (invisible) return null;
                return (
                  <TouchableOpacity
                    key={c}
                    style={[
                      styles.accentSwatch,
                      { backgroundColor: c, borderColor: colors.border },
                      customAccent === c && { borderWidth: 3, borderColor: colors.text },
                    ]}
                    onPress={() => setAccent(c)}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={`Accent color ${c}`}
                  >
                    {customAccent === c && (
                      <Feather name="check" size={14} color={c === '#ffffff' ? '#000' : '#fff'} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={[styles.previewRow, { marginTop: 16 }]}>
              <Text style={[styles.previewLabel, { color: colors.textSub }]}>Preview</Text>
              <View style={[styles.previewBadge, { backgroundColor: customAccent }]}>
                <Text style={{ color: customAccent === '#ffffff' ? '#000' : '#fff', fontSize: 13, fontWeight: '600' }}>
                  Button
                </Text>
              </View>
            </View>
          </View>
        </>
      )}

      {/* Background image */}
      <Text style={[styles.sectionLabel, { color: colors.textSub }]}>App Background</Text>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {bgImageUri ? (
          <View style={styles.bgPreviewWrap}>
            <Image source={{ uri: bgImageUri }} style={styles.bgPreview} resizeMode="cover" />
            <View style={styles.bgPreviewOverlay}>
              <TouchableOpacity style={styles.bgAction} onPress={pickBgImage}>
                <Feather name="edit-2" size={16} color="#fff" />
                <Text style={styles.bgActionText}>Change</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.bgAction, { backgroundColor: 'rgba(229,57,53,0.8)' }]} onPress={removeBgImage}>
                <Feather name="trash-2" size={16} color="#fff" />
                <Text style={styles.bgActionText}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity style={styles.bgPickRow} onPress={pickBgImage} activeOpacity={0.7}>
            <View style={[styles.bgPickIcon, { backgroundColor: colors.surface }]}>
              <Feather name="image" size={20} color={colors.textSub} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.bgPickLabel, { color: colors.text }]}>Set Background Image</Text>
              <Text style={[styles.bgPickSub, { color: colors.textSub }]}>Choose a photo from your library</Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.textSub} />
          </TouchableOpacity>
        )}
      </View>

      <Text style={[styles.hint, { color: colors.textSub }]}>
        Background clears when you change theme mode.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingBottom: 48, gap: 8 },
  sectionLabel: {
    fontSize: 11, fontWeight: '600', textTransform: 'uppercase',
    letterSpacing: 0.8, marginTop: 12, marginBottom: 8, paddingLeft: 4,
  },
  card: { borderRadius: 12, overflow: 'hidden', borderWidth: 1 },

  // Mode rows
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  modeIconWrap: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  modeBody: { flex: 1 },
  modeLabel: { fontSize: 15, fontWeight: '600' },
  modeDesc: { fontSize: 12, marginTop: 1 },

  // Base theme picker
  baseSublabel: { fontSize: 12, marginBottom: 12 },
  baseSegment: { flexDirection: 'row', gap: 10 },
  baseOption: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 7, paddingVertical: 11, borderRadius: 10, borderWidth: 1,
  },
  baseOptionText: { fontSize: 14, fontWeight: '600' },

  // Accent swatches
  accentGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  accentSwatch: {
    width: 42, height: 42, borderRadius: 21, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  previewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  previewLabel: { fontSize: 13 },
  previewBadge: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },

  // Background image
  bgPickRow: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  bgPickIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  bgPickLabel: { fontSize: 15, fontWeight: '600' },
  bgPickSub: { fontSize: 12, marginTop: 2 },
  bgPreviewWrap: { position: 'relative', height: 200 },
  bgPreview: { width: '100%', height: '100%' },
  bgPreviewOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)',
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center',
    gap: 12, paddingBottom: 16,
  },
  bgAction: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  bgActionText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  hint: { fontSize: 12, textAlign: 'center', lineHeight: 17, marginTop: 8 },
});
