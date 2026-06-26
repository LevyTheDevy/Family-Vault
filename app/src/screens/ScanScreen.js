import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView,
  TextInput, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Feather } from '@expo/vector-icons';

// Supported formats:
//   https://fam-vault.com/ABC123   (public domain — HTTPS)
//   192.168.1.5:3000/ABC123        (local — HTTP)
//   https://fam-vault.com          (plain vault URL, no code)
function parseCode(raw) {
  const s = raw.trim();
  // Match host/CODE where host can be domain or IP:port
  const inviteMatch = s.match(/^(?:(https?):\/\/)?([^/?#]+)\/([A-Fa-f0-9]{6})$/i);
  if (inviteMatch) {
    const [, proto, host, code] = inviteMatch;
    const scheme = proto || (host.includes(':') ? 'http' : 'https');
    return { vaultUrl: `${scheme}://${host}`, inviteCode: code.toUpperCase() };
  }
  // Plain vault URL (no code)
  const url = s.startsWith('http') ? s : (s.includes(':') ? `http://${s}` : `https://${s}`);
  return { vaultUrl: url, inviteCode: null };
}

export default function ScanScreen({ navigation }) {
  const [tab, setTab] = useState('scan'); // 'scan' | 'code'
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [manualError, setManualError] = useState('');

  const proceed = (raw) => {
    const { vaultUrl, inviteCode } = parseCode(raw);
    navigation.navigate('Auth', { vaultUrl, inviteCode });
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
      setManualError('Format: fam-vault.com/ABC123 or 192.168.1.5:3000/ABC123');
      return;
    }
    setManualError('');
    proceed(code);
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>FamilyVault</Text>
        <Text style={styles.subtitle}>Connect to your vault</Text>
      </View>

      {/* Tab switcher */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, tab === 'scan' && styles.tabActive]}
          onPress={() => setTab('scan')}
        >
          <Feather name="camera" size={14} color={tab === 'scan' ? '#000' : '#555'} />
          <Text style={[styles.tabText, tab === 'scan' && styles.tabTextActive]}>Scan QR</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === 'code' && styles.tabActive]}
          onPress={() => setTab('code')}
        >
          <Feather name="type" size={14} color={tab === 'code' ? '#000' : '#555'} />
          <Text style={[styles.tabText, tab === 'code' && styles.tabTextActive]}>Enter Code</Text>
        </TouchableOpacity>
      </View>

      {tab === 'scan' ? (
        // ── QR scanner ──
        !permission ? (
          <View style={styles.center}>
            <Text style={styles.text}>Requesting camera...</Text>
          </View>
        ) : !permission.granted ? (
          <View style={styles.center}>
            <Feather name="camera-off" size={36} color="#333" />
            <Text style={styles.text}>Camera access needed</Text>
            <TouchableOpacity style={styles.button} onPress={requestPermission}>
              <Text style={styles.buttonText}>Grant Permission</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <CameraView
              style={styles.camera}
              onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            >
              <View style={styles.overlay}>
                <View style={styles.frame} />
                <Text style={styles.hint}>Point at the QR code shown in your browser</Text>
              </View>
            </CameraView>
            {scanned && (
              <TouchableOpacity style={styles.rescanRow} onPress={() => setScanned(false)}>
                <Text style={styles.rescanText}>Scan again</Text>
              </TouchableOpacity>
            )}
          </View>
        )
      ) : (
        // ── Manual code entry ──
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView contentContainerStyle={styles.codeWrap} keyboardShouldPersistTaps="handled">
            <View style={styles.codeCard}>
              <Feather name="key" size={32} color="#333" style={{ marginBottom: 16 }} />
              <Text style={styles.codeTitle}>Enter your vault code</Text>
              <Text style={styles.codeDesc}>
                Your admin provides a vault code that looks like:{'\n'}
                <Text style={styles.codeExample}>fam-vault.com/A3B2C8</Text>
              </Text>

              <TextInput
                style={styles.codeInput}
                placeholder="fam-vault.com/ABC123"
                placeholderTextColor="#333"
                value={manualCode}
                onChangeText={(t) => { setManualCode(t); setManualError(''); }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={handleManualSubmit}
              />

              {!!manualError && <Text style={styles.errorText}>{manualError}</Text>}

              <TouchableOpacity
                style={[styles.button, { width: '100%', marginTop: 4 }]}
                onPress={handleManualSubmit}
              >
                <Text style={styles.buttonText}>Connect</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 20 },
  header: { padding: 24, paddingBottom: 16 },
  title: { color: '#fff', fontSize: 26, fontWeight: '700' },
  subtitle: { color: '#444', fontSize: 13, marginTop: 4 },
  text: { color: '#fff', fontSize: 15, textAlign: 'center' },

  // Tabs
  tabs: {
    flexDirection: 'row', marginHorizontal: 20, marginBottom: 16,
    backgroundColor: '#0d0d0d', borderRadius: 10, borderWidth: 1, borderColor: '#1e1e1e',
    overflow: 'hidden',
  },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12 },
  tabActive: { backgroundColor: '#fff' },
  tabText: { color: '#555', fontSize: 13, fontWeight: '500' },
  tabTextActive: { color: '#000', fontWeight: '700' },

  // Scanner
  camera: { flex: 1 },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 },
  frame: { width: 230, height: 230, borderWidth: 2, borderColor: '#fff', borderRadius: 12 },
  hint: { color: '#666', fontSize: 13, textAlign: 'center', paddingHorizontal: 40 },
  rescanRow: { padding: 20, alignItems: 'center' },
  rescanText: { color: '#555', fontSize: 14, textDecorationLine: 'underline' },

  // Manual code
  codeWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  codeCard: { width: '100%', alignItems: 'center', gap: 12 },
  codeTitle: { color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center' },
  codeDesc: { color: '#444', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  codeExample: { color: '#fff', fontFamily: 'monospace', letterSpacing: 1 },
  codeInput: {
    width: '100%', backgroundColor: '#111', color: '#fff',
    borderWidth: 1, borderColor: '#222', borderRadius: 10,
    padding: 15, fontSize: 15, marginTop: 8,
    fontFamily: 'monospace', letterSpacing: 0.5,
  },
  errorText: { color: '#e53935', fontSize: 13, alignSelf: 'flex-start' },
  button: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, paddingHorizontal: 32, alignItems: 'center' },
  buttonText: { color: '#000', fontWeight: '700', fontSize: 15 },
});
