import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView,
  Image, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
  ScrollView, FlatList,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { setVault } from '../utils/api';
import { saveAuth } from '../utils/storage';

const BASE_URL = (url) => url.replace(/\/$/, '');

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

export default function AuthScreen({ route, navigation }) {
  const { vaultUrl, inviteCode: prefilledInvite } = route.params;
  const base = BASE_URL(vaultUrl);

  // If an invite code was passed in (from vault code), start on join tab
  const [mode, setMode] = useState(prefilledInvite ? 'join' : 'signin');
  const [members, setMembers] = useState([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [vaultError, setVaultError] = useState(null);

  // Sign in state
  const [selectedMember, setSelectedMember] = useState(null);
  const [signinPassword, setSigninPassword] = useState('');

  // Join state
  const [inviteCode, setInviteCode] = useState(prefilledInvite || '');
  const [fullName, setFullName] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [profilePicUri, setProfilePicUri] = useState(null);

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiFetch(`${base}/members`)
      .then((data) => { setMembers(data); setLoadingMembers(false); })
      .catch((e) => { setVaultError(`Cannot reach vault\n${vaultUrl}\n\n${e.message}`); setLoadingMembers(false); });
  }, []);

  const onSuccess = async (token, name, picUri) => {
    setVault(base, token, name, picUri);
    await saveAuth({ vaultUrl: base, token, name, profilePicUri: picUri });
    navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
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
      await onSuccess(data.token, data.name, null);
    } catch (e) {
      Alert.alert('Sign in failed', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoin = async () => {
    if (!inviteCode.trim()) return Alert.alert('Invite code required', 'Enter the invite code from your admin.');
    if (!fullName.trim()) return Alert.alert('Name required', 'Enter your full name.');
    if (!joinPassword) return Alert.alert('Password required', 'Choose a password for your account.');
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

  if (loadingMembers) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.loadingText}>Connecting to vault...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (vaultError) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Cannot reach vault</Text>
          <Text style={styles.errorSub}>{vaultUrl}</Text>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
            <Text style={styles.backButtonText}>Scan again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

          <View style={styles.header}>
            <Text style={styles.title}>FamilyVault</Text>
            <Text style={styles.vaultUrl}>{vaultUrl}</Text>
          </View>

          <View style={styles.tabs}>
            <TouchableOpacity
              style={[styles.tab, mode === 'signin' && styles.tabActive]}
              onPress={() => setMode('signin')}
            >
              <Text style={[styles.tabText, mode === 'signin' && styles.tabTextActive]}>Sign In</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, mode === 'join' && styles.tabActive]}
              onPress={() => setMode('join')}
            >
              <Text style={[styles.tabText, mode === 'join' && styles.tabTextActive]}>New Member</Text>
            </TouchableOpacity>
          </View>

          {mode === 'signin' ? (
            <View style={styles.section}>
              {members.length === 0 ? (
                <View style={styles.emptyMembers}>
                  <Text style={styles.emptyText}>No members yet.</Text>
                  <Text style={styles.emptySub}>Switch to New Member to create an account.</Text>
                </View>
              ) : (
                <>
                  <Text style={styles.label}>Select your name</Text>
                  {members.map((m) => (
                    <TouchableOpacity
                      key={m.id}
                      style={[styles.memberRow, selectedMember === m.name && styles.memberRowSelected]}
                      onPress={() => setSelectedMember(m.name)}
                    >
                      <View style={styles.memberAvatar}>
                        <Text style={styles.memberInitial}>{m.name[0].toUpperCase()}</Text>
                      </View>
                      <Text style={styles.memberName}>{m.name}</Text>
                      {selectedMember === m.name && <Text style={styles.checkmark}>-</Text>}
                    </TouchableOpacity>
                  ))}
                </>
              )}

              <Text style={[styles.label, { marginTop: 20 }]}>Password</Text>
              <TextInput
                style={styles.input}
                placeholder="Your password"
                placeholderTextColor="#333"
                secureTextEntry
                value={signinPassword}
                onChangeText={setSigninPassword}
                autoCapitalize="none"
              />
              <TouchableOpacity
                style={[styles.primaryButton, (submitting || !selectedMember) && styles.buttonDisabled]}
                onPress={handleSignIn}
                disabled={submitting || !selectedMember}
              >
                {submitting ? <ActivityIndicator color="#000" /> : <Text style={styles.primaryButtonText}>Sign In</Text>}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.section}>
              <View style={styles.avatarRow}>
                {profilePicUri ? (
                  <Image source={{ uri: profilePicUri }} style={styles.avatar} />
                ) : (
                  <View style={styles.avatarPlaceholder}>
                    <Text style={styles.avatarInitials}>{initials || '?'}</Text>
                  </View>
                )}
                <View style={styles.avatarButtons}>
                  <TouchableOpacity style={styles.smallButton} onPress={() => pickPhoto(true)}>
                    <Text style={styles.smallButtonText}>Camera</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.smallButton} onPress={() => pickPhoto(false)}>
                    <Text style={styles.smallButtonText}>Gallery</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={styles.label}>Invite code</Text>
              <TextInput
                style={[styles.input, prefilledInvite && { color: '#555', borderColor: '#111' }]}
                placeholder="e.g. A3F7B2"
                placeholderTextColor="#333"
                value={inviteCode}
                onChangeText={prefilledInvite ? undefined : setInviteCode}
                editable={!prefilledInvite}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              {prefilledInvite && (
                <Text style={{ color: '#333', fontSize: 11, marginTop: -4 }}>From your vault code</Text>
              )}

              <Text style={styles.label}>Full name</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Levi Eichelberg"
                placeholderTextColor="#333"
                value={fullName}
                onChangeText={setFullName}
                autoCorrect={false}
              />

              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                placeholder="Choose a password"
                placeholderTextColor="#333"
                secureTextEntry
                value={joinPassword}
                onChangeText={setJoinPassword}
                autoCapitalize="none"
              />

              <TouchableOpacity
                style={[styles.primaryButton, submitting && styles.buttonDisabled]}
                onPress={handleJoin}
                disabled={submitting}
              >
                {submitting ? <ActivityIndicator color="#000" /> : <Text style={styles.primaryButtonText}>Join Family Vault</Text>}
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  loadingText: { color: '#444', fontSize: 13, marginTop: 8 },
  errorTitle: { color: '#fff', fontSize: 18, fontWeight: '600' },
  errorSub: { color: '#444', fontSize: 13 },
  backButton: { borderWidth: 1, borderColor: '#333', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 28, marginTop: 8 },
  backButtonText: { color: '#fff', fontSize: 14 },
  scroll: { padding: 24, paddingBottom: 60 },
  header: { marginBottom: 28 },
  title: { color: '#fff', fontSize: 26, fontWeight: '700' },
  vaultUrl: { color: '#333', fontSize: 12, marginTop: 4 },
  tabs: {
    flexDirection: 'row', borderWidth: 1, borderColor: '#222',
    borderRadius: 10, marginBottom: 28, overflow: 'hidden',
  },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', backgroundColor: '#000' },
  tabActive: { backgroundColor: '#fff' },
  tabText: { color: '#444', fontSize: 14, fontWeight: '500' },
  tabTextActive: { color: '#000', fontWeight: '700' },
  section: { gap: 10 },
  label: { color: '#555', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 },
  input: {
    backgroundColor: '#111', color: '#fff',
    borderWidth: 1, borderColor: '#1e1e1e', borderRadius: 8,
    padding: 14, fontSize: 15, marginBottom: 6,
  },
  memberRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: 8, borderWidth: 1, borderColor: '#1a1a1a',
    backgroundColor: '#0a0a0a', marginBottom: 6,
  },
  memberRowSelected: { borderColor: '#fff', backgroundColor: '#111' },
  memberAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center',
  },
  memberInitial: { color: '#fff', fontSize: 15, fontWeight: '600' },
  memberName: { color: '#fff', fontSize: 15, flex: 1 },
  checkmark: { color: '#fff', fontSize: 18, fontWeight: '300' },
  emptyMembers: { padding: 24, alignItems: 'center', gap: 6 },
  emptyText: { color: '#444', fontSize: 15 },
  emptySub: { color: '#2a2a2a', fontSize: 12, textAlign: 'center' },
  avatarRow: { alignItems: 'center', gap: 14, marginBottom: 8 },
  avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: '#111' },
  avatarPlaceholder: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: '#111', borderWidth: 1, borderColor: '#222',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarInitials: { color: '#fff', fontSize: 28, fontWeight: '300' },
  avatarButtons: { flexDirection: 'row', gap: 10 },
  smallButton: { borderWidth: 1, borderColor: '#222', borderRadius: 7, paddingVertical: 8, paddingHorizontal: 18 },
  smallButtonText: { color: '#fff', fontSize: 13 },
  primaryButton: {
    backgroundColor: '#fff', borderRadius: 8,
    paddingVertical: 15, alignItems: 'center', marginTop: 10,
  },
  buttonDisabled: { opacity: 0.3 },
  primaryButtonText: { color: '#000', fontWeight: '700', fontSize: 15 },
});
