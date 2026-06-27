import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
  useColorScheme,
} from 'react-native';
import { useVault } from '../context/VaultContext';
import { unwrapInviteVaultKey, wrapVaultKey } from '../utils/crypto';

function useTheme() {
  const scheme = useColorScheme();
  const dark = scheme !== 'light';
  return {
    dark,
    bg:          dark ? '#000'    : '#fff',
    card:        dark ? '#0d0d0d' : '#f5f5f5',
    input:       dark ? '#111'    : '#f0f0f0',
    border:      dark ? '#1e1e1e' : '#e0e0e0',
    text:        dark ? '#fff'    : '#000',
    textMuted:   dark ? '#555'    : '#888',
    primaryBtn:  dark ? '#fff'    : '#000',
    primaryBtnText: dark ? '#000' : '#fff',
    errorColor:  '#e53935',
  };
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

export default function JoinScreen({ route, navigation }) {
  const { serverUrl, inviteToken, addMode = false } = route.params;
  const base = serverUrl.replace(/\/$/, '');
  const t = useTheme();
  const { initFirstVault, addVault: addVaultCtx, deriveAndStoreVaultKey } = useVault();

  const [loading, setLoading] = useState(true);
  const [vaultName, setVaultName] = useState('Family Vault');
  const [inviteCrypto, setInviteCrypto] = useState(null); // { inviteKdfSalt, inviteWrappedVaultKey }
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => {
    fetchInvite();
  }, []);

  async function fetchInvite() {
    try {
      const data = await apiFetch(`${base}/invite/${inviteToken}`);
      setVaultName(data.vaultName || 'Family Vault');
      setInviteCrypto({
        inviteKdfSalt: data.inviteKdfSalt,
        inviteWrappedVaultKey: data.inviteWrappedVaultKey,
      });
    } catch (e) {
      setError(e.message || 'Invite is invalid or has expired.');
    } finally {
      setLoading(false);
    }
  }

  async function handleJoin() {
    if (!name.trim()) { setError('Enter your name'); return; }
    if (name.trim().length < 2) { setError('Name must be at least 2 characters'); return; }
    if (!password) { setError('Choose a password'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }

    setSubmitting(true);
    setError('');
    await new Promise(r => setTimeout(r, 80)); // yield so spinner renders before blocking PBKDF2

    try {
      let kdfSalt = null;
      let wrappedVaultKey = null;

      if (inviteCrypto?.inviteKdfSalt && inviteCrypto?.inviteWrappedVaultKey) {
        setStatusMsg('Deriving keys…');
        await new Promise(r => setTimeout(r, 30));
        const vaultKey = await unwrapInviteVaultKey(
          inviteCrypto.inviteKdfSalt,
          inviteCrypto.inviteWrappedVaultKey,
          inviteToken
        );
        setStatusMsg('Securing your account…');
        await new Promise(r => setTimeout(r, 30));
        const wrapped = await wrapVaultKey(vaultKey, password);
        kdfSalt = wrapped.kdfSalt;
        wrappedVaultKey = wrapped.wrappedVaultKey;

        // Store vault key in memory for this session
        await deriveAndStoreVaultKey(kdfSalt, wrappedVaultKey, password);
      }

      const result = await apiFetch(`${base}/join`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          password,
          token: inviteToken,
          kdfSalt,
          wrappedVaultKey,
        }),
      });

      if (addMode) {
        await addVaultCtx({ vaultUrl: base, token: result.token, name: result.name, vaultName });
      } else {
        await initFirstVault({ vaultUrl: base, token: result.token, name: result.name, vaultName });
      }

      navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
    } catch (e) {
      setError(e.message || 'Something went wrong. Try again.');
      setSubmitting(false);
    }
  }

  const s = styles(t);

  if (loading) {
    return (
      <SafeAreaView style={s.root}>
        <ActivityIndicator size="large" color={t.text} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  if (error && !inviteCrypto) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.center}>
          <Text style={s.errorBig}>{error}</Text>
          <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()}>
            <Text style={s.backBtnText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity style={s.backRow} onPress={() => navigation.goBack()}>
            <Text style={s.backArrow}>←</Text>
          </TouchableOpacity>

          <Text style={s.vaultName}>{vaultName}</Text>
          <Text style={s.heading}>Join the vault</Text>
          <Text style={s.sub}>Choose a name and password. Your password protects your data — it cannot be recovered if forgotten.</Text>

          <Text style={s.label}>Your name</Text>
          <TextInput
            style={s.input}
            placeholder="e.g. Grandma"
            placeholderTextColor={t.textMuted}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={40}
          />

          <Text style={s.label}>Password</Text>
          <TextInput
            style={s.input}
            placeholder="At least 8 characters"
            placeholderTextColor={t.textMuted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <Text style={s.label}>Confirm password</Text>
          <TextInput
            style={s.input}
            placeholder="Re-enter password"
            placeholderTextColor={t.textMuted}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            onSubmitEditing={handleJoin}
          />

          {!!error && <Text style={s.error}>{error}</Text>}

          <TouchableOpacity
            style={[s.btn, submitting && s.btnDisabled]}
            onPress={handleJoin}
            disabled={submitting}
          >
            {submitting ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color={t.primaryBtnText} />
                {!!statusMsg && <Text style={[s.btnText, { fontSize: 13 }]}>{statusMsg}</Text>}
              </View>
            ) : (
              <Text style={s.btnText}>Join vault</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = (t) => StyleSheet.create({
  root:        { flex: 1, backgroundColor: t.bg },
  scroll:      { padding: 24, paddingTop: 8 },
  center:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  backRow:     { marginBottom: 16 },
  backArrow:   { fontSize: 22, color: t.text },
  vaultName:   { fontSize: 13, color: t.textMuted, marginBottom: 4, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' },
  heading:     { fontSize: 28, fontWeight: '700', color: t.text, marginBottom: 8 },
  sub:         { fontSize: 14, color: t.textMuted, marginBottom: 28, lineHeight: 20 },
  label:       { fontSize: 12, fontWeight: '600', color: t.textMuted, marginBottom: 6, marginTop: 16, letterSpacing: 0.5, textTransform: 'uppercase' },
  input:       { backgroundColor: t.input, borderRadius: 10, padding: 14, fontSize: 15, color: t.text, borderWidth: 1, borderColor: t.border },
  error:       { color: t.errorColor, fontSize: 13, marginTop: 12 },
  errorBig:    { color: t.errorColor, fontSize: 16, textAlign: 'center', marginBottom: 24 },
  btn:         { backgroundColor: t.primaryBtn, borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 28 },
  btnDisabled: { opacity: 0.5 },
  btnText:     { color: t.primaryBtnText, fontSize: 16, fontWeight: '700' },
  backBtn:     { borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24, marginTop: 8 },
  backBtnText: { color: t.text, fontSize: 15 },
});
