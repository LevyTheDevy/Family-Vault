import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { View, Text, Image, StyleSheet, Animated, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counter = useRef(0);

  // opts: { imageUri } — shows a small thumbnail (e.g. the just-posted photo)
  const show = useCallback((message, type = 'info', duration = 3000, imageUri = null) => {
    const id = ++counter.current;
    setToasts((prev) => [...prev, { id, message, type, imageUri }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), duration);
  }, []);

  const toast = {
    success: (msg, opts = {}) => show(msg, 'success', opts.duration || 3000, opts.imageUri || null),
    error: (msg, opts = {}) => show(msg, 'error', opts.duration || 3500, opts.imageUri || null),
    info: (msg, opts = {}) => show(msg, 'info', opts.duration || 3000, opts.imageUri || null),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastContainer toasts={toasts} />
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

function ToastContainer({ toasts }) {
  const insets = useSafeAreaInsets();
  if (!toasts.length) return null;
  return (
    <View style={[styles.container, { bottom: Math.max(insets.bottom, 16) + 72 }]} pointerEvents="none">
      {toasts.map((t) => <Toast key={t.id} toast={t} />)}
    </View>
  );
}

function Toast({ toast }) {
  const opacity = useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.delay(2400),
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start();
  }, []);

  const bg = toast.type === 'success' ? '#1a7a3f' : toast.type === 'error' ? '#b71c1c' : '#1c1c1e';
  const icon = toast.type === 'success' ? 'check-circle' : toast.type === 'error' ? 'alert-circle' : 'info';

  return (
    <Animated.View style={[styles.toast, { backgroundColor: bg, opacity }]}>
      <View style={styles.row}>
        {toast.imageUri && <Image source={{ uri: toast.imageUri }} style={styles.thumb} />}
        <Feather name={icon} size={16} color="rgba(255,255,255,0.9)" />
        <Text style={[styles.text, styles.textFlex]} numberOfLines={2}>{toast.message}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute', left: 16, right: 16,
    gap: 8, zIndex: 9999,
  },
  toast: {
    borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  text: { color: '#fff', fontSize: 14, fontWeight: '500', textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center' },
  textFlex: { flexShrink: 1, textAlign: 'left' },
  thumb: { width: 34, height: 34, borderRadius: 6 },
});
