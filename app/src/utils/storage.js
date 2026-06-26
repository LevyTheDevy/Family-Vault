import * as SecureStore from 'expo-secure-store';
import { setVault } from './api';

const KEYS = {
  vaultUrl: 'fv_vault_url',
  token: 'fv_token',
  name: 'fv_name',
  profilePic: 'fv_profile_pic',
};

export async function saveAuth({ vaultUrl, token, name, profilePicUri }) {
  await SecureStore.setItemAsync(KEYS.vaultUrl, vaultUrl);
  await SecureStore.setItemAsync(KEYS.token, token);
  await SecureStore.setItemAsync(KEYS.name, name);
  if (profilePicUri) await SecureStore.setItemAsync(KEYS.profilePic, profilePicUri);
}

export async function loadAuth() {
  const vaultUrl = await SecureStore.getItemAsync(KEYS.vaultUrl);
  const token = await SecureStore.getItemAsync(KEYS.token);
  const name = await SecureStore.getItemAsync(KEYS.name);
  const profilePicUri = await SecureStore.getItemAsync(KEYS.profilePic);
  if (!vaultUrl || !token) return null;
  return { vaultUrl, token, name, profilePicUri };
}

export async function clearAuth() {
  await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k)));
}

export async function updateStoredProfile({ name, token, profilePicUri }) {
  if (name) await SecureStore.setItemAsync(KEYS.name, name);
  if (token) await SecureStore.setItemAsync(KEYS.token, token);
  if (profilePicUri !== undefined) {
    if (profilePicUri) await SecureStore.setItemAsync(KEYS.profilePic, profilePicUri);
    else await SecureStore.deleteItemAsync(KEYS.profilePic);
  }
}
