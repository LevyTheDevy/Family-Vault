import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DARK = {
  bg: '#000000',
  surface: '#0d0d0d',
  card: '#111111',
  border: '#1e1e1e',
  text: '#ffffff',
  textSub: '#555555',
  textMuted: '#2a2a2a',
  accent: '#ffffff',
  accentText: '#000000',
  bubble: '#161616',
  bubbleMe: '#ffffff',
  bubbleText: '#ffffff',
  bubbleMeText: '#000000',
  inputBg: '#111111',
  tabBar: '#000000',
  tabBorder: '#1a1a1a',
};

const LIGHT = {
  bg: '#f2f2f7',
  surface: '#ffffff',
  card: '#f9f9f9',
  border: '#e0e0e0',
  text: '#000000',
  textSub: '#888888',
  textMuted: '#cccccc',
  accent: '#000000',
  accentText: '#ffffff',
  bubble: '#e5e5ea',
  bubbleMe: '#007aff',
  bubbleText: '#000000',
  bubbleMeText: '#ffffff',
  inputBg: '#f0f0f0',
  tabBar: '#ffffff',
  tabBorder: '#e0e0e0',
};

const ThemeContext = createContext(null);
export const useTheme = () => useContext(ThemeContext);

const ACCENT_PRESETS = [
  '#ffffff', '#000000', '#7c4dff', '#2979ff', '#00bfa5',
  '#ff6d00', '#e91e63', '#43a047', '#f9a825', '#e53935',
];
export { ACCENT_PRESETS };

function isLightColor(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState('dark');
  const [customAccent, setCustomAccentState] = useState('#7c4dff');
  const [customBase, setCustomBaseState] = useState('dark');
  const [bgImageUri, setBgImageState] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.multiGet([
      'fv_theme_mode', 'fv_theme_accent', 'fv_theme_bg', 'fv_theme_custom_base',
    ]).then((pairs) => {
      const map = Object.fromEntries(pairs.filter(([, v]) => v != null));
      if (map.fv_theme_mode) setModeState(map.fv_theme_mode);
      if (map.fv_theme_accent) setCustomAccentState(map.fv_theme_accent);
      if (map.fv_theme_bg) setBgImageState(map.fv_theme_bg || null);
      if (map.fv_theme_custom_base) setCustomBaseState(map.fv_theme_custom_base);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const setMode = (m) => {
    setModeState(m);
    setBgImageState(null);
    AsyncStorage.multiSet([['fv_theme_mode', m], ['fv_theme_bg', '']]);
  };

  const setAccent = (c) => {
    setCustomAccentState(c);
    AsyncStorage.setItem('fv_theme_accent', c);
  };

  const setCustomBase = (b) => {
    setCustomBaseState(b);
    setBgImageState(null);
    AsyncStorage.multiSet([['fv_theme_custom_base', b], ['fv_theme_bg', '']]);
  };

  const setBgImage = (uri) => {
    setBgImageState(uri || null);
    AsyncStorage.setItem('fv_theme_bg', uri || '');
  };

  let colors;
  if (mode === 'light') {
    colors = LIGHT;
  } else if (mode === 'custom') {
    const base = customBase === 'light' ? LIGHT : DARK;
    const accentLight = isLightColor(customAccent);
    colors = {
      ...base,
      accent: customAccent,
      accentText: accentLight ? '#000' : '#fff',
      bubbleMe: customAccent,
      bubbleMeText: accentLight ? '#000' : '#fff',
    };
  } else {
    colors = DARK;
  }

  // true when the current theme uses a light background
  const isLight = mode === 'light' || (mode === 'custom' && customBase === 'light');

  // screen containers become transparent when bg image active so wallpaper shows
  colors = { ...colors, screenBg: bgImageUri ? 'transparent' : colors.bg };

  if (!loaded) return null;

  return (
    <ThemeContext.Provider value={{
      mode, colors, isLight, customAccent, customBase, bgImageUri,
      setMode, setAccent, setCustomBase, setBgImage, ACCENT_PRESETS,
    }}>
      {children}
    </ThemeContext.Provider>
  );
}
