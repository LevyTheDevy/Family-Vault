import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView,
  Image, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
  ScrollView, useColorScheme,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { setVault } from '../utils/api';
import { saveAuth } from '../utils/storage';
import { useVault } from '../context/VaultContext';
import { unwrapVaultKey } from '../utils/crypto';

function useTheme() {
  const scheme = useColorScheme();
  const dark = scheme !== 'light';
  return {
    dark,
    bg:                   dark ? '#000'     : '#ffffff',
    card:                 dark ? '#0d0d0d'  : '#f5f5f5',
    input:                dark ? '#111'     : '#f0f0f0',
    border:               dark ? '#1e1e1e'  : '#e0e0e0',
    borderFocus:          dark ? '#fff'     : '#000',
    text:                 dark ? '#fff'     : '#000',
    textMuted:            dark ? '#555'     : '#888',
    textDim:              dark ? '#333'     : '#bbb',
    label:                dark ? '#555'     : '#888',
    tabActiveBg:          dark ? '#fff'     : '#000',
    tabActiveText:        dark ? '#000'     : '#fff',
    tabInactiveText:      dark ? '#444'     : '#999',
    primaryBtn:           dark ? '#fff'     : '#000',
    primaryBtnText:       dark ? '#000'     : '#fff',
    memberRowBg:          dark ? '#0a0a0a'  : '#f8f8f8',
    memberRowBorder:      dark ? '#1a1a1a'  : '#e8e8e8',
    memberSelectedBorder: dark ? '#fff'     : '#000',
    memberSelectedBg:     dark ? '#111'     : '#efefef',
    memberAvatarBg:       dark ? '#1a1a1a'  : '#e0e0e0',
    avatarPlaceholderBg:  dark ? '#111'     : '#e8e8e8',
    avatarPlaceholderBorder: dark ? '#222'  : '#d0d0d0',
    smallBtnBorder:       dark ? '#222'     : '#d0d0d0',
    forgotText:           dark ? '#555'     : '#888',
    backBtnBorder:        dark ? '#333'     : '#ccc',
    errorColor:           '#e53935',
  };
}

const BASE_URL = (url) => url.replace(/\/$/, '');

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

export default function AuthScreen({ route, navigation }) {
  const { vaultUrl, inviteCode: prefilledInvite, addMode = false, accessKey = null } = route.params;
  const base = BASE_URL(vaultUrl);
  const { initFirstVault, addVault: addVaultCtx, deriveAndStoreVaultKey } = useVault();
  const t = useTheme();

  const [mode, setMode] = useState(prefilledInvite ? 'join' : 'signin');
  const [members, setMembers] = useState([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [vaultError, setVaultError] = useState(null);

  const [selectedMember, setSelectedMember] = useState(null);
  const [signinPassword, setSigninPassword] = useState('');

  const [inviteCode, setInviteCode] = useState(prefilledInvite || '');
  const [fullName, setFullName] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [profilePicUri, setProfilePicUri] = useState(null);

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiFetch(`${base}/members`, accessKey ? { headers: { 'x-vault-key': accessKey } } : {})
      .then((data) => { setMembers(data); setLoadingMembers(false); })
      .catch((e) => { setVaultError(`Cannot reach vault\n${vaultUrl}\n\n${e.message}`); setLoadingMembers(false); });
  }, []);

  const onSuccess = async (token, name, picUri, requiresPasswordReset = false) => {
    let vaultName = 'Family Vault';
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(tid);
      vaultName = (await r.json()).vaultName || 'Family Vault';
    } catch {}

    setVault(base, token, name, picUri);

    if (addMode) {
      await addVaultCtx({ vaultUrl: base, token, name, vaultName, accessKey });
    } else {
      await initFirstVault({ vaultUrl: base, token, name, vaultName, accessKey });
      await saveAuth({ vaultUrl: base, token, name, profilePicUri: picUri });
    }

    if (requiresPasswordReset) {
      navigation.replace('ResetPassword');
    } else {
      navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
    }
  };

  const handleForgotPassword = () => {
    if (!selectedMember) {
      Alert.alert('Select your name first', 'Tap your name from the list, then tap "Forgot password?"');
      return;
    }
    Alert.alert(
      'Forgot password?',
      `Send a reset request to the admin for "${selectedMember}"?\n\nThey will set a temporary password you can sign in with.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send Request', onPress: async () => {
            try {
              await apiFetch(`${base}/request-reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: selectedMember }),
              });
              Alert.alert('Request sent', 'Ask your admin to set a temporary password for you, then sign in with it.');
            } catch (e) {
              Alert.alert('Error', e.message);
            }
          },
        },
      ],
    );
  };

  const handleSignIn = async () => {
    if (!selectedMember) return Alert.alert('Select a member', 'Tap your name from the list.');
    if (!signinPassword) return Alert.alert('Password required', 'Enter your password.');
    setSubmitting(true);
    try {
      const data = await apiFetch(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selectedMember, password: signinPassword }),
      });
      // Derive vault key from server-returned crypto params (non-blocking, best-effort)
      if (data.kdfSalt && data.wrappedVaultKey) {
        deriveAndStoreVaultKey(data.kdfSalt, data.wrappedVaultKey, signinPassword).catch(() => {});
      }
      await onSuccess(data.token, data.name, null, data.requiresPasswordReset || false);
    } catch (e) {
      Alert.alert('Sign in failed', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoin = async () => {
    if (!inviteCode.trim()) return Alert.alert('Invite code required', 'Enter the invite code from your admin.');
    if (!fullName.trim()) return Alert.alert('Name required', 'Enter your full name.');
    if (!joinPassword || joinPassword.length < 8) return Alert.alert('Password too short', 'Password must be at least 8 characters.');
    setSubmitting(true);
    try {
      const data = await apiFetch(`${base}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fullName.trim(), password: joinPassword, inviteCode: inviteCode.trim().toUpperCase() }),
      });

      let savedPicUri = null;
      if (profilePicUri) {
        try {
          const dest = `${FileSystem.documentDirectory}profile.jpg`;
          await FileSystem.copyAsync({ from: profilePicUri, to: dest });
          savedPicUri = dest;
        } catch {
          savedPicUri = profilePicUri;
        }
      }

      await onSuccess(data.token, data.name, savedPicUri);
    } catch (e) {
      Alert.alert('Join failed', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const pickPhoto = async (useCamera) => {
    const picker = useCamera ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
    const permFn = useCamera ? ImagePicker.requestCameraPermissionsAsync : ImagePicker.requestMediaLibraryPermissionsAsync;
    const { status } = await permFn();
    if (status !== 'granted') return Alert.alert('Permission needed');
    const result = await picker({ quality: 0.7, allowsEditing: true, aspect: [1, 1], mediaTypes: ['images'] });
    if (!result.canceled) setProfilePicUri(result.assets[0].uri);
  };

  const initials = fullName.trim().split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
  const s = makeStyles(t);

  if (loadingMembers) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.center}>
          <ActivityIndicator color={t.text} />
          <Text style={s.loadingText}>Connecting to vault...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (vaultError) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.center}>
          <Text style={s.errorTitle}>Cannot reach vault</Text>
          <Text style={s.errorSub}>{vaultUrl}</Text>
          <TouchableOpacity style={s.backButton} onPress={() => navigation.goBack()}>
            <Text style={s.backButtonText}>Scan again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

          <View style={s.header}>
            <Text style={s.title}>FamilyVault</Text>
            <Text style={s.vaultUrl}>{vaultUrl}</Text>
          </View>

          <View style={s.tabs}>
            <TouchableOpacity style={[s.tab, mode === 'signin' && s.tabActive]} onPress={() => setMode('signin')}>
              <Text style={[s.tabText, mode === 'signin' && s.tabTextActive]}>Sign In</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.tab, mode === 'join' && s.tabActive]} onPress={() => setMode('join')}>
              <Text style={[s.tabText, mode === 'join' && s.tabTextActive]}>New Member</Text>
            </TouchableOpacity>
          </View>

          {mode === 'signin' ? (
            <View style={s.section}>
              {members.length === 0 ? (
                <View style={s.emptyMembers}>
                  <Text style={s.emptyText}>No members yet.</Text>
                  <Text style={s.emptySub}>Switch to New Member to create an account.</Text>
                </View>
              ) : (
                <>
                  <Text style={s.label}>Select your name</Text>
                  {members.map((m) => (
                    <TouchableOpacity
                      key={m.id}
                      style={[s.memberRow, selectedMember === m.name && s.memberRowSelected]}
                      onPress={() => setSelectedMember(m.name)}
                    >
                      <View style={s.memberAvatar}>
                        <Text style={s.memberInitial}>{m.name[0].toUpperCase()}</Text>
                      </View>
                      <Text style={s.memberName}>{m.name}</Text>
                      {selectedMember === m.name && <Text style={s.checkmark}>✓</Text>}
                    </TouchableOpacity>
                  ))}
                </>
              )}

              <Text style={[s.label, { marginTop: 20 }]}>Password</Text>
              <TextInput
                style={s.input}
                placeholder="Your password"
                placeholderTextColor={t.textMuted}
                secureTextEntry
                value={signinPassword}
                onChangeText={setSigninPassword}
                autoCapitalize="none"
              />
              <TouchableOpacity onPress={handleForgotPassword} style={s.forgotRow}>
                <Text style={s.forgotText}>Forgot password?</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.primaryButton, (submitting || !selectedMember) && s.buttonDisabled]}
                onPress={handleSignIn}
                disabled={submitting || !selectedMember}
              >
                {submitting
                  ? <ActivityIndicator color={t.primaryBtnText} />
                  : <Text style={s.primaryButtonText}>Sign In</Text>}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.section}>
              <View style={s.avatarRow}>
                {profilePicUri ? (
                  <Image source={{ uri: profilePicUri }} style={s.avatar} />
                ) : (
                  <View style={s.avatarPlaceholder}>
                    <Text style={s.avatarInitials}>{initials || '?'}</Text>
                  </View>
                )}
                <View style={s.avatarButtons}>
                  <TouchableOpacity style={s.smallButton} onPress={() => pickPhoto(true)}>
                    <Text style={s.smallButtonText}>Camera</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.smallButton} onPress={() => pickPhoto(false)}>
                    <Text style={s.smallButtonText}>Gallery</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={s.label}>Full name</Text>
              <TextInput
                style={s.input}
                placeholder="Your name"
                placeholderTextColor={t.textMuted}
                value={fullName}
                onChangeText={setFullName}
                autoCorrect={false}
              />

              <Text style={s.label}>Password</Text>
              <TextInput
                style={s.input}
                placeholder="Choose a password"
                placeholderTextColor={t.textMuted}
                secureTextEntry
                value={joinPassword}
                onChangeText={setJoinPassword}
                autoCapitalize="none"
              />

              <TouchableOpacity
                style={[s.primaryButton, submitting && s.buttonDisabled]}
                onPress={handleJoin}
                disabled={submitting}
              >
                {submitting
                  ? <ActivityIndicator color={t.primaryBtnText} />
                  : <Text style={s.primaryButtonText}>Join Family Vault</Text>}
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(t) {
  return StyleSheet.create({
    container:            { flex: 1, backgroundColor: t.bg },
    center:               { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
    loadingText:          { color: t.textMuted, fontSize: 13, marginTop: 8 },
    errorTitle:           { color: t.text, fontSize: 18, fontWeight: '600' },
    errorSub:             { color: t.textMuted, fontSize: 13 },
    backButton:           { borderWidth: 1, borderColor: t.backBtnBorder, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 28, marginTop: 8 },
    backButtonText:       { color: t.text, fontSize: 14 },
    scroll:               { padding: 24, paddingBottom: 60 },
    header:               { marginBottom: 28 },
    title:                { color: t.text, fontSize: 26, fontWeight: '700' },
    vaultUrl:             { color: t.textDim, fontSize: 12, marginTop: 4 },
    tabs: {
      flexDirection: 'row', borderWidth: 1, borderColor: t.border,
      borderRadius: 10, marginBottom: 28, overflow: 'hidden',
    },
    tab:                  { flex: 1, paddingVertical: 12, alignItems: 'center', backgroundColor: t.bg },
    tabActive:            { backgroundColor: t.tabActiveBg },
    tabText:              { color: t.tabInactiveText, fontSize: 14, fontWeight: '500' },
    tabTextActive:        { color: t.tabActiveText, fontWeight: '700' },
    section:              { gap: 10 },
    label:                { color: t.label, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 },
    input: {
      backgroundColor: t.input, color: t.text,
      borderWidth: 1, borderColor: t.border, borderRadius: 8,
      padding: 14, fontSize: 15, marginBottom: 6,
    },
    memberRow: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      padding: 14, borderRadius: 8, borderWidth: 1, borderColor: t.memberRowBorder,
      backgroundColor: t.memberRowBg, marginBottom: 6,
    },
    memberRowSelected:    { borderColor: t.memberSelectedBorder, backgroundColor: t.memberSelectedBg },
    memberAvatar: {
      width: 36, height: 36, borderRadius: 18,
      backgroundColor: t.memberAvatarBg, alignItems: 'center', justifyContent: 'center',
    },
    memberInitial:        { color: t.text, fontSize: 15, fontWeight: '600' },
    memberName:           { color: t.text, fontSize: 15, flex: 1 },
    checkmark:            { color: t.text, fontSize: 16, fontWeight: '600' },
    emptyMembers:         { padding: 24, alignItems: 'center', gap: 6 },
    emptyText:            { color: t.textMuted, fontSize: 15 },
    emptySub:             { color: t.textDim, fontSize: 12, textAlign: 'center' },
    avatarRow:            { alignItems: 'center', gap: 14, marginBottom: 8 },
    avatar:               { width: 88, height: 88, borderRadius: 44, backgroundColor: t.input },
    avatarPlaceholder: {
      width: 88, height: 88, borderRadius: 44,
      backgroundColor: t.avatarPlaceholderBg, borderWidth: 1, borderColor: t.avatarPlaceholderBorder,
      alignItems: 'center', justifyContent: 'center',
    },
    avatarInitials:       { color: t.text, fontSize: 28, fontWeight: '300' },
    avatarButtons:        { flexDirection: 'row', gap: 10 },
    smallButton:          { borderWidth: 1, borderColor: t.smallBtnBorder, borderRadius: 7, paddingVertical: 8, paddingHorizontal: 18 },
    smallButtonText:      { color: t.text, fontSize: 13 },
    forgotRow:            { alignSelf: 'flex-end', marginTop: -2, marginBottom: 4 },
    forgotText:           { color: t.forgotText, fontSize: 12 },
    primaryButton: {
      backgroundColor: t.primaryBtn, borderRadius: 8,
      paddingVertical: 15, alignItems: 'center', marginTop: 10,
    },
    buttonDisabled:       { opacity: 0.3 },
    primaryButtonText:    { color: t.primaryBtnText, fontWeight: '700', fontSize: 15 },
  });
}
