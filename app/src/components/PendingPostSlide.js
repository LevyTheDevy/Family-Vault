import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';

// Full-height feed slide for a post that's still uploading in the background.
// Same height as real posts so the feed's paging/getItemLayout stay valid.
export default function PendingPostSlide({ item, height, onRetry, onDiscard }) {
  const failed = item.status === 'failed';
  const pct = Math.round((item.progress || 0) * 100);

  return (
    <View style={[styles.container, { height }]}>
      {item.payload?.previewUri ? (
        <Image
          source={{ uri: item.payload.previewUri }}
          style={StyleSheet.absoluteFillObject}
          resizeMode="cover"
          blurRadius={failed ? 3 : 0}
        />
      ) : (
        <View style={[StyleSheet.absoluteFillObject, styles.videoBg]}>
          <Feather name="video" size={48} color="rgba(255,255,255,0.25)" />
        </View>
      )}
      <View style={styles.dim} pointerEvents="none" />

      {failed ? (
        <View style={styles.centerBox}>
          <Feather name="alert-triangle" size={30} color="#ff6b6b" />
          <Text style={styles.failTitle}>Post didn't upload</Text>
          <Text style={styles.failMsg}>{item.error}</Text>
          <View style={styles.btnRow}>
            <TouchableOpacity style={[styles.btn, styles.retryBtn]} onPress={onRetry}>
              <Feather name="refresh-cw" size={14} color="#fff" />
              <Text style={styles.btnText}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.discardBtn]} onPress={onDiscard}>
              <Feather name="trash-2" size={14} color="#fff" />
              <Text style={styles.btnText}>Discard</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.centerBox}>
          <ActivityIndicator color="#fff" size="large" />
          <Text style={styles.stageText}>{item.stage}{pct > 0 ? `  ${pct}%` : ''}</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.max(pct, 2)}%` }]} />
          </View>
          <Text style={styles.hint}>Uploading in the background — keep browsing</Text>
        </View>
      )}

      {!!item.payload?.caption && (
        <Text style={styles.caption} numberOfLines={2}>{item.payload.caption}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', backgroundColor: '#000' },
  videoBg: { backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  centerBox: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 40,
  },
  stageText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  track: {
    width: '70%', height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: '#fff', borderRadius: 2 },
  hint: { color: 'rgba(255,255,255,0.6)', fontSize: 12, textAlign: 'center' },
  failTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  failMsg: { color: 'rgba(255,255,255,0.75)', fontSize: 13, textAlign: 'center', lineHeight: 18 },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 6 },
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    borderRadius: 22, paddingVertical: 10, paddingHorizontal: 20,
  },
  retryBtn: { backgroundColor: '#1a7a3f' },
  discardBtn: { backgroundColor: 'rgba(255,255,255,0.18)' },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  caption: {
    position: 'absolute', bottom: 40, left: 16, right: 16,
    color: '#fff', fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6,
  },
});
