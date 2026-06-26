import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Modal, View, StyleSheet,
  TouchableOpacity, Text, Dimensions, ActivityIndicator,
  Animated, Image,
} from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';

const { width: SW, height: SH } = Dimensions.get('window');

export default function PhotoAdjustModal({ visible, uri, cropRatio, onConfirm, onCancel }) {
  const fw = SW;
  const fh = cropRatio
    ? Math.min(SH * 0.7, SW * cropRatio[1] / cropRatio[0])
    : SH * 0.65;

  const [applying, setApplying] = useState(false);
  // State triggers re-render so Animated.View gets correct cover-scaled dimensions
  const [imgDims, setImgDims] = useState(null);

  // All mutable gesture state in refs (PanResponder / touch handlers are closures)
  const imgSizeRef     = useRef(null);  // { width, height } of source image
  const coverScaleRef  = useRef(1);     // scale that makes image fill frame
  const scaleRef       = useRef(1);     // user zoom (multiplicative on top of coverScale)
  const txRef          = useRef(0);     // committed pan offset X
  const tyRef          = useRef(0);     // committed pan offset Y

  // Touch tracking — incremental deltas, not cumulative from gesture start
  const lastTouchRef   = useRef(null);  // { type:'pan'|'pinch', ... }

  const animScale = useRef(new Animated.Value(1)).current;
  const animTx    = useRef(new Animated.Value(0)).current;
  const animTy    = useRef(new Animated.Value(0)).current;

  const resetTransform = useCallback(() => {
    scaleRef.current = 1;
    txRef.current = 0;
    tyRef.current = 0;
    animScale.setValue(1);
    animTx.setValue(0);
    animTy.setValue(0);
    lastTouchRef.current = null;
  }, []);

  useEffect(() => {
    if (!visible) {
      resetTransform();
      imgSizeRef.current = null;
      coverScaleRef.current = 1;
      setImgDims(null);
    } else if (uri) {
      Image.getSize(uri, (w, h) => {
        const cs = Math.max(fw / w, fh / h);
        imgSizeRef.current = { width: w, height: h };
        coverScaleRef.current = cs;
        setImgDims({ width: w, height: h, cs });
        resetTransform();
      }, () => {});
    }
  }, [visible, uri]);

  // Clamp so image always covers the frame (no black gaps)
  const clampPos = (tx, ty, sc) => {
    const is = imgSizeRef.current;
    const cs = coverScaleRef.current;
    if (!is) return { tx, ty };
    const dispW = is.width  * cs * sc;
    const dispH = is.height * cs * sc;
    const maxTx = Math.max(0, (dispW - fw) / 2);
    const maxTy = Math.max(0, (dispH - fh) / 2);
    return {
      tx: Math.max(-maxTx, Math.min(maxTx, tx)),
      ty: Math.max(-maxTy, Math.min(maxTy, ty)),
    };
  };

  const touchDist = (a, b) => {
    const dx = a.pageX - b.pageX;
    const dy = a.pageY - b.pageY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // ── Touch handlers ─────────────────────────────────────────────────────────
  const handleTouchStart = (e) => {
    const t = e.nativeEvent.touches;
    if (t.length >= 2) {
      lastTouchRef.current = {
        type: 'pinch',
        dist: touchDist(t[0], t[1]),
        cx: (t[0].pageX + t[1].pageX) / 2,
        cy: (t[0].pageY + t[1].pageY) / 2,
        scale0: scaleRef.current,
      };
    } else {
      lastTouchRef.current = {
        type: 'pan',
        x: t[0].pageX,
        y: t[0].pageY,
      };
    }
  };

  const handleTouchMove = (e) => {
    const t = e.nativeEvent.touches;
    const last = lastTouchRef.current;
    if (!last) return;

    if (t.length >= 2) {
      const d  = touchDist(t[0], t[1]);
      const cx = (t[0].pageX + t[1].pageX) / 2;
      const cy = (t[0].pageY + t[1].pageY) / 2;

      if (last.type === 'pan') {
        // Second finger just arrived — switch to pinch, initialise
        lastTouchRef.current = { type: 'pinch', dist: d, cx, cy, scale0: scaleRef.current };
        return;
      }

      // Pinch scale (relative to when this pinch gesture started)
      const newScale = Math.max(1, Math.min(6, last.scale0 * (d / last.dist)));
      scaleRef.current = newScale;
      animScale.setValue(newScale);

      // Pan with centroid so user can pan + pinch simultaneously
      const ddx = cx - last.cx;
      const ddy = cy - last.cy;
      const c = clampPos(txRef.current + ddx, tyRef.current + ddy, newScale);
      txRef.current = c.tx;
      tyRef.current = c.ty;
      animTx.setValue(c.tx);
      animTy.setValue(c.ty);

      // Update centroid but keep dist/scale0 fixed — so scale is relative to pinch start
      lastTouchRef.current = { type: 'pinch', dist: last.dist, cx, cy, scale0: last.scale0 };

    } else if (t.length === 1) {
      if (last.type === 'pinch') {
        // One finger lifted — switch back to pan from current position
        lastTouchRef.current = { type: 'pan', x: t[0].pageX, y: t[0].pageY };
        return;
      }
      const ddx = t[0].pageX - last.x;
      const ddy = t[0].pageY - last.y;
      const c = clampPos(txRef.current + ddx, tyRef.current + ddy, scaleRef.current);
      txRef.current = c.tx;
      tyRef.current = c.ty;
      animTx.setValue(c.tx);
      animTy.setValue(c.ty);
      lastTouchRef.current = { type: 'pan', x: t[0].pageX, y: t[0].pageY };
    }
  };

  const handleTouchEnd = (e) => {
    const t = e.nativeEvent.touches;
    if (t.length === 0) {
      lastTouchRef.current = null;
    } else if (t.length === 1) {
      lastTouchRef.current = { type: 'pan', x: t[0].pageX, y: t[0].pageY };
    }
  };
  // ──────────────────────────────────────────────────────────────────────────

  const handleApply = async () => {
    if (!uri) { onConfirm(uri); return; }
    const is = imgSizeRef.current;
    const cs = coverScaleRef.current;
    const sc = scaleRef.current;
    const tx = txRef.current;
    const ty = tyRef.current;
    if (!is) { onConfirm(uri); return; }

    setApplying(true);
    try {
      const totalScale = cs * sc;
      const dispW = is.width  * totalScale;
      const dispH = is.height * totalScale;
      // Top-left of the displayed image relative to frame origin
      const imgLeft = (fw - dispW) / 2 + tx;
      const imgTop  = (fh - dispH) / 2 + ty;
      // Crop region in source-image pixels
      const cropX = Math.max(0, Math.round(-imgLeft / totalScale));
      const cropY = Math.max(0, Math.round(-imgTop  / totalScale));
      const cropW = Math.min(is.width  - cropX, Math.round(fw / totalScale));
      const cropH = Math.min(is.height - cropY, Math.round(fh / totalScale));
      if (cropW < 10 || cropH < 10) { onConfirm(uri); return; }

      const result = await ImageManipulator.manipulateAsync(
        uri,
        [{ crop: { originX: cropX, originY: cropY, width: cropW, height: cropH } }],
        { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
      );
      onConfirm(result.uri);
    } catch {
      onConfirm(uri);
    } finally {
      setApplying(false);
    }
  };

  const imgDisplayW = imgDims ? imgDims.width  * imgDims.cs : fw;
  const imgDisplayH = imgDims ? imgDims.height * imgDims.cs : fh;

  return (
    <Modal visible={visible} transparent={false} animationType="slide" statusBarTranslucent onRequestClose={onCancel}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel} style={styles.headerBtn}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Adjust Photo</Text>
          <TouchableOpacity onPress={handleApply} style={styles.headerBtn} disabled={applying}>
            {applying
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.doneText}>Apply</Text>}
          </TouchableOpacity>
        </View>

        {/* Crop frame — clips overflow, receives touch events */}
        <View
          style={[styles.frame, { width: fw, height: fh }]}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          {!imgDims ? (
            <ActivityIndicator color="#fff" style={{ flex: 1 }} />
          ) : (
            <Animated.View
              style={{
                width: imgDisplayW,
                height: imgDisplayH,
                transform: [
                  { translateX: animTx },
                  { translateY: animTy },
                  { scale: animScale },
                ],
              }}
              pointerEvents="none"
            >
              <Image
                source={{ uri }}
                style={{ width: imgDisplayW, height: imgDisplayH }}
                resizeMode="stretch"
              />
            </Animated.View>
          )}
        </View>

        {/* Corner guides — rendered outside the clip view so they're always visible */}
        <View style={[styles.cornersOverlay, { width: fw, height: fh }]} pointerEvents="none">
          <View style={[styles.corner, styles.tl]} />
          <View style={[styles.corner, styles.tr]} />
          <View style={[styles.corner, styles.bl]} />
          <View style={[styles.corner, styles.br]} />
        </View>

        <View style={styles.hint}>
          <Text style={styles.hintText}>Drag to reposition · Pinch to zoom</Text>
        </View>
      </View>
    </Modal>
  );
}

const C = 24;
const CW = 3;
const HEADER_H = 54 + 14 + 16; // paddingTop + paddingBottom + header height

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 54, paddingBottom: 14,
  },
  headerBtn:   { minWidth: 64 },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancelText:  { color: '#888', fontSize: 15 },
  doneText:    { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  frame: {
    alignSelf: 'center',
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  cornersOverlay: {
    position: 'absolute',
    top: HEADER_H,
    left: 0,
  },
  corner: {
    position: 'absolute',
    width: C, height: C,
    borderColor: '#fff',
  },
  tl: { top: 0,    left: 0,    borderTopWidth: CW,    borderLeftWidth: CW },
  tr: { top: 0,    right: 0,   borderTopWidth: CW,    borderRightWidth: CW },
  bl: { bottom: 0, left: 0,    borderBottomWidth: CW, borderLeftWidth: CW },
  br: { bottom: 0, right: 0,   borderBottomWidth: CW, borderRightWidth: CW },
  hint: { padding: 20, alignItems: 'center' },
  hintText: { color: '#555', fontSize: 12, textAlign: 'center' },
});
