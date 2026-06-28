import * as LegacyFS from 'expo-file-system/legacy';
import { File as FSFile } from 'expo-file-system';

const TMP_DIR = LegacyFS.cacheDirectory + 'fv-vtmp/';

// Encrypt any local file (video or image frame) and return the .enc path in cache.
// Uses fetch+arrayBuffer instead of readAsStringAsync to avoid the 33% base64 bloat
// that causes OOM on files >30MB.
export async function encryptLocalVideo(fileUri, encBinFn) {
  await LegacyFS.makeDirectoryAsync(TMP_DIR, { intermediates: true });
  const localUri = fileUri.startsWith('file://') ? fileUri : `file://${fileUri}`;
  const response = await fetch(localUri);
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
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
