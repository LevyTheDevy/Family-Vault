import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { setVault, setVaultCrypto, clearVaultCrypto } from '../utils/api';
import { loadAuth } from '../utils/storage';
import { unwrapVaultKey, encryptText, decryptText, decryptImageText, encryptImageBin, decryptImageBin, b64ToBytes } from '../utils/crypto';

const VaultContext = createContext({});
export const useVault = () => useContext(VaultContext);

// AsyncStorage: vault metadata list (no tokens)
const VAULTS_KEY = 'fv_vaults';
// AsyncStorage: active index
const ACTIVE_KEY = 'fv_active_vault';
// SecureStore key per vault slot
const tokenKey = (i) => `fv_tok_${i}`;
const vaultKeyStoreKey = (i) => `fv_vk_${i}`;

async function storeList(list) {
  await AsyncStorage.setItem(VAULTS_KEY, JSON.stringify(list));
}

async function readList() {
  try { return JSON.parse(await AsyncStorage.getItem(VAULTS_KEY) || 'null'); } catch { return null; }
}

async function readActiveIdx() {
  try { return parseInt(await AsyncStorage.getItem(ACTIVE_KEY) || '0', 10); } catch { return 0; }
}

async function writeActiveIdx(i) {
  await AsyncStorage.setItem(ACTIVE_KEY, String(i));
}

async function writeToken(i, token) {
  await SecureStore.setItemAsync(tokenKey(i), token);
}

async function readToken(i) {
  try { return await SecureStore.getItemAsync(tokenKey(i)); } catch { return null; }
}

async function eraseToken(i) {
  try { await SecureStore.deleteItemAsync(tokenKey(i)); } catch {}
}

async function persistVaultKey(i, keyBytes) {
  const b64 = btoa(String.fromCharCode.apply(null, keyBytes));
  await SecureStore.setItemAsync(vaultKeyStoreKey(i), b64);
}

async function restoreVaultKey(i) {
  try {
    const b64 = await SecureStore.getItemAsync(vaultKeyStoreKey(i));
    return b64 ? b64ToBytes(b64) : null;
  } catch { return null; }
}

async function eraseVaultKey(i) {
  try { await SecureStore.deleteItemAsync(vaultKeyStoreKey(i)); } catch {}
}

function purgeMediaCache() {
  FileSystem.deleteAsync(FileSystem.cacheDirectory + 'fv/', { idempotent: true }).catch(() => {});
}

export function VaultProvider({ children }) {
  const [vaults, setVaults] = useState([]);   // [{ vaultUrl, name, vaultName, accessKey }]
  const [activeIndex, setActiveIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const [cryptoReady, setCryptoReady] = useState(false);
  // vault_key is held in memory only — never persisted to disk
  // It's a Uint8Array(32) derived from the user's password on each login
  const vaultKeyRef = useRef(null);

  useEffect(() => {
    initVaults().then(() => setReady(true));
  }, []);

  async function fetchVaultName(vaultUrl) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`${vaultUrl}/health`, { signal: controller.signal });
      clearTimeout(tid);
      return (await r.json()).vaultName || null;
    } catch { return null; }
  }

  async function initVaults() {
    let list = await readList();
    let activeIdx = 0;

    if (!list || list.length === 0) {
      // One-time migration from old single-vault SecureStore format
      const auth = await loadAuth();
      if (auth) {
        const freshName = await fetchVaultName(auth.vaultUrl);
        list = [{ vaultUrl: auth.vaultUrl, name: auth.name, vaultName: freshName || 'Family Vault' }];
        await storeList(list);
        await writeToken(0, auth.token);
        await writeActiveIdx(0);
      }
    } else {
      activeIdx = await readActiveIdx();
      if (activeIdx >= list.length) activeIdx = 0;
    }

    if (list && list.length > 0) {
      const token = await readToken(activeIdx);
      const v = list[activeIdx];
      if (token && v) setVault(v.vaultUrl, token, v.name);
      setVaults(list);
      setActiveIndex(activeIdx);

      // Restore vault key from SecureStore — skips password prompt on relaunch
      const storedKey = await restoreVaultKey(activeIdx);
      if (storedKey) {
        vaultKeyRef.current = storedKey;
        setVaultCrypto(
          (text) => encryptText(text, storedKey),
          (hex) => decryptText(hex, storedKey),
          (b64) => decryptImageText(b64, storedKey),
          (jpegBytes) => encryptImageBin(jpegBytes, storedKey),
          (bytes) => decryptImageBin(bytes, storedKey),
        );
        setCryptoReady(true);
      }

      // Background: refresh vault names from server, update if changed
      Promise.all(list.map(async (v) => {
        const fresh = await fetchVaultName(v.vaultUrl);
        return fresh && fresh !== v.vaultName ? { ...v, vaultName: fresh } : v;
      })).then(async (updated) => {
        const changed = updated.some((v, i) => v.vaultName !== list[i].vaultName);
        if (changed) {
          await storeList(updated);
          setVaults(updated);
        }
      }).catch(() => {});
    }
  }

  async function switchVault(index) {
    const vault = vaults[index];
    if (!vault) return;
    const token = await readToken(index);
    if (!token) return;
    setVault(vault.vaultUrl, token, vault.name);
    setActiveIndex(index);
    await writeActiveIdx(index);
    purgeMediaCache();
    // Refresh name in background
    fetchVaultName(vault.vaultUrl).then(async (fresh) => {
      if (fresh && fresh !== vault.vaultName) {
        const updated = vaults.map((v, i) => i === index ? { ...v, vaultName: fresh } : v);
        await storeList(updated);
        setVaults(updated);
      }
    }).catch(() => {});
  }

  // Called on first login — replaces any existing vault list with a single entry
  async function initFirstVault({ vaultUrl, token, name, vaultName, accessKey = null }) {
    const list = [{ vaultUrl, name, vaultName: vaultName || 'Family Vault', accessKey }];
    await storeList(list);
    await writeToken(0, token);
    await writeActiveIdx(0);
    setVaults(list);
    setActiveIndex(0);
    setVault(vaultUrl, token, name);
    purgeMediaCache();
  }

  // Called when connecting an additional vault
  async function addVault({ vaultUrl, token, name, vaultName, accessKey = null }) {
    const newList = [...vaults, { vaultUrl, name, vaultName: vaultName || 'Family Vault', accessKey }];
    const newIdx = newList.length - 1;
    await writeToken(newIdx, token);
    await storeList(newList);
    await writeActiveIdx(newIdx);
    setVaults(newList);
    setActiveIndex(newIdx);
    setVault(vaultUrl, token, name);
    purgeMediaCache();
  }

  async function disconnectAll() {
    for (let i = 0; i < vaults.length; i++) { await eraseToken(i); await eraseVaultKey(i); }
    await AsyncStorage.multiRemove([VAULTS_KEY, ACTIVE_KEY]);
    setVaults([]);
    setActiveIndex(0);
    vaultKeyRef.current = null;
    clearVaultCrypto();
    purgeMediaCache();
  }

  /** Called after login/join when the server returns kdfSalt + wrappedVaultKey */
  async function deriveAndStoreVaultKey(kdfSalt, wrappedVaultKey, password) {
    if (!kdfSalt || !wrappedVaultKey || !password) return;
    const key = await unwrapVaultKey(kdfSalt, wrappedVaultKey, password);
    vaultKeyRef.current = key;
    persistVaultKey(activeIndex, key).catch(() => {});
    setVaultCrypto(
      (text) => encryptText(text, key),          // enc: text — messages/captions
      (hex) => decryptText(hex, key),            // enc: hex decrypt
      (b64) => decryptImageText(b64, key),       // encb: legacy base64 decrypt
      (jpegBytes) => encryptImageBin(jpegBytes, key), // 0x01 AES-256-GCM via native QC
      (bytes) => decryptImageBin(bytes, key),
    );
    setCryptoReady(true);
  }

  /** Returns the current in-memory vault key (Uint8Array(32) or null) */
  function getVaultKey() {
    return vaultKeyRef.current;
  }

  async function removeVault(index) {
    if (vaults.length <= 1) return;
    const newList = vaults.filter((_, i) => i !== index);
    // Shift tokens and vault keys down to fill the gap
    for (let i = index; i < vaults.length - 1; i++) {
      const t = await readToken(i + 1);
      if (t) await writeToken(i, t); else await eraseToken(i);
      const k = await restoreVaultKey(i + 1);
      if (k) await persistVaultKey(i, k); else await eraseVaultKey(i);
    }
    await eraseToken(vaults.length - 1);
    await eraseVaultKey(vaults.length - 1);

    let newActive = activeIndex;
    if (newActive === index) newActive = 0;
    else if (newActive > index) newActive--;

    await storeList(newList);
    setVaults(newList);
    await writeActiveIdx(newActive);
    setActiveIndex(newActive);

    const v = newList[newActive];
    const token = await readToken(newActive);
    if (v && token) setVault(v.vaultUrl, token, v.name);
    purgeMediaCache();
  }

  return (
    <VaultContext.Provider value={{
      vaults,
      activeIndex,
      activeVault: vaults[activeIndex],
      ready,
      cryptoReady,
      switchVault,
      initFirstVault,
      addVault,
      removeVault,
      disconnectAll,
      deriveAndStoreVaultKey,
      getVaultKey,
    }}>
      {children}
    </VaultContext.Provider>
  );
}
