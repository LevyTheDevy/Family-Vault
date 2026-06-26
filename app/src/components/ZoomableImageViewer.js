import React, { useRef, useEffect } from 'react';
import {
  Modal, View, Animated, PanResponder, StyleSheet, TouchableOpacity,
  Dimensions, StatusBar,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import CachedImage from './CachedImage';

const { width: W, height: H } = Dimensions.get('window');
const MIN_SCALE = 1;
const MAX_SCALE = 5;

function dist(a, b) {
  const dx = a.pageX - b.pageX;
  const dy = a.pageY - b.pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

function mid(a, b) {
  return { x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 };
}

export default function ZoomableImageViewer({ visible, uri, onClose }) {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  // "committed" values — updated when gesture ends
  const baseScale = useRef(1);
  const baseTx = useRef(0);
  const baseTy = useRef(0);

  // pinch tracking
  const initialDist = useRef(null);
  const initialMid = useRef(null);

  const lastTap = useRef(0);

  const reset = () => {
    baseScale.current = 1;
    baseTx.current = 0;
    baseTy.current = 0;
    scale.setValue(1);
    translateX.setValue(0);
    translateY.setValue(0);
  };

  useEffect(() => { if (!visible) reset(); }, [visible]);

  const clampTranslate = (tx, ty, sc) => {
    const maxTx = Math.max(0, ((W * sc) - W) / 2);
    const maxTy = Math.max(0, ((H * sc) - H) / 2);
    return {
      tx: Math.min(maxTx, Math.max(-maxTx, tx)),
      ty: Math.min(maxTy, Math.max(-maxTy, ty)),
    };
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const touches = e.nativeEvent.touches;
        if (touches.length === 1) {
          // Check for double-tap
          const now = Date.now();
          if (now - lastTap.current < 280) {
            lastTap.current = 0;
            // Toggle zoom
            if (baseScale.current > 1.2) {
              Animated.parallel([
                Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
                Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
                Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
              ]).start(() => { baseScale.current = 1; baseTx.current = 0; baseTy.current = 0; });
            } else {
              const targetScale = 2.5;
              const touch = touches[0];
              const tx = (W / 2 - touch.pageX) * (targetScale - 1);
              const ty = (H / 2 - touch.pageY) * (targetScale - 1);
              const clamped = clampTranslate(tx, ty, targetScale);
              Animated.parallel([
                Animated.spring(scale, { toValue: targetScale, useNativeDriver: true }),
                Animated.spring(translateX, { toValue: clamped.tx, useNativeDriver: true }),
                Animated.spring(translateY, { toValue: clamped.ty, useNativeDriver: true }),
              ]).start(() => { baseScale.current = targetScale; baseTx.current = clamped.tx; baseTy.current = clamped.ty; });
            }
          } else {
            lastTap.current = now;
          }
          initialDist.current = null;
        } else if (touches.length === 2) {
          initialDist.current = dist(touches[0], touches[1]);
          initialMid.current = mid(touches[0], touches[1]);
        }
      },
      onPanResponderMove: (e, g) => {
        const touches = e.nativeEvent.touches;
        if (touches.length === 2) {
          // Pinch
          const d = dist(touches[0], touches[1]);
          if (initialDist.current) {
            const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, baseScale.current * (d / initialDist.current)));
            scale.setValue(newScale);
          }
          // Pan while pinching
          const m = mid(touches[0], touches[1]);
          if (initialMid.current) {
            const dx = (m.x - initialMid.current.x);
            const dy = (m.y - initialMid.current.y);
            const sc = baseScale.current;
            const clamped = clampTranslate(baseTx.current + dx, baseTy.current + dy, sc);
            translateX.setValue(clamped.tx);
            translateY.setValue(clamped.ty);
          }
        } else if (touches.length === 1 && !initialDist.current) {
          // Single finger pan (only when zoomed in)
          const sc = baseScale.current;
          if (sc <= 1.05) return;
          const clamped = clampTranslate(baseTx.current + g.dx, baseTy.current + g.dy, sc);
          translateX.setValue(clamped.tx);
          translateY.setValue(clamped.ty);
        }
      },
      onPanResponderRelease: (e, g) => {
        const touches = e.nativeEvent.touches;
        // Commit current values
        const scVal = baseScale.current;

        if (e.nativeEvent.changedTouches.length >= 2 || initialDist.current) {
          // Was a pinch — commit scale
          // Read current animated value
          scale.stopAnimation((v) => {
            const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));
            baseScale.current = clamped;
            scale.setValue(clamped);
            // If scale snaps to 1 range, center
            if (clamped <= 1.05) {
              baseScale.current = 1;
              baseTx.current = 0;
              baseTy.current = 0;
              Animated.parallel([
                Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
                Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
                Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
              ]).start();
            }
          });
          translateX.stopAnimation((v) => { baseTx.current = v; });
          translateY.stopAnimation((v) => { baseTy.current = v; });
          initialDist.current = null;
          initialMid.current = null;
        } else {
          // Was a pan
          translateX.stopAnimation((v) => {
            const c = clampTranslate(v, baseTy.current, scVal);
            baseTx.current = c.tx;
            translateX.setValue(c.tx);
          });
          translateY.stopAnimation((v) => {
            const c = clampTranslate(baseTx.current, v, scVal);
            baseTy.current = c.ty;
            translateY.setValue(c.ty);
          });
        }
      },
    })
  ).current;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar hidden />
      <View style={styles.backdrop}>
        <Animated.View
          style={[styles.imageWrap, { transform: [{ scale }, { translateX }, { translateY }] }]}
          {...panResponder.panHandlers}
        >
          <CachedImage uri={uri} style={styles.image} resizeMode="contain" />
        </Animated.View>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose} hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}>
          <Feather name="x" size={22} color="#fff" />
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  imageWrap: { width: W, height: H },
  image: { width: '100%', height: '100%' },
  closeBtn: { position: 'absolute', top: 52, right: 20, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: 8 },
});
