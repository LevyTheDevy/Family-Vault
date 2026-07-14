import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Image, Alert, ActivityIndicator, ScrollView,
  Dimensions, StatusBar, useWindowDimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Video, ResizeMode } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import VideoTrim, { showEditor } from 'react-native-video-trim';
import { fetchCollections } from '../utils/api';
import { enqueuePhotos, enqueueVideo } from '../utils/uploadQueue';
import PhotoAdjustModal from '../components/PhotoAdjustModal';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';

const { width: SW } = Dimensions.get('window');

const FILTERS = [
  { name: 'Original' },
  { name: 'Warm',  tint: 'rgba(255,150,50,0.2)' },
  { name: 'Cool',  tint: 'rgba(80,140,255,0.2)' },
  { name: 'Fade',  tint: 'rgba(255,255,255,0.25)' },
  { name: 'Matte', tint: 'rgba(180,160,140,0.22)' },
  { name: 'B&W',   grayscale: true },
];

// ─── Step 0: Pick media ───────────────────────────────────────────────────────
function PickerStep({ onNext, insets }) {
  const { colors } = useTheme();
  const [selected, setSelected] = useState([]);

  const pickPhotos = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permission needed', 'Allow access to your photo library in Settings.');
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 0.9,
      // allowsEditing only works for single selection — multi-photo uses EditStep ratio crop
    });
    if (!r.canceled) setSelected(r.assets.map((a) => ({ uri: a.uri, mediaType: 'photo' })));
  };

  const pickVideo = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permission needed');
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      quality: 0.9,
      videoMaxDuration: 300,
    });
    if (!r.canceled) {
      const a = r.assets[0];
      setSelected([{ uri: a.uri, mediaType: 'video', duration: a.duration }]);
    }
  };

  const openCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Camera permission needed');
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.9, allowsEditing: true });
    if (!r.canceled) {
      const a = r.assets[0];
      setSelected([{ uri: a.uri, mediaType: a.type === 'video' ? 'video' : 'photo', duration: a.duration }]);
    }
  };

  const previewW = SW - 32;
  const hasVideo = selected.length === 1 && selected[0].mediaType === 'video';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {selected.length > 0 ? (
          <View style={{ gap: 8 }}>
            <ScrollView
              horizontal pagingEnabled showsHorizontalScrollIndicator={false}
              style={{ width: previewW, height: previewW * (hasVideo ? 0.6 : 0.75), borderRadius: 12, overflow: 'hidden' }}
            >
              {selected.map((item, idx) => (
                <View key={idx} style={{ width: previewW, height: previewW * (hasVideo ? 0.6 : 0.75) }}>
                  {item.mediaType === 'video' ? (
                    <Video
                      source={{ uri: item.uri }}
                      style={StyleSheet.absoluteFillObject}
                      resizeMode={ResizeMode.COVER}
                      shouldPlay isMuted isLooping
                    />
                  ) : (
                    <Image source={{ uri: item.uri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                  )}
                  {selected.length > 1 && (
                    <View style={s.indexPill}><Text style={s.indexText}>{idx + 1}/{selected.length}</Text></View>
                  )}
                </View>
              ))}
            </ScrollView>
            <Text style={[s.selHint, { color: colors.textSub }]}>
              {hasVideo ? '1 video selected' : `${selected.length} photo${selected.length > 1 ? 's' : ''} selected`}
            </Text>
          </View>
        ) : (
          <View style={[s.placeholder, { height: previewW * 0.75, borderColor: colors.border, backgroundColor: colors.card }]}>
            <Feather name="image" size={40} color={colors.border} />
            <Text style={[s.placeholderText, { color: colors.textSub }]}>No media selected</Text>
          </View>
        )}

        <View style={s.btnGrid}>
          <TouchableOpacity style={[s.mediaBtn, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={openCamera}>
            <Feather name="camera" size={22} color={colors.text} />
            <Text style={[s.mediaBtnText, { color: colors.textSub }]}>Camera</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.mediaBtn, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={pickPhotos}>
            <Feather name="image" size={22} color={colors.text} />
            <Text style={[s.mediaBtnText, { color: colors.textSub }]}>Photos</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.mediaBtn, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={pickVideo}>
            <Feather name="video" size={22} color={colors.text} />
            <Text style={[s.mediaBtnText, { color: colors.textSub }]}>Video</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <View style={[s.bottomBar, { borderTopColor: colors.border, backgroundColor: colors.bg }]}>
        {selected.length > 0 ? (
          <TouchableOpacity style={[s.nextBtn, { backgroundColor: colors.accent }]} onPress={() => onNext(selected)}>
            <Text style={[s.nextBtnText, { color: colors.accentText }]}>Next  →</Text>
          </TouchableOpacity>
        ) : (
          <Text style={[s.hintText, { color: colors.textSub }]}>Select photos or a video to continue</Text>
        )}
      </View>
    </View>
  );
}

function formatDur(secs) {
  if (!secs) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const CROP_RATIOS = [
  { label: 'Free', ratio: null },
  { label: '1:1',  ratio: [1, 1] },
  { label: '4:5',  ratio: [4, 5] },
  { label: '16:9', ratio: [16, 9] },
  { label: '9:16', ratio: [9, 16] },
];

async function cropToRatio(uri, ratio) {
  const info = await ImageManipulator.manipulateAsync(uri, []);
  const { width, height } = info;
  const [rw, rh] = ratio;
  const targetRatio = rw / rh;
  const imageRatio = width / height;
  let cropW, cropH, originX, originY;
  if (imageRatio > targetRatio) {
    cropH = height;
    cropW = Math.round(height * targetRatio);
    originX = Math.round((width - cropW) / 2);
    originY = 0;
  } else {
    cropW = width;
    cropH = Math.round(width / targetRatio);
    originX = 0;
    originY = Math.round((height - cropH) / 2);
  }
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ crop: { originX, originY, width: cropW, height: cropH } }],
    { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
  );
  return result.uri;
}

// ─── Step 1: Edit ─────────────────────────────────────────────────────────────
// Photo editing canvas stays dark (photos pop on black — standard for any editor)
function EditStep({ assets, onNext, onBack, insets }) {
  const { colors } = useTheme();
  const { width: screenW } = useWindowDimensions();
  const isVideo = assets[0]?.mediaType === 'video';
  const [tab, setTab] = useState('crop');
  const [cropRatioIdx, setCropRatioIdx] = useState(0);
  const [filterIdx, setFilterIdx] = useState(0);
  const [editedAssets, setEditedAssets] = useState(assets);
  const [cropping, setCropping] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [showAdjust, setShowAdjust] = useState(false);

  const moveLeft = () => {
    if (previewIdx === 0) return;
    setEditedAssets((prev) => {
      const next = [...prev];
      [next[previewIdx - 1], next[previewIdx]] = [next[previewIdx], next[previewIdx - 1]];
      return next;
    });
    setPreviewIdx((i) => i - 1);
  };

  const moveRight = () => {
    if (previewIdx >= editedAssets.length - 1) return;
    setEditedAssets((prev) => {
      const next = [...prev];
      [next[previewIdx], next[previewIdx + 1]] = [next[previewIdx + 1], next[previewIdx]];
      return next;
    });
    setPreviewIdx((i) => i + 1);
  };

  const applyAdjust = (uri) => {
    setShowAdjust(false);
    setEditedAssets((prev) => prev.map((a, i) => i === previewIdx ? { ...a, uri } : a));
  };

  const selectRatio = async (idx) => {
    setCropRatioIdx(idx);
    const ratio = CROP_RATIOS[idx].ratio;
    if (!ratio) { setEditedAssets(assets); return; }
    setCropping(true);
    try {
      const cropped = await Promise.all(
        assets.map((a) =>
          a.mediaType === 'video'
            ? Promise.resolve(a)
            : cropToRatio(a.uri, ratio).then((uri) => ({ ...a, uri }))
        )
      );
      setEditedAssets(cropped);
    } catch (e) {
      Alert.alert('Crop failed', e.message);
    } finally { setCropping(false); }
  };

  const currentAsset = editedAssets[previewIdx] || editedAssets[0];
  const filt = FILTERS[filterIdx];
  const ratio = CROP_RATIOS[cropRatioIdx].ratio;
  const previewAspect = ratio ? ratio[0] / ratio[1] : 1;

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* Preview — always dark canvas */}
      <View style={s.editPreviewWrap}>
        <View style={[s.editPreview, { aspectRatio: isVideo ? 9 / 16 : previewAspect }]}>
          {isVideo ? (
            <Video
              source={{ uri: currentAsset.uri }}
              style={StyleSheet.absoluteFillObject}
              resizeMode={ResizeMode.COVER}
              shouldPlay isLooping isMuted
            />
          ) : (
            <ScrollView
              horizontal pagingEnabled showsHorizontalScrollIndicator={false}
              style={StyleSheet.absoluteFillObject}
              onMomentumScrollEnd={(e) => {
                const idx = Math.round(e.nativeEvent.contentOffset.x / e.nativeEvent.layoutMeasurement.width);
                setPreviewIdx(idx);
              }}
              scrollEnabled={editedAssets.length > 1}
            >
              {editedAssets.map((asset, i) => (
                <View key={i} style={{ width: screenW, aspectRatio: previewAspect }}>
                  <Image source={{ uri: asset.uri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                  {filt?.tint && <View style={[StyleSheet.absoluteFillObject, { backgroundColor: filt.tint }]} />}
                  {filt?.grayscale && <View style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(60,60,60,0.55)' }]} />}
                </View>
              ))}
            </ScrollView>
          )}
          {cropping && (
            <View style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }]}>
              <ActivityIndicator color="#fff" size="large" />
              <Text style={{ color: '#fff', fontSize: 12, marginTop: 8 }}>Cropping…</Text>
            </View>
          )}
          {editedAssets.length > 1 && (
            <View style={s.dotRow} pointerEvents="none">
              {editedAssets.map((_, i) => (
                <View key={i} style={[s.dot, i === previewIdx && s.dotActive]} />
              ))}
            </View>
          )}
          {editedAssets.length > 1 && (
            <View style={s.countBadge}>
              <Text style={s.countBadgeText}>{previewIdx + 1} / {editedAssets.length}</Text>
            </View>
          )}
          {isVideo && currentAsset.duration && (
            <View style={s.durBadge}><Text style={s.durText}>{formatDur(currentAsset.duration)}</Text></View>
          )}
        </View>
      </View>

      {/* Tab bar */}
      {!isVideo && (
        <>
          <View style={[s.editTabRow, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
            <TouchableOpacity style={[s.editTab, tab === 'crop' && { borderBottomColor: colors.accent, borderBottomWidth: 2 }]} onPress={() => setTab('crop')}>
              <Feather name="crop" size={15} color={tab === 'crop' ? colors.accent : colors.textSub} />
              <Text style={[s.editTabText, { color: tab === 'crop' ? colors.text : colors.textSub }]}>Crop</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.editTab, tab === 'filter' && { borderBottomColor: colors.accent, borderBottomWidth: 2 }]} onPress={() => setTab('filter')}>
              <Feather name="sliders" size={15} color={tab === 'filter' ? colors.accent : colors.textSub} />
              <Text style={[s.editTabText, { color: tab === 'filter' ? colors.text : colors.textSub }]}>Filter</Text>
            </TouchableOpacity>
          </View>

          {tab === 'crop' ? (
            <>
              <View style={[s.cropRow, { backgroundColor: colors.surface }]}>
                {CROP_RATIOS.map((r, i) => (
                  <TouchableOpacity
                    key={r.label}
                    style={s.cropChip}
                    onPress={() => selectRatio(i)}
                    disabled={cropping}
                  >
                    <View style={[s.cropIcon, { backgroundColor: colors.card }, cropRatioIdx === i && { backgroundColor: colors.accent }]}>
                      {r.ratio ? (
                        <View style={{
                          width: r.ratio[0] > r.ratio[1] ? 26 : 18,
                          height: r.ratio[0] < r.ratio[1] ? 26 : r.ratio[0] === r.ratio[1] ? 20 : 16,
                          borderWidth: 2,
                          borderColor: cropRatioIdx === i ? colors.accentText : colors.textSub,
                          borderRadius: 2,
                        }} />
                      ) : (
                        <Feather name="maximize" size={18} color={cropRatioIdx === i ? colors.accentText : colors.textSub} />
                      )}
                    </View>
                    <Text style={[s.cropLabel, { color: cropRatioIdx === i ? colors.text : colors.textSub }]}>{r.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[s.filterStrip, { backgroundColor: colors.surface }]} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
              {FILTERS.map((f, i) => (
                <TouchableOpacity key={f.name} onPress={() => setFilterIdx(i)} style={s.filterChip}>
                  <View style={[s.filterThumb, filterIdx === i && { borderColor: colors.accent }]}>
                    <Image source={{ uri: assets[0].uri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                    {f.tint && <View style={[StyleSheet.absoluteFillObject, { backgroundColor: f.tint }]} />}
                    {f.grayscale && <View style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(60,60,60,0.5)' }]} />}
                  </View>
                  <Text style={[s.filterName, { color: filterIdx === i ? colors.text : colors.textSub }]}>{f.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </>
      )}

      {/* Reorder + adjust controls for multi-photo */}
      {!isVideo && editedAssets.length > 1 && (
        <View style={[s.reorderRow, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          <TouchableOpacity
            style={[s.reorderBtn, previewIdx === 0 && s.reorderBtnDisabled]}
            onPress={moveLeft}
            disabled={previewIdx === 0}
          >
            <Feather name="arrow-left" size={16} color={previewIdx === 0 ? colors.textMuted : colors.text} />
            <Text style={[s.reorderBtnText, { color: previewIdx === 0 ? colors.textMuted : colors.text }]}>Move</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.reorderBtn, { backgroundColor: colors.card }]}
            onPress={() => setShowAdjust(true)}
          >
            <Feather name="crop" size={16} color={colors.text} />
            <Text style={[s.reorderBtnText, { color: colors.text }]}>Adjust</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.reorderBtn, previewIdx >= editedAssets.length - 1 && s.reorderBtnDisabled]}
            onPress={moveRight}
            disabled={previewIdx >= editedAssets.length - 1}
          >
            <Text style={[s.reorderBtnText, { color: previewIdx >= editedAssets.length - 1 ? colors.textMuted : colors.text }]}>Move</Text>
            <Feather name="arrow-right" size={16} color={previewIdx >= editedAssets.length - 1 ? colors.textMuted : colors.text} />
          </TouchableOpacity>
        </View>
      )}
      {/* Adjust button for single photo */}
      {!isVideo && editedAssets.length === 1 && (
        <View style={[s.reorderRow, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          <TouchableOpacity
            style={[s.reorderBtn, { backgroundColor: colors.card }]}
            onPress={() => setShowAdjust(true)}
          >
            <Feather name="move" size={16} color={colors.text} />
            <Text style={[s.reorderBtnText, { color: colors.text }]}>Adjust framing</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={[s.editFooter, { paddingBottom: insets.bottom + 8, backgroundColor: colors.surface, borderTopColor: colors.border }]}>
        <TouchableOpacity onPress={onBack} style={s.backBtn}>
          <Feather name="arrow-left" size={20} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onNext({ editedAssets, filterIdx })}
          style={[s.nextBtn, { backgroundColor: colors.accent }, cropping && { opacity: 0.5 }]}
          disabled={cropping}
        >
          <Text style={[s.nextBtnText, { color: colors.accentText }]}>Caption  →</Text>
        </TouchableOpacity>
      </View>

      <PhotoAdjustModal
        visible={showAdjust}
        uri={editedAssets[previewIdx]?.uri}
        cropRatio={CROP_RATIOS[cropRatioIdx].ratio}
        onConfirm={applyAdjust}
        onCancel={() => setShowAdjust(false)}
      />
    </View>
  );
}

// ─── Step 2: Caption + collection + post ─────────────────────────────────────
// trimmedVideo: { uri: string, durationMs: number } — set by root after native trim UI
function CaptionStep({ assets, editedAssets, filterIdx, trimmedVideo, onBack, onDone, insets }) {
  const { colors } = useTheme();
  const [finalAssets] = useState(editedAssets || assets);
  const [caption, setCaption] = useState('');
  const [collections, setCollections] = useState([]);
  const [selectedCollection, setSelectedCollection] = useState(null);
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const toast = useToast();
  const isVideo = assets[0]?.mediaType === 'video';

  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, '').replace(/\s+/g, '_');
    if (!t || tags.includes(t) || tags.length >= 10) return;
    setTags((prev) => [...prev, t]);
    setTagInput('');
  };

  const removeTag = (t) => setTags((prev) => prev.filter((x) => x !== t));

  useEffect(() => { fetchCollections().then(setCollections).catch(() => {}); }, []);

  // All Members is the default destination, so it's not offered as a chip
  const pickableCollections = collections.filter((c) => !c.isSystem);
  const selCol = pickableCollections.find((c) => c.id === selectedCollection) || null;

  // Optimistic posting: hand the work to the background upload queue and
  // return to the feed immediately — the pending slide there shows progress
  // and surfaces retry/discard if the upload fails.
  const postedRef = useRef(false);
  const handlePost = () => {
    if (postedRef.current) return; // instant button — guard double-taps
    postedRef.current = true;
    if (isVideo && trimmedVideo) {
      enqueueVideo({
        videoUri: trimmedVideo.uri,
        durationMs: trimmedVideo.durationMs,
        caption: caption.trim(),
        collectionId: selectedCollection,
      });
    } else {
      enqueuePhotos({
        uris: finalAssets.map((a) => a.uri),
        caption: caption.trim(),
        collectionId: selectedCollection,
        tags,
      });
    }
    toast?.info('Posting in the background…');
    onDone();
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={s.captionContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={s.captionTopRow}>
        <View style={[s.captionThumb, { backgroundColor: colors.card }]}>
          {isVideo ? (
            <Video
              source={{ uri: finalAssets[0].uri }}
              style={StyleSheet.absoluteFillObject}
              resizeMode={ResizeMode.COVER}
              isMuted
            />
          ) : (
            <Image source={{ uri: finalAssets[0].uri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
          )}
          {finalAssets.length > 1 && (
            <View style={s.multiCount}>
              <Feather name="copy" size={12} color="#fff" />
              <Text style={s.multiCountText}>{finalAssets.length}</Text>
            </View>
          )}
        </View>

        <TextInput
          style={[s.captionInput, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border, flex: 1 }]}
          placeholder="Write a caption…"
          placeholderTextColor={colors.textSub}
          value={caption}
          onChangeText={setCaption}
          multiline
          maxLength={500}
        />
      </View>

      <Text style={[s.sectionLabel, { color: colors.textSub }]}>Tags (optional)</Text>
      <View style={s.tagInputRow}>
        <TextInput
          style={[s.tagInput, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
          placeholder="#tag"
          placeholderTextColor={colors.textSub}
          value={tagInput}
          onChangeText={setTagInput}
          onSubmitEditing={addTag}
          returnKeyType="done"
          maxLength={30}
          autoCapitalize="none"
        />
        <TouchableOpacity style={[s.tagAddBtn, { backgroundColor: colors.accent }]} onPress={addTag}>
          <Text style={[s.tagAddBtnText, { color: colors.accentText }]}>Add</Text>
        </TouchableOpacity>
      </View>
      {tags.length > 0 && (
        <View style={s.tagsRow}>
          {tags.map((t) => (
            <TouchableOpacity key={t} style={[s.tagChip, { backgroundColor: colors.accent }]} onPress={() => removeTag(t)}>
              <Text style={[s.tagChipText, { color: colors.accentText }]}>#{t} ×</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {pickableCollections.length > 0 && (
        <>
          <Text style={[s.sectionLabel, { color: colors.textSub }]}>Add to collection (optional)</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
            {pickableCollections.map((c) => (
              <TouchableOpacity
                key={c.id}
                style={[s.colChip, { borderColor: colors.border }, selectedCollection === c.id && { backgroundColor: colors.accent, borderColor: colors.accent }]}
                onPress={() => setSelectedCollection(selectedCollection === c.id ? null : c.id)}
              >
                <Text style={[s.colChipText, { color: colors.textSub }, selectedCollection === c.id && { color: colors.accentText, fontWeight: '600' }]}>
                  {c.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </>
      )}

      {/* Who will see this post — updates with the collection choice */}
      <View style={[s.shareHint, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Feather name={selCol ? 'lock' : 'users'} size={14} color={colors.textSub} />
        <Text style={[s.shareHintText, { color: colors.textSub }]}>
          {selCol
            ? `Only the ${selCol.memberCount || ''} member${selCol.memberCount === 1 ? '' : 's'} of "${selCol.name}" will see this post.`
            : 'Everyone in the family will see this post. It also lands in the All Members collection.'}
        </Text>
      </View>

      <View style={[s.captionFooter, { paddingBottom: insets.bottom + 8 }]}>
        <TouchableOpacity onPress={onBack} style={s.backBtn}>
          <Feather name="arrow-left" size={20} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.postBtn, { backgroundColor: colors.accent }]}
          onPress={handlePost}
        >
          <Text style={[s.postBtnText, { color: colors.accentText }]}>Share to Vault</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function PostScreen({ navigation }) {
  const { colors, isLight } = useTheme();
  const [step, setStep] = useState(0);
  const [pickedAssets, setPickedAssets] = useState([]);
  const [editResult, setEditResult] = useState(null);
  const [trimmedVideo, setTrimmedVideo] = useState(null); // { uri, durationMs }
  const trimSubs = useRef([]);
  const insets = useSafeAreaInsets();

  const isVideoFlow = pickedAssets[0]?.mediaType === 'video';
  const titles = ['New Post', 'Edit', 'Caption'];

  // Register VideoTrim event listeners when a trim is initiated; clean up after result
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
        setStep(2);
      }),
      VideoTrim.onCancel(() => {
        cleanupTrimSubs();
        setStep(0);
      }),
      VideoTrim.onError(({ message }) => {
        cleanupTrimSubs();
        Alert.alert('Could not trim video', message);
        setStep(0);
      }),
    ];
    showEditor(asset.uri, {
      maxDuration: 60000,
      enableSaveDialog: false,
      enableCancelDialog: false,
      headerText: 'Trim Video',
      saveButtonText: 'Continue',
      cancelButtonText: 'Back',
    });
  };

  useEffect(() => () => cleanupTrimSubs(), []);

  useEffect(() => {
    navigation.setOptions({
      title: titles[step],
      headerLeft: () => (
        <TouchableOpacity
          onPress={() => step === 0 ? navigation.goBack() : setStep((s) => s - 1)}
          style={{ marginLeft: 8 }}
        >
          <Feather name={step === 0 ? 'x' : 'arrow-left'} size={22} color={colors.text} />
        </TouchableOpacity>
      ),
    });
  }, [step, colors]);

  const handlePickerDone = (assets) => {
    setPickedAssets(assets);
    if (assets[0]?.mediaType === 'video') {
      openTrimEditor(assets[0]); // opens native trim UI; result handled via events
    } else {
      setStep(1);
    }
  };

  return (
    <View style={[s.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isLight ? 'dark-content' : 'light-content'} />
      {step === 0 && (
        <PickerStep insets={insets} onNext={handlePickerDone} />
      )}
      {step === 1 && !isVideoFlow && (
        <EditStep
          assets={pickedAssets}
          insets={insets}
          onBack={() => setStep(0)}
          onNext={(result) => { setEditResult(result); setStep(2); }}
        />
      )}
      {step === 2 && (
        <CaptionStep
          assets={pickedAssets}
          editedAssets={editResult?.editedAssets}
          filterIdx={editResult?.filterIdx ?? 0}
          trimmedVideo={trimmedVideo}
          insets={insets}
          onBack={() => isVideoFlow ? setStep(0) : setStep(1)}
          onDone={() => navigation.goBack()}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },

  // Picker step
  placeholder: { borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 10 },
  placeholderText: { fontSize: 13 },
  indexPill: { position: 'absolute', bottom: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, paddingVertical: 3, paddingHorizontal: 7 },
  indexText: { color: '#fff', fontSize: 11 },
  selHint: { fontSize: 12, textAlign: 'center' },
  btnGrid: { flexDirection: 'row', gap: 10 },
  mediaBtn: { flex: 1, borderWidth: 1, borderRadius: 12, paddingVertical: 20, alignItems: 'center', gap: 8 },
  mediaBtnText: { fontSize: 13 },
  bottomBar: { padding: 16, borderTopWidth: 1, alignItems: 'center' },
  hintText: { fontSize: 13 },
  nextBtn: { borderRadius: 10, paddingVertical: 13, paddingHorizontal: 32 },
  nextBtnText: { fontWeight: '700', fontSize: 15 },
  backBtn: { padding: 10 },

  // Edit step (dark canvas area)
  editPreviewWrap: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  editPreview: { width: '100%', overflow: 'hidden', position: 'relative' },
  dotRow: { position: 'absolute', bottom: 10, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)' },
  dotActive: { backgroundColor: '#fff', width: 18, borderRadius: 3 },
  countBadge: { position: 'absolute', top: 10, right: 10, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  countBadgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  durBadge: { position: 'absolute', bottom: 12, right: 12, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  durText: { color: '#fff', fontSize: 12, fontWeight: '600' },

  // Reorder / adjust row
  reorderRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 16, borderTopWidth: 1, gap: 8 },
  reorderBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  reorderBtnText: { fontSize: 13 },
  reorderBtnDisabled: { opacity: 0.35 },

  // Edit tabs
  editTabRow: { flexDirection: 'row', borderBottomWidth: 1 },
  editTab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11 },
  editTabText: { fontSize: 13 },

  // Crop row
  cropRow: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 14, paddingHorizontal: 8 },
  cropChip: { alignItems: 'center', gap: 6 },
  cropIcon: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cropLabel: { fontSize: 11 },

  // Filter strip
  filterStrip: { maxHeight: 110 },
  filterChip: { alignItems: 'center', gap: 5, paddingVertical: 10 },
  filterThumb: { width: 64, height: 64, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  filterName: { fontSize: 11 },
  editFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderTopWidth: 1, gap: 10 },

  // Caption step
  captionContent: { padding: 16, gap: 14 },
  captionTopRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  captionThumb: { width: 80, height: 80, borderRadius: 8, overflow: 'hidden' },
  multiCount: { position: 'absolute', top: 4, right: 4, flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 3 },
  multiCountText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  captionInput: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15, minHeight: 80, textAlignVertical: 'top' },
  adjustRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  adjustThumbBtn: { width: 56, height: 56, borderRadius: 8, overflow: 'hidden', borderWidth: 1 },
  adjustThumb: { width: '100%', height: '100%' },
  adjustThumbLabel: { position: 'absolute', bottom: 3, right: 3, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 4, padding: 3 },
  sectionLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  shareHint: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 12,
  },
  shareHintText: { fontSize: 12, lineHeight: 17, flex: 1 },
  tagInputRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  tagInput: { flex: 1, borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14 },
  tagAddBtn: { borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  tagAddBtnText: { fontWeight: '700', fontSize: 14 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  tagChip: { borderRadius: 16, paddingVertical: 4, paddingHorizontal: 10 },
  tagChipText: { fontSize: 12, fontWeight: '600' },

  colChip: { borderWidth: 1, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 14, marginRight: 8 },
  colChipText: { fontSize: 13 },
  captionFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8 },
  postBtn: { flex: 1, borderRadius: 10, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginLeft: 12 },
  postBtnDisabled: { opacity: 0.5 },
  postBtnText: { fontWeight: '700', fontSize: 15 },
});
