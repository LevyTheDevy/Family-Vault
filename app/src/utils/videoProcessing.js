import * as LegacyFS from 'expo-file-system/legacy';
import { File as FSFile } from 'expo-file-system';
import { b64ToBytes } from './crypto';

const TMP_DIR = LegacyFS.cacheDirectory + 'fv-vtmp/';

// Encrypt any local file (video or image frame) and return the .enc path in cache
export async function encryptLocalVideo(fileUri, encBinFn) {
  await LegacyFS.makeDirectoryAsync(TMP_DIR, { intermediates: true });
  const localUri = fileUri.startsWith('file://') ? fileUri : `file://${fileUri}`;
  const b64 = await LegacyFS.readAsStringAsync(localUri, { encoding: 'base64' });
  const bytes = b64ToBytes(b64);
  const encrypted = await encBinFn(bytes);
  const outPath = TMP_DIR + 'enc_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.enc';
  await new FSFile(outPath).write(encrypted);
  return outPath;
}

export async function cleanupTempFiles(uris = []) {
  for (const uri of uris) {
    if (!uri) continue;
    try { await LegacyFS.deleteAsync(uri, { idempotent: true }); } catch {}
  }
}
