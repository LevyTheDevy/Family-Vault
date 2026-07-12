import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
  // Clear old single-vault SecureStore keys
  await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k).catch(() => {})));
  // Clear new multi-vault storage — tokens AND wrapped vault keys
  try {
    const raw = await AsyncStorage.getItem('fv_vaults');
    const count = raw ? JSON.parse(raw).length : 0;
    await AsyncStorage.multiRemove(['fv_vaults', 'fv_active_vault']);
    for (let i = 0; i < count; i++) {
      await SecureStore.deleteItemAsync(`fv_tok_${i}`).catch(() => {});
      await SecureStore.deleteItemAsync(`fv_vk_${i}`).catch(() => {});
    }
  } catch {}
}

export async function updateStoredProfile({ name, token, profilePicUri }) {
  if (name) await SecureStore.setItemAsync(KEYS.name, name);
  if (token) await SecureStore.setItemAsync(KEYS.token, token);
  if (profilePicUri !== undefined) {
    if (profilePicUri) await SecureStore.setItemAsync(KEYS.profilePic, profilePicUri);
    else await SecureStore.deleteItemAsync(KEYS.profilePic);
  }
}
