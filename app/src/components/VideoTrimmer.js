import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, PanResponder,
  useWindowDimensions, ActivityIndicator,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';

const HANDLE_R = 13;
const BAR_H = 6;
const SELECTED_H = 18;
const MIN_RATIO = 0.005; // minimum selection (0.5%)

function fmtSec(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Clamp x between lo and hi
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

export default function VideoTrimmer({ videoUri, durationSec, maxClipSec, maxClips = 5, onConfirm, onBack }) {
  const { colors } = useTheme();
  const { width: SW } = useWindowDimensions();
  const PAD = 24;
  const BAR_W = SW - PAD * 2;

  // Current trim state — kept in refs so PanResponder closures always see fresh values
  const trimRef = useRef({ startRatio: 0, endRatio: Math.min(1, (maxClipSec * 1) / Math.max(durationSec, 1)), numClips: 1 });
  const [trim, setTrim] = useState(() => trimRef.current);

  const barPageX = useRef(PAD); // absolute X of bar on screen (measured on layout)
  const barRef = useRef(null);

  const videoRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoReady, setVideoReady] = useState(false);

  const dur = Math.max(durationSec, 0.1);

  const updateTrim = useCallback((updates) => {
    const next = { ...trimRef.current, ...updates };
    trimRef.current = next;
    setTrim({ ...next });
  }, []);

  const seekToStart = useCallback(() => {
    const ms = trimRef.current.startRatio * dur * 1000;
    videoRef.current?.setPositionAsync(Math.round(ms)).catch(() => {});
  }, [dur]);

  // Shared handle drag logic
  const makeHandlePan = useCallback((side) => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      setIsPlaying(false);
    },
    onPanResponderMove: (_, gs) => {
      const ratio = clamp((gs.moveX - barPageX.current) / BAR_W, 0, 1);
      const cur = trimRef.current;
      const maxRatio = clamp((cur.numClips * maxClipSec) / dur, 0, 1);

      if (side === 'start') {
        let newStart = clamp(ratio, Math.max(0, cur.endRatio - maxRatio), cur.endRatio - MIN_RATIO);
        updateTrim({ startRatio: newStart });
      } else {
        let newEnd = clamp(ratio, cur.startRatio + MIN_RATIO, Math.min(1, cur.startRatio + maxRatio));
        updateTrim({ endRatio: newEnd });
      }
    },
    onPanResponderRelease: () => {
      seekToStart();
    },
  }), [BAR_W, dur, maxClipSec, updateTrim, seekToStart]);

  const startPan = useRef(makeHandlePan('start')).current;
  const endPan   = useRef(makeHandlePan('end')).current;

  const changeNumClips = useCallback((n) => {
    const maxRatio = clamp((n * maxClipSec) / dur, 0, 1);
    const cur = trimRef.current;
    const newEnd = cur.endRatio - cur.startRatio > maxRatio
      ? cur.startRatio + maxRatio
      : cur.endRatio;
    updateTrim({ numClips: n, endRatio: newEnd });
  }, [dur, maxClipSec, updateTrim]);

  const onBarLayout = useCallback(() => {
    barRef.current?.measure((_, __, _w, _h, pageX) => {
      if (pageX != null) barPageX.current = pageX;
    });
  }, []);

  const selectedSec = (trim.endRatio - trim.startRatio) * dur;
  const clipSec = selectedSec / trim.numClips;
  const maxClipsAllowed = Math.min(maxClips, Math.floor(selectedSec / 1) || 1);

  const startPx = trim.startRatio * BAR_W;
  const endPx = trim.endRatio * BAR_W;
  const selectedPx = endPx - startPx;

  const dividerPositions = [];
  if (trim.numClips > 1) {
    for (let i = 1; i < trim.numClips; i++) {
      dividerPositions.push(startPx + (selectedPx * i) / trim.numClips);
    }
  }

  const canConfirm = selectedSec >= 0.5;

  return (
    <View style={[styles.container, { backgroundColor: '#000' }]}>
      {/* Video preview */}
      <View style={styles.videoWrap}>
        {!videoReady && (
          <View style={styles.videoLoading}>
            <ActivityIndicator color="rgba(255,255,255,0.5)" />
          </View>
        )}
        <Video
          ref={videoRef}
          source={{ uri: videoUri }}
          style={StyleSheet.absoluteFillObject}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay={isPlaying}
          isLooping={false}
          isMuted={false}
          onLoad={() => {
            setVideoReady(true);
            seekToStart();
          }}
          onPlaybackStatusUpdate={(status) => {
            if (status.didJustFinish) {
              setIsPlaying(false);
              seekToStart();
            }
          }}
        />
        {/* Play/pause overlay */}
        <TouchableOpacity
          style={styles.playOverlay}
          activeOpacity={1}
          onPress={() => setIsPlaying((p) => !p)}
        >
          {!isPlaying && (
            <View style={styles.playBtn}>
              <Feather name="play" size={28} color="#fff" />
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* Timeline */}
      <View style={[styles.timelineSection, { backgroundColor: colors.surface }]}>
        {/* Duration labels */}
        <View style={styles.timeLabelRow}>
          <Text style={[styles.timeLabel, { color: colors.textSub }]}>{fmtSec(trim.startRatio * dur)}</Text>
          <Text style={[styles.infoText, { color: colors.text }]}>
            {fmtSec(selectedSec)} · {trim.numClips > 1
              ? `${trim.numClips} clips × ${fmtSec(clipSec)}`
              : fmtSec(clipSec)}
          </Text>
          <Text style={[styles.timeLabel, { color: colors.textSub }]}>{fmtSec(trim.endRatio * dur)}</Text>
        </View>

        {/* Bar */}
        <View
          ref={barRef}
          style={[styles.barTrack, { width: BAR_W, marginHorizontal: PAD }]}
          onLayout={onBarLayout}
        >
          {/* Full bar background */}
          <View style={[styles.barBg, { width: BAR_W }]} />

          {/* Selected region */}
          <View
            style={[styles.barSelected, {
              left: startPx,
              width: selectedPx,
              height: SELECTED_H,
              top: (BAR_H - SELECTED_H) / 2,
            }]}
          />

          {/* Clip dividers */}
          {dividerPositions.map((x, i) => (
            <View key={i} style={[styles.divider, { left: x - 1 }]} />
          ))}

          {/* Start handle */}
          <View
            {...startPan.panHandlers}
            style={[styles.handle, {
              left: startPx - HANDLE_R,
              backgroundColor: colors.accent,
            }]}
            hitSlop={{ top: 16, right: 8, bottom: 16, left: 16 }}
          />

          {/* End handle */}
          <View
            {...endPan.panHandlers}
            style={[styles.handle, {
              left: endPx - HANDLE_R,
              backgroundColor: colors.accent,
            }]}
            hitSlop={{ top: 16, right: 16, bottom: 16, left: 8 }}
          />
        </View>

        {/* Total duration hint */}
        <Text style={[styles.totalDurHint, { color: colors.textMuted }]}>
          Total: {fmtSec(dur)}
        </Text>

        {/* Clip count chips — only show if splitting makes sense */}
        {dur > 5 && (
          <View style={styles.clipsRow}>
            <Text style={[styles.clipsLabel, { color: colors.textSub }]}>Clips:</Text>
            {[1, 2, 3, 4, 5].slice(0, maxClips).map((n) => {
              const active = trim.numClips === n;
              const disabled = n > maxClipsAllowed;
              return (
                <TouchableOpacity
                  key={n}
                  style={[
                    styles.clipChip,
                    { borderColor: colors.border, backgroundColor: colors.card },
                    active && { backgroundColor: colors.accent, borderColor: colors.accent },
                    disabled && { opacity: 0.3 },
                  ]}
                  onPress={() => !disabled && changeNumClips(n)}
                  disabled={disabled}
                >
                  <Text style={[styles.clipChipText, { color: colors.textSub }, active && { color: colors.accentText, fontWeight: '700' }]}>
                    {n}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Footer buttons */}
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Feather name="arrow-left" size={20} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.confirmBtn, { backgroundColor: colors.accent }, !canConfirm && { opacity: 0.4 }]}
            onPress={() => canConfirm && onConfirm({ startSec: trim.startRatio * dur, endSec: trim.endRatio * dur, numClips: trim.numClips })}
            disabled={!canConfirm}
          >
            <Text style={[styles.confirmText, { color: colors.accentText }]}>
              Caption  →
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  videoWrap: { flex: 1, backgroundColor: '#000', position: 'relative' },
  videoLoading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playBtn: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
    paddingLeft: 3,
  },
  timelineSection: { paddingTop: 16, paddingBottom: 8 },
  timeLabelRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 24, marginBottom: 12,
  },
  timeLabel: { fontSize: 11, fontVariant: ['tabular-nums'] },
  infoText: { fontSize: 12, fontWeight: '600' },
  barTrack: {
    height: SELECTED_H + 4,
    position: 'relative', justifyContent: 'center',
    marginBottom: 4,
  },
  barBg: {
    position: 'absolute', height: BAR_H, top: (SELECTED_H - BAR_H) / 2 + 2,
    backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: BAR_H / 2,
  },
  barSelected: {
    position: 'absolute', backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 3,
  },
  divider: {
    position: 'absolute', width: 2, height: SELECTED_H,
    top: (BAR_H - SELECTED_H) / 2 + 2,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  handle: {
    position: 'absolute', width: HANDLE_R * 2, height: HANDLE_R * 2,
    borderRadius: HANDLE_R, top: BAR_H / 2 + 2 - HANDLE_R,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4,
    elevation: 4,
  },
  totalDurHint: { fontSize: 10, textAlign: 'center', marginBottom: 10 },
  clipsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 24, marginBottom: 12,
  },
  clipsLabel: { fontSize: 12, marginRight: 4 },
  clipChip: {
    width: 36, height: 36, borderRadius: 18, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  clipChipText: { fontSize: 14 },
  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderTopWidth: 1,
  },
  backBtn: { padding: 10 },
  confirmBtn: { borderRadius: 10, paddingVertical: 13, paddingHorizontal: 28 },
  confirmText: { fontWeight: '700', fontSize: 15 },
});
