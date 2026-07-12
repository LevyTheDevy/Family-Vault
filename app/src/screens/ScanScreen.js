import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView,
  TextInput, KeyboardAvoidingView, Platform, ScrollView, useColorScheme,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';

function useTheme() {
  const scheme = useColorScheme();
  const dark = scheme !== 'light';
  return {
    dark,
    bg:               dark ? '#000'     : '#ffffff',
    card:             dark ? '#0d0d0d'  : '#f5f5f5',
    input:            dark ? '#111'     : '#f0f0f0',
    border:           dark ? '#1e1e1e'  : '#e0e0e0',
    text:             dark ? '#fff'     : '#000',
    textMuted:        dark ? '#8e8e93'  : '#636366',
    tabActiveBg:      dark ? '#fff'     : '#000',
    tabActiveText:    dark ? '#000'     : '#fff',
    tabInactiveText:  dark ? '#8e8e93'  : '#75757a',
    btnBg:            dark ? '#fff'     : '#000',
    btnText:          dark ? '#000'     : '#fff',
    iconMuted:        dark ? '#333'     : '#bbb',
    errorText:        '#e53935',
    frameBorder:      dark ? '#fff'     : '#000',
    hintText:         dark ? '#9a9a9e'  : '#75757a',
  };
}

function parseCode(raw) {
  const s = raw.trim();

  // New E2E invite: http://host:port/invite/<64-hex-token>
  const e2eInvite = s.match(/^(https?:\/\/[^/]+)\/invite\/([0-9a-f]{64})$/i);
  if (e2eInvite) {
    return { type: 'invite', serverUrl: e2eInvite[1], inviteToken: e2eInvite[2].toLowerCase() };
  }

  // Legacy 6-char invite code: host/ABCDEF
  const legacyMatch = s.match(/^(?:(https?):\/\/)?([^/?#]+)\/([A-Fa-f0-9]{6})([?#].*)?$/i);
  if (legacyMatch) {
    const [, proto, host, code, query = ''] = legacyMatch;
    const scheme = proto || (host.includes(':') ? 'http' : 'https');
    const vk = new URLSearchParams(query.replace(/^[?#]/, '')).get('vk') || null;
    return { type: 'vault', vaultUrl: `${scheme}://${host}`, inviteCode: code.toUpperCase(), accessKey: vk };
  }

  // Plain vault URL
  const url = s.startsWith('http') ? s : (s.includes(':') ? `http://${s}` : `https://${s}`);
  try {
    const parsed = new URL(url);
    const vk = parsed.searchParams.get('vk') || null;
    parsed.search = '';
    return { type: 'vault', vaultUrl: parsed.toString().replace(/\/$/, ''), inviteCode: null, accessKey: vk };
  } catch {
    return { type: 'vault', vaultUrl: url, inviteCode: null, accessKey: null };
  }
}

export default function ScanScreen({ navigation, route }) {
  const addMode = route.params?.addMode ?? false;
  const [tab, setTab] = useState('scan');
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [manualError, setManualError] = useState('');
  const t = useTheme();
  const s = makeStyles(t);

  useFocusEffect(useCallback(() => { setScanned(false); }, []));

  const proceed = (raw) => {
    const parsed = parseCode(raw);
    if (parsed.type === 'invite') {
      navigation.navigate('Join', { serverUrl: parsed.serverUrl, inviteToken: parsed.inviteToken, addMode });
    } else {
      navigation.navigate('Auth', { vaultUrl: parsed.vaultUrl, inviteCode: parsed.inviteCode, addMode, accessKey: parsed.accessKey });
    }
  };

  const handleBarCodeScanned = ({ data }) => {
    if (scanned) return;
    setScanned(true);
    let raw = data.trim();
    try { raw = JSON.parse(raw).url || raw; } catch {}
    proceed(raw);
  };

  const handleManualSubmit = () => {
    const code = manualCode.trim();
    if (!code) { setManualError('Enter a vault code or address'); return; }
    if (!code.includes('/') && !code.includes(':') && !code.startsWith('http')) {
      setManualError('Format: yourserver.com/ABC123 or 192.168.1.5:3000/ABC123');
      return;
    }
    setManualError('');
    proceed(code);
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <Text style={s.title}>FamilyVault</Text>
        <Text style={s.subtitle}>{addMode ? 'Connect another vault' : 'Connect to your vault'}</Text>
      </View>

      <View style={s.tabs}>
        <TouchableOpacity style={[s.tab, tab === 'scan' && s.tabActive]} onPress={() => setTab('scan')}>
          <Feather name="camera" size={14} color={tab === 'scan' ? t.tabActiveText : t.tabInactiveText} />
          <Text style={[s.tabText, tab === 'scan' && s.tabTextActive]}>Scan QR</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, tab === 'code' && s.tabActive]} onPress={() => setTab('code')}>
          <Feather name="link" size={14} color={tab === 'code' ? t.tabActiveText : t.tabInactiveText} />
          <Text style={[s.tabText, tab === 'code' && s.tabTextActive]}>Enter Link</Text>
        </TouchableOpacity>
      </View>

      {tab === 'scan' ? (
        !permission ? (
          <View style={s.center}>
            <Text style={s.text}>Requesting camera...</Text>
          </View>
        ) : !permission.granted ? (
          <View style={s.center}>
            <Feather name="camera-off" size={36} color={t.iconMuted} />
            <Text style={s.text}>Camera access needed</Text>
            <TouchableOpacity style={s.btn} onPress={requestPermission}>
              <Text style={s.btnText}>Grant Permission</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <CameraView
              style={s.camera}
              onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            >
              <View style={s.overlay}>
                <View style={s.frame} />
                <Text style={s.hint}>Point at the QR code shown in your browser</Text>
              </View>
            </CameraView>
            {scanned && (
              <TouchableOpacity style={s.rescanRow} onPress={() => setScanned(false)}>
                <Text style={s.rescanText}>Scan again</Text>
              </TouchableOpacity>
            )}
          </View>
        )
      ) : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView contentContainerStyle={s.codeWrap} keyboardShouldPersistTaps="handled">
            <View style={s.codeCard}>
              <Feather name="key" size={32} color={t.iconMuted} style={{ marginBottom: 16 }} />
              <Text style={s.codeTitle}>Enter your invite link</Text>
              <Text style={s.codeDesc}>
                Paste the invite link shared by your admin
              </Text>

              <TextInput
                style={s.codeInput}
                placeholder="http://192.168.1.x:3000/invite/..."
                placeholderTextColor={t.textMuted}
                value={manualCode}
                onChangeText={(v) => { setManualCode(v); setManualError(''); }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={handleManualSubmit}
              />

              {!!manualError && <Text style={s.errorText}>{manualError}</Text>}

              <TouchableOpacity style={[s.btn, { width: '100%', marginTop: 4 }]} onPress={handleManualSubmit}>
                <Text style={s.btnText}>Connect</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(t) {
  return StyleSheet.create({
    container:      { flex: 1, backgroundColor: t.bg },
    center:         { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 20 },
    header:         { padding: 24, paddingBottom: 16 },
    title:          { color: t.text, fontSize: 26, fontWeight: '700' },
    subtitle:       { color: t.textMuted, fontSize: 13, marginTop: 4 },
    text:           { color: t.text, fontSize: 15, textAlign: 'center' },
    tabs: {
      flexDirection: 'row', marginHorizontal: 20, marginBottom: 16,
      backgroundColor: t.card, borderRadius: 10, borderWidth: 1, borderColor: t.border,
      overflow: 'hidden',
    },
    tab:            { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12 },
    tabActive:      { backgroundColor: t.tabActiveBg },
    tabText:        { color: t.tabInactiveText, fontSize: 13, fontWeight: '500' },
    tabTextActive:  { color: t.tabActiveText, fontWeight: '700' },
    camera:         { flex: 1 },
    overlay:        { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 },
    frame:          { width: 230, height: 230, borderWidth: 2, borderColor: t.frameBorder, borderRadius: 12 },
    hint:           { color: t.hintText, fontSize: 13, textAlign: 'center', paddingHorizontal: 40 },
    rescanRow:      { padding: 20, alignItems: 'center' },
    rescanText:     { color: t.textMuted, fontSize: 14, textDecorationLine: 'underline' },
    codeWrap:       { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    codeCard:       { width: '100%', alignItems: 'center', gap: 12 },
    codeTitle:      { color: t.text, fontSize: 18, fontWeight: '600', textAlign: 'center' },
    codeDesc:       { color: t.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20 },
    codeExample:    { color: t.text, fontFamily: 'monospace', letterSpacing: 1 },
    codeInput: {
      width: '100%', backgroundColor: t.input, color: t.text,
      borderWidth: 1, borderColor: t.border, borderRadius: 10,
      padding: 15, fontSize: 15, marginTop: 8,
      fontFamily: 'monospace', letterSpacing: 0.5,
    },
    errorText:      { color: t.errorText, fontSize: 13, alignSelf: 'flex-start' },
    btn:            { backgroundColor: t.btnBg, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 32, alignItems: 'center' },
    btnText:        { color: t.btnText, fontWeight: '700', fontSize: 15 },
  });
}
