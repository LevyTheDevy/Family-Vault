import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { setVault } from '../utils/api';
import { loadAuth } from '../utils/storage';

const VaultContext = createContext({});
export const useVault = () => useContext(VaultContext);

// AsyncStorage: vault metadata list (no tokens)
const VAULTS_KEY = 'fv_vaults';
// AsyncStorage: active index
const ACTIVE_KEY = 'fv_active_vault';
// SecureStore key per vault slot
const tokenKey = (i) => `fv_tok_${i}`;

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

function purgeMediaCache() {
  FileSystem.deleteAsync(FileSystem.cacheDirectory + 'fv/', { idempotent: true }).catch(() => {});
}

export function VaultProvider({ children }) {
  const [vaults, setVaults] = useState([]);   // [{ vaultUrl, name, vaultName, accessKey }]
  const [activeIndex, setActiveIndex] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initVaults().then(() => setReady(true));
  }, []);

  async function initVaults() {
    let list = await readList();
    let activeIdx = 0;

    if (!list || list.length === 0) {
      // One-time migration from old single-vault SecureStore format
      const auth = await loadAuth();
      if (auth) {
        let vaultName = 'Family Vault';
        try {
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 5000);
          const r = await fetch(`${auth.vaultUrl}/health`, { signal: controller.signal });
          clearTimeout(tid);
          vaultName = (await r.json()).vaultName || 'Family Vault';
        } catch {}

        list = [{ vaultUrl: auth.vaultUrl, name: auth.name, vaultName }];
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

  async function removeVault(index) {
    if (vaults.length <= 1) return;
    const newList = vaults.filter((_, i) => i !== index);
    // Shift tokens down to fill the gap
    for (let i = index; i < vaults.length - 1; i++) {
      const t = await readToken(i + 1);
      if (t) await writeToken(i, t);
      else await eraseToken(i);
    }
    await eraseToken(vaults.length - 1);

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
      switchVault,
      initFirstVault,
      addVault,
      removeVault,
    }}>
      {children}
    </VaultContext.Provider>
  );
}
