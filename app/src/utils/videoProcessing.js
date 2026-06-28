'use strict';

import { FFmpegKit, ReturnCode } from 'ffmpeg-kit-react-native';
import * as LegacyFS from 'expo-file-system/legacy';
import { File as FSFile } from 'expo-file-system';
import { b64ToBytes } from './crypto';

const TMP_DIR = LegacyFS.cacheDirectory + 'fv-vtmp/';

async function ensureDir() {
  await LegacyFS.makeDirectoryAsync(TMP_DIR, { intermediates: true });
}

function localPath(uri) {
  // FFmpegKit on Android handles file:// URIs directly
  return uri.startsWith('file://') ? uri : `file://${uri}`;
}

// Trim + transcode one clip to 720p H.264, returns local file path
async function transcodeClip(inputUri, startSec, durationSec, outPath) {
  const scale = "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2";
  const cmd = `-y -i "${localPath(inputUri)}" -ss ${startSec.toFixed(3)} -t ${durationSec.toFixed(3)} -vf "${scale}" -c:v libx264 -b:v 2500k -c:a aac -b:a 128k -movflags +faststart "${outPath}"`;
  const session = await FFmpegKit.execute(cmd);
  const rc = await session.getReturnCode();
  if (!ReturnCode.isSuccess(rc)) {
    const logs = await session.getOutput();
    throw new Error(`FFmpeg transcode failed (rc=${ReturnCode.getValue(rc)}): ${(logs || '').slice(-300)}`);
  }
}

// Extract a JPEG thumbnail at `atSec` seconds from the video
async function extractThumbnail(inputPath, atSec, outPath) {
  const cmd = `-y -i "${inputPath}" -ss ${atSec.toFixed(3)} -vframes 1 -q:v 2 "${outPath}"`;
  const session = await FFmpegKit.execute(cmd);
  const rc = await session.getReturnCode();
  if (!ReturnCode.isSuccess(rc)) return null;
  const info = await LegacyFS.getInfoAsync(outPath).catch(() => null);
  return info?.exists ? outPath : null;
}

// Read a local file as Uint8Array (via base64 path — avoids fetch() on file:// URI unreliability)
async function readFileBytes(localFilePath) {
  const b64 = await LegacyFS.readAsStringAsync(localFilePath, { encoding: LegacyFS.EncodingType.Base64 });
  return b64ToBytes(b64);
}

// Encrypt a local file using the provided encryptBinFn, writes .enc to cache dir, returns URI
async function encryptLocalFile(localFilePath, encryptBinFn) {
  const bytes = await readFileBytes(localFilePath);
  const encBytes = await encryptBinFn(bytes);
  const outUri = LegacyFS.cacheDirectory + 'encv_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.enc';
  await new FSFile(outUri).write(encBytes);
  return outUri;
}

// Main export: process a video into N encrypted clips ready to upload.
// Returns [{ encVideoUri, encThumbUri, durationSecs }]
// - videoUri: local file:// path from ImagePicker
// - startSec / endSec: selected range in seconds
// - numClips: how many equal segments to split into (1-5)
// - encryptBinFn: bound closure from VaultContext, takes Uint8Array → Promise<Uint8Array>
// - onProgress: (0-1) progress callback
export async function processVideoClips(videoUri, startSec, endSec, numClips, encryptBinFn, onProgress) {
  await ensureDir();
  const totalDuration = endSec - startSec;
  const clipDuration = totalDuration / numClips;
  const results = [];
  const tmpFiles = [];

  try {
    for (let i = 0; i < numClips; i++) {
      if (onProgress) onProgress(i / numClips * 0.85);

      const clipStart = startSec + i * clipDuration;
      const tag = `${Date.now()}_${i}`;
      const clipPath = TMP_DIR + `clip_${tag}.mp4`;
      const thumbPath = TMP_DIR + `thumb_${tag}.jpg`;
      tmpFiles.push(clipPath, thumbPath);

      // Transcode this clip to 720p H.264
      await transcodeClip(videoUri, clipStart, clipDuration, clipPath);

      // Extract thumbnail from the middle frame
      const thumbAtSec = clipDuration / 2;
      const thumbLocalPath = await extractThumbnail(clipPath, thumbAtSec, thumbPath).catch(() => null);

      // Encrypt video clip
      const encVideoUri = await encryptLocalFile(clipPath, encryptBinFn);

      // Encrypt thumbnail if we got one
      const encThumbUri = thumbLocalPath ? await encryptLocalFile(thumbLocalPath, encryptBinFn).catch(() => null) : null;

      results.push({ encVideoUri, encThumbUri, durationSecs: clipDuration });
    }

    if (onProgress) onProgress(1);
    return results;
  } finally {
    // Clean up intermediate .mp4 and .jpg temp files
    for (const f of tmpFiles) {
      LegacyFS.deleteAsync(f, { idempotent: true }).catch(() => {});
    }
  }
}

// Clean up encrypted temp files after successful upload
export async function cleanupEncryptedClips(clips) {
  for (const { encVideoUri, encThumbUri } of clips) {
    if (encVideoUri) LegacyFS.deleteAsync(encVideoUri, { idempotent: true }).catch(() => {});
    if (encThumbUri) LegacyFS.deleteAsync(encThumbUri, { idempotent: true }).catch(() => {});
  }
}
