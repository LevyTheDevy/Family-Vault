import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, Modal, TextInput, ActivityIndicator, Platform, KeyboardAvoidingView,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import Avatar from '../components/Avatar';
import * as ImagePicker from 'expo-image-picker';
// legacy: documentDirectory/copyAsync don't exist on the SDK 54 main entry —
// the bare import made the profile-photo copy silently no-op
import * as FileSystem from 'expo-file-system/legacy';
import {
  getMemberName, getProfilePicUri, getVaultUrl,
  setProfilePicUri, setMemberName, setToken, updateProfile, updateCrypto,
  uploadAvatar, deleteAvatar, getAvatarUrl, renameAvatarCache,
} from '../utils/api';
import { clearAuth, updateStoredProfile } from '../utils/storage';
import { wrapVaultKey } from '../utils/crypto';
import { useVault } from '../context/VaultContext';
import { useTheme } from '../context/ThemeContext';

// Module-level component — must NOT be defined inside SettingsScreen.
// Defining it inside would create a new function reference on every state change,
// causing React to unmount/remount the Modal and dismiss the keyboard after each keystroke.
function Sheet({ visible, onClose, colors, children }) {
  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.sheetBackdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
          <ScrollView
            style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}
            contentContainerStyle={styles.sheetContent}
            keyboardShouldPersistTaps="handled"
            bounces={false}
          >
            <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function SettingsScreen({ navigation }) {
  const { colors, mode } = useTheme();
  const { vaults, activeIndex, removeVault, disconnectAll, getVaultKey, updateActiveAuth } = useVault();
  const [name, setName] = useState(getMemberName() || '');
  const [picUri, setPicUri] = useState(getProfilePicUri());
  const [avatarUrl, setAvatarUrl] = useState(() => getAvatarUrl(getMemberName()));
  const vaultUrl = getVaultUrl() || '';
  const initials = name.split(' ').filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
  const themeLabel = mode === 'dark' ? 'Dark' : mode === 'light' ? 'Light' : 'Custom';


  const [uploading, setUploading] = useState(false);
  const [sheet, setSheet] = useState(null); // 'name' | 'password' | null
  const [nameInput, setNameInput] = useState('');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [sheetError, setSheetError] = useState('');

  const openSheet = (type) => {
    setSheetError('');
    setCurrentPw('');
    if (type === 'name') setNameInput(name);
    if (type === 'password') { setNewPw(''); setConfirmPw(''); }
    setSheet(type);
  };
  const closeSheet = () => { setSheet(null); setSheetError(''); };

  // ── Profile picture ────────────────────────────────────────────────────────
  const handleChangePic = () => {
    if (uploading) return;
    Alert.alert('Profile Photo', undefined, [
      {
        text: 'Camera', onPress: async () => {
          const { status } = await ImagePicker.requestCameraPermissionsAsync();
          if (status !== 'granted') return Alert.alert('Camera permission needed');
          const r = await ImagePicker.launchCameraAsync({ quality: 0.8, allowsEditing: true, aspect: [1, 1], mediaTypes: ['images'] });
          if (!r.canceled) savePic(r.assets[0].uri);
        },
      },
      {
        text: 'Photo Library', onPress: async () => {
          const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (status !== 'granted') return Alert.alert('Photo library permission needed');
          const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, allowsEditing: true, aspect: [1, 1], mediaTypes: ['images'] });
          if (!r.canceled) savePic(r.assets[0].uri);
        },
      },
      ...(picUri ? [{
        text: 'Remove Photo', style: 'destructive', onPress: () => {
          setPicUri(null);
          setProfilePicUri(null);
          updateStoredProfile({ profilePicUri: null });
          deleteAvatar().catch(() => {});
        },
      }] : []),
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const savePic = async (uri) => {
    if (uploading) return;
    setUploading(true);
    let local = uri;
    try {
      const dest = `${FileSystem.documentDirectory}profile.jpg`;
      await FileSystem.copyAsync({ from: uri, to: dest });
      local = dest;
    } catch {}
    setPicUri(local);
    setProfilePicUri(local);
    await updateStoredProfile({ profilePicUri: local });
    try {
      await uploadAvatar(local);
      setAvatarUrl(getAvatarUrl(name));
    } catch (e) {
      Alert.alert('Upload failed', e.message + '\n\nYour photo is saved locally but won\'t show to others until the server is reachable.');
    } finally {
      setUploading(false);
    }
  };

  // ── Save name ──────────────────────────────────────────────────────────────
  const handleSaveName = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return setSheetError('Name cannot be empty');
    if (!currentPw) return setSheetError('Enter your current password to confirm');
    setSaving(true); setSheetError('');
    try {
      const oldName = getMemberName();
      const { token, name: newName } = await updateProfile({ newName: trimmed, currentPassword: currentPw });
      if (oldName !== newName) renameAvatarCache(oldName, newName);
      setMemberName(newName);
      setToken(token);
      setName(newName);
      setAvatarUrl(getAvatarUrl(newName));
      await updateStoredProfile({ name: newName, token });
      // Keep the multi-vault slot in sync — the old slot token carries the
      // old name, which the server would trust on next launch
      await updateActiveAuth({ token, name: newName });
      closeSheet();
    } catch (e) {
      setSheetError(e.message);
    } finally { setSaving(false); }
  };

  // ── Save password ──────────────────────────────────────────────────────────
  const handleSavePassword = async () => {
    if (!currentPw) return setSheetError('Enter your current password');
    if (!newPw) return setSheetError('Enter a new password');
    if (newPw.length < 8) return setSheetError('Password must be at least 8 characters');
    if (newPw !== confirmPw) return setSheetError('New passwords do not match');
    setSaving(true); setSheetError('');
    try {
      // The vault key on the server is wrapped with the password — re-wrap it
      // with the new one or the next fresh login can't unlock E2E content
      let crypto = null;
      const vk = getVaultKey?.();
      if (vk) crypto = await wrapVaultKey(vk, newPw);

      const resp = await updateProfile({
        currentPassword: currentPw, newPassword: newPw,
        ...(crypto || {}),
      });
      setToken(resp.token);
      await updateStoredProfile({ token: resp.token });
      await updateActiveAuth({ token: resp.token });

      if (crypto && !resp.cryptoUpdated) {
        // Server predates atomic re-wrap — apply via the standalone endpoint
        try {
          await updateCrypto(crypto.kdfSalt, crypto.wrappedVaultKey);
        } catch {
          Alert.alert(
            'One more step needed',
            'Your password changed, but re-securing your encryption key failed. Please change your password once more while connected, or future logins may not unlock your content.',
          );
        }
      }
      closeSheet();
      Alert.alert('Password updated', 'Your password has been changed.');
    } catch (e) {
      setSheetError(e.message);
    } finally { setSaving(false); }
  };

  // ── Disconnect ─────────────────────────────────────────────────────────────
  const handleDisconnectOne = (index) => {
    const v = vaults[index];
    Alert.alert(
      `Disconnect from ${v?.vaultName || 'vault'}?`,
      'You will need to scan or enter a code to reconnect.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect', style: 'destructive', onPress: async () => {
            if (vaults.length <= 1) {
              await disconnectAll();
              await clearAuth();
              navigation.reset({ index: 0, routes: [{ name: 'Scan' }] });
            } else {
              await removeVault(index);
            }
          },
        },
      ],
    );
  };

  const handleDisconnectAll = () => {
    Alert.alert('Disconnect from all vaults?', 'This removes all vault connections and returns you to the scan screen.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect all', style: 'destructive', onPress: async () => {
          await disconnectAll();
          await clearAuth();
          navigation.reset({ index: 0, routes: [{ name: 'Scan' }] });
        },
      },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.screenBg }]}>
      <ScrollView keyboardShouldPersistTaps="handled">

        {/* ── Profile header ── */}
        <View style={[styles.profileSection, { borderBottomColor: colors.border }]}>
          <TouchableOpacity style={styles.avatarWrap} onPress={handleChangePic} activeOpacity={uploading ? 1 : 0.8} disabled={uploading} accessibilityRole="button" accessibilityLabel="Change profile photo">
            <Avatar name={name} uri={avatarUrl} size={72} />
            {uploading
              ? <View style={[styles.cameraBadge, { backgroundColor: colors.surface }]}><ActivityIndicator size={10} color={colors.accent} /></View>
              : <View style={[styles.cameraBadge, { backgroundColor: colors.accent }]}><Feather name="camera" size={12} color={colors.accentText} /></View>
            }
          </TouchableOpacity>
          <View style={styles.profileText}>
            <Text style={[styles.profileName, { color: colors.text }]}>{name}</Text>
            <Text style={[styles.profileRole, { color: colors.textSub }]}>Family member</Text>
          </View>
        </View>

        {/* ── Account ── */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: colors.textSub }]}>Account</Text>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TouchableOpacity
              style={[styles.row, { borderBottomColor: colors.border }]}
              onPress={() => openSheet('name')}
              activeOpacity={0.7}
            >
              <View style={[styles.rowIcon, { backgroundColor: colors.surface }]}>
                <Feather name="user" size={15} color={colors.textSub} />
              </View>
              <Text style={[styles.rowLabel, { color: colors.text }]}>Display Name</Text>
              <Text style={[styles.rowValue, { color: colors.textSub }]} numberOfLines={1}>{name}</Text>
              <Feather name="chevron-right" size={15} color={colors.textSub} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.row}
              onPress={() => openSheet('password')}
              activeOpacity={0.7}
            >
              <View style={[styles.rowIcon, { backgroundColor: colors.surface }]}>
                <Feather name="lock" size={15} color={colors.textSub} />
              </View>
              <Text style={[styles.rowLabel, { color: colors.text }]}>Password</Text>
              <Text style={[styles.rowValue, { color: colors.textSub }]}>••••••</Text>
              <Feather name="chevron-right" size={15} color={colors.textSub} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Vaults ── */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: colors.textSub }]}>
            {vaults.length > 1 ? 'Connected Vaults' : 'Vault'}
          </Text>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {vaults.map((v, i) => (
              <View
                key={i}
                style={[styles.row, i < vaults.length - 1 && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }]}
              >
                <View style={[styles.rowIcon, { backgroundColor: colors.surface }]}>
                  <Feather name="server" size={15} color={i === activeIndex ? colors.accent : colors.textSub} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.rowLabel, { color: colors.text }]} numberOfLines={1}>
                    {v.vaultName || 'Family Vault'}
                    {i === activeIndex ? ' ·' : ''}
                  </Text>
                  <Text style={[{ fontSize: 11, color: colors.textSub, marginTop: 1 }]} numberOfLines={1}>
                    {v.vaultUrl?.replace('http://', '')} · {v.name}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => handleDisconnectOne(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`Disconnect from ${v.vaultName || 'vault'}`}>
                  <Feather name="x-circle" size={17} color={colors.textSub} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        </View>

        {/* ── Appearance ── */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: colors.textSub }]}>Appearance</Text>
          <TouchableOpacity
            style={[styles.card, styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => navigation.navigate('Theme')}
            activeOpacity={0.7}
          >
            <View style={[styles.rowIcon, { backgroundColor: colors.surface }]}>
              <Feather name="sliders" size={15} color={colors.textSub} />
            </View>
            <Text style={[styles.rowLabel, { color: colors.text }]}>Theme & Colors</Text>
            <Text style={[styles.rowValue, { color: colors.textSub }]}>{themeLabel}</Text>
            <Feather name="chevron-right" size={15} color={colors.textSub} />
          </TouchableOpacity>
        </View>

        {/* ── Disconnect ── */}
        <View style={styles.section}>
          <TouchableOpacity style={styles.disconnectBtn} onPress={handleDisconnectAll} activeOpacity={0.7}>
            <Feather name="log-out" size={16} color="#e53935" />
            <Text style={styles.disconnectText}>Disconnect from all vaults</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>

      {/* ── Change Name ── */}
      <Sheet visible={sheet === 'name'} onClose={closeSheet} colors={colors}>
        <Text style={[styles.sheetTitle, { color: colors.text }]}>Change Name</Text>

        <Text style={[styles.inputLabel, { color: colors.textSub }]}>New display name</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
          placeholder="Your name"
          placeholderTextColor={colors.textSub}
          value={nameInput}
          onChangeText={setNameInput}
          autoFocus
          autoCorrect={false}
          returnKeyType="next"
        />

        <Text style={[styles.inputLabel, { color: colors.textSub }]}>Current password</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
          placeholder="Required to confirm"
          placeholderTextColor={colors.textSub}
          value={currentPw}
          onChangeText={setCurrentPw}
          secureTextEntry
          autoCapitalize="none"
          returnKeyType="done"
          onSubmitEditing={handleSaveName}
        />

        {!!sheetError && <Text style={styles.errorText}>{sheetError}</Text>}

        <View style={styles.sheetButtons}>
          <TouchableOpacity style={[styles.sheetBtnOutline, { borderColor: colors.border }]} onPress={closeSheet}>
            <Text style={[styles.sheetBtnOutlineText, { color: colors.text }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sheetBtnPrimary, { backgroundColor: colors.accent }, saving && { opacity: 0.5 }]}
            onPress={handleSaveName}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator color={colors.accentText} size="small" />
              : <Text style={[styles.sheetBtnPrimaryText, { color: colors.accentText }]}>Save</Text>}
          </TouchableOpacity>
        </View>
      </Sheet>

      {/* ── Change Password ── */}
      <Sheet visible={sheet === 'password'} onClose={closeSheet} colors={colors}>
        <Text style={[styles.sheetTitle, { color: colors.text }]}>Change Password</Text>

        <Text style={[styles.inputLabel, { color: colors.textSub }]}>Current password</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
          placeholder="Current password"
          placeholderTextColor={colors.textSub}
          value={currentPw}
          onChangeText={setCurrentPw}
          secureTextEntry
          autoCapitalize="none"
          autoFocus
          returnKeyType="next"
        />

        <Text style={[styles.inputLabel, { color: colors.textSub }]}>New password</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
          placeholder="New password"
          placeholderTextColor={colors.textSub}
          value={newPw}
          onChangeText={setNewPw}
          secureTextEntry
          autoCapitalize="none"
          returnKeyType="next"
        />

        <Text style={[styles.inputLabel, { color: colors.textSub }]}>Confirm new password</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
          placeholder="Repeat new password"
          placeholderTextColor={colors.textSub}
          value={confirmPw}
          onChangeText={setConfirmPw}
          secureTextEntry
          autoCapitalize="none"
          returnKeyType="done"
          onSubmitEditing={handleSavePassword}
        />

        {!!sheetError && <Text style={styles.errorText}>{sheetError}</Text>}

        <View style={styles.sheetButtons}>
          <TouchableOpacity style={[styles.sheetBtnOutline, { borderColor: colors.border }]} onPress={closeSheet}>
            <Text style={[styles.sheetBtnOutlineText, { color: colors.text }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sheetBtnPrimary, { backgroundColor: colors.accent }, saving && { opacity: 0.5 }]}
            onPress={handleSavePassword}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator color={colors.accentText} size="small" />
              : <Text style={[styles.sheetBtnPrimaryText, { color: colors.accentText }]}>Update</Text>}
          </TouchableOpacity>
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Profile
  profileSection: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    padding: 24, paddingBottom: 24, borderBottomWidth: 1,
  },
  avatarWrap: { position: 'relative' },
  avatar: { width: 72, height: 72, borderRadius: 36 },
  avatarPlaceholder: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  initials: { fontSize: 24, fontWeight: '300' },
  cameraBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  profileText: { gap: 3 },
  profileName: { fontSize: 19, fontWeight: '700' },
  profileRole: { fontSize: 13 },

  // Sections
  section: { paddingHorizontal: 16, paddingTop: 24 },
  sectionLabel: {
    fontSize: 11, fontWeight: '600', textTransform: 'uppercase',
    letterSpacing: 1, marginBottom: 10, paddingLeft: 2,
  },

  // Card rows
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 13, paddingHorizontal: 14, borderBottomWidth: 1,
  },
  rowIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  rowLabel: { flex: 1, fontSize: 15 },
  rowValue: { fontSize: 14, maxWidth: '40%', textAlign: 'right' },

  // Connected badge
  connectedBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  connectedDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#43a047' },
  connectedText: { fontSize: 14, fontWeight: '500' },

  // Disconnect
  disconnectBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: '#e53935', borderRadius: 12,
    paddingVertical: 14, marginBottom: 36,
  },
  disconnectText: { color: '#e53935', fontSize: 15, fontWeight: '600' },

  // Sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1,
    maxHeight: '90%',
  },
  sheetContent: { padding: 20, paddingBottom: 40, gap: 12 },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 6 },
  sheetTitle: { fontSize: 17, fontWeight: '700', marginBottom: 4 },
  inputLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: -4 },
  input: { borderWidth: 1, borderRadius: 10, padding: 13, fontSize: 15 },
  errorText: { color: '#e53935', fontSize: 13 },
  sheetButtons: { flexDirection: 'row', gap: 10, marginTop: 4 },
  sheetBtnOutline: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  sheetBtnOutlineText: { fontSize: 15 },
  sheetBtnPrimary: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  sheetBtnPrimaryText: { fontSize: 15, fontWeight: '700' },
});
