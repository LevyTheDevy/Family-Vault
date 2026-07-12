// True offline storage for saved posts. The Offline collection used to store
// only tokened server URLs and rely on the decrypted cache — which breaks when
// the token expires, the 500MB prune evicts the file, or the post was never
// fully viewed. Saved posts now get permanent decrypted copies under
// documentDirectory (survives cache cleans, needs no network or token).
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LegacyFS from 'expo-file-system/legacy';
import { getDecryptedLocalPath } from '../components/CachedImage';

const OFFLINE_KEY = 'fv_offline_posts';
export const OFFLINE_DIR = LegacyFS.documentDirectory + 'fv-offline/';

// Copy each image to permanent storage (decrypting when needed, downloading
// directly for legacy unencrypted posts). Returns local paths (null per slot
// that failed — caller falls back to the remote URL for that index).
export async function copyPostMediaOffline(postId, urls) {
  const dir = `${OFFLINE_DIR}${postId}/`;
  await LegacyFS.makeDirectoryAsync(dir, { intermediates: true });
  const locals = [];
  for (let i = 0; i < urls.length; i++) {
    const dest = `${dir}${i}.jpg`;
    try {
      const src = await getDecryptedLocalPath(urls[i]);
      if (src) await LegacyFS.copyAsync({ from: src, to: dest });
      else await LegacyFS.downloadAsync(urls[i], dest);
      locals.push(dest);
    } catch { locals.push(null); }
  }
  return locals;
}

// Attach the finished local copies to the stored offline entry
export async function attachLocalPaths(postId, localPaths) {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const idx = list.findIndex((p) => p.id === postId);
    if (idx < 0) return; // unsaved before the copy finished
    list[idx].localPaths = localPaths;
    await AsyncStorage.setItem(OFFLINE_KEY, JSON.stringify(list));
  } catch {}
}

export async function removeOfflineMedia(postId) {
  await LegacyFS.deleteAsync(`${OFFLINE_DIR}${postId}/`, { idempotent: true }).catch(() => {});
}
