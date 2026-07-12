import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { getVaultUrl, getToken, setToken } from '../utils/api';
import { wrapVaultKey } from '../utils/crypto';
import { useVault } from '../context/VaultContext';

export default function ResetPasswordScreen({ navigation }) {
  const { getVaultKey, updateActiveAuth } = useVault();
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (newPw.length < 8) return Alert.alert('Too short', 'Password must be at least 8 characters.');
    if (newPw !== confirmPw) return Alert.alert('No match', "Passwords don't match.");
    setSubmitting(true);
    try {
      // Re-wrap the vault key with the chosen password. Without this, the key
      // stays wrapped with the admin's temp password and the next fresh login
      // can't unlock any E2E content.
      let crypto = null;
      const vk = getVaultKey?.();
      if (vk) crypto = await wrapVaultKey(vk, newPw);

      const res = await fetch(`${getVaultUrl()}/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ newPassword: newPw, ...(crypto || {}) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to update password');
      // Update the stored token (server issues a fresh one)
      if (json.token) {
        setToken(json.token);
        await updateActiveAuth({ token: json.token });
      }
      if (crypto && !json.cryptoUpdated) {
        // Old server: apply the re-wrap via the standalone endpoint
        await fetch(`${getVaultUrl()}/update-crypto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify(crypto),
        }).catch(() => {});
      }
      navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

          <View style={styles.iconWrap}>
            <Feather name="lock" size={36} color="#fff" />
          </View>

          <Text style={styles.title}>Set New Password</Text>
          <Text style={styles.sub}>
            You signed in with a temporary password.{'\n'}
            Please choose a new password to continue.
          </Text>

          <Text style={styles.label}>New password</Text>
          <TextInput
            style={styles.input}
            placeholder="At least 8 characters"
            placeholderTextColor="#6e6e73"
            secureTextEntry
            value={newPw}
            onChangeText={setNewPw}
            autoCapitalize="none"
            autoFocus
          />

          <Text style={styles.label}>Confirm password</Text>
          <TextInput
            style={styles.input}
            placeholder="Repeat password"
            placeholderTextColor="#6e6e73"
            secureTextEntry
            value={confirmPw}
            onChangeText={setConfirmPw}
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={handleSubmit}
          />

          <TouchableOpacity
            style={[styles.button, submitting && styles.buttonDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting
              ? <ActivityIndicator color="#000" />
              : <Text style={styles.buttonText}>Save New Password</Text>
            }
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  scroll: { padding: 28, paddingTop: 60, gap: 12 },
  iconWrap: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: '#111', borderWidth: 1, borderColor: '#222',
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'center', marginBottom: 8,
  },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', textAlign: 'center' },
  sub: { color: '#8e8e93', fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 8 },
  label: { color: '#8e8e93', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: -4 },
  input: {
    backgroundColor: '#111', color: '#fff',
    borderWidth: 1, borderColor: '#1e1e1e', borderRadius: 8,
    padding: 14, fontSize: 15,
  },
  button: {
    backgroundColor: '#fff', borderRadius: 8,
    paddingVertical: 15, alignItems: 'center', marginTop: 8,
  },
  buttonDisabled: { opacity: 0.3 },
  buttonText: { color: '#000', fontWeight: '700', fontSize: 15 },
});
