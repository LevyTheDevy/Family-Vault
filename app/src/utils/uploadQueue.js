// Background upload queue — the "post instantly, upload behind the scenes"
// flow. Screens enqueue and return immediately; the feed renders queue items
// as pending slides with live progress. Failures stay visible with
// Retry/Discard, and the queue is persisted so an app kill mid-upload is
// offered a retry on next launch instead of silently losing the post.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  uploadPhotos, uploadEncryptedVideo, uploadStory,
  getVaultUrl, getEncryptImgBinFn,
} from './api';
import { encryptLocalVideo, cleanupTempFiles } from './videoProcessing';

const STORE_KEY = 'fv_pending_uploads';

let items = []; // { id, kind, payload, vaultUrl, createdAt, status, stage, progress, error }
const listSubs = new Set();
const doneSubs = new Set();
const failSubs = new Set();

const snapshot = () => items.map((i) => ({ ...i, payload: { ...i.payload } }));
function emit() { for (const cb of listSubs) { try { cb(snapshot()); } catch {} } }
function emitDone(item, result) { for (const cb of doneSubs) { try { cb(item, result); } catch {} } }
function emitFail(item) { for (const cb of failSubs) { try { cb(item); } catch {} } }

export function subscribeQueue(cb) { listSubs.add(cb); cb(snapshot()); return () => listSubs.delete(cb); }
export function onUploadComplete(cb) { doneSubs.add(cb); return () => doneSubs.delete(cb); }
export function onUploadFailed(cb) { failSubs.add(cb); return () => failSubs.delete(cb); }

// Only identity + local file paths are persisted — progress/status are runtime state
async function persist() {
  try {
    const minimal = items.map(({ id, kind, payload, vaultUrl, createdAt }) => ({ id, kind, payload, vaultUrl, createdAt }));
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(minimal));
  } catch {}
}

function update(id, patch) {
  const it = items.find((i) => i.id === id);
  if (!it) return;
  // XHR fires onprogress very frequently and every emit re-renders the feed
  // list — skip progress-only changes under 1%
  const progressOnly = patch.status === undefined && (patch.stage === undefined || patch.stage === it.stage);
  if (progressOnly && patch.progress !== undefined && Math.abs(patch.progress - (it.progress || 0)) < 0.01) return;
  Object.assign(it, patch);
  emit();
}

function remove(id) {
  items = items.filter((i) => i.id !== id);
  persist();
  emit();
}

// One upload at a time: parallel jobs just fight over the same home uplink
// and all finish later. FIFO chain; failures don't break the chain.
let _chain = Promise.resolve();
function schedule(id) {
  _chain = _chain.then(() => process(id)).catch(() => {});
}

function enqueue(kind, payload) {
  const item = {
    id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind,
    payload,
    // Snapshot the target vault: if the user switches vaults mid-upload the
    // item fails loudly instead of posting into the wrong vault
    vaultUrl: getVaultUrl(),
    createdAt: new Date().toISOString(),
    status: 'uploading', stage: 'Preparing', progress: 0, error: null,
  };
  items.unshift(item);
  persist();
  emit();
  schedule(item.id);
  return item.id;
}

export const enqueuePhotos = ({ uris, caption = '', collectionId = null, tags = [] }) =>
  enqueue('photos', { uris, caption, collectionId, tags, previewUri: uris[0] });

export const enqueueVideo = ({ videoUri, durationMs = null, caption = '', collectionId = null }) =>
  enqueue('video', { videoUri, durationMs, caption, collectionId, previewUri: null });

export const enqueueStory = ({ imageUri = null, videoUri = null, durationMs = null, durationHours = 24, caption = '', audienceJson = 'all' }) =>
  enqueue('story', { imageUri, videoUri, durationMs, durationHours, caption, audienceJson, previewUri: imageUri });

async function process(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  const onProgress = (pct, stage) => update(id, { progress: pct, ...(stage ? { stage } : {}) });

  try {
    if (getVaultUrl() !== item.vaultUrl)
      throw new Error('You switched vaults. Switch back and tap Retry.');

    let result = null;
    if (item.kind === 'photos') {
      result = await uploadPhotos(item.payload.uris, item.payload.caption, item.payload.collectionId, onProgress, item.payload.tags || []);
    } else if (item.kind === 'video') {
      result = await processVideo(item, onProgress, false);
    } else if (item.kind === 'story') {
      if (item.payload.videoUri) {
        result = await processVideo(item, onProgress, true);
      } else {
        onProgress(0.05, 'Encrypting');
        result = await uploadStory(item.payload.imageUri, item.payload.durationHours, item.payload.caption, null,
          (p, stage) => onProgress(0.1 + p * 0.9, stage), item.payload.audienceJson || 'all');
      }
    }
    const finished = items.find((i) => i.id === id);
    remove(id);
    if (finished) emitDone(finished, result);
  } catch (e) {
    update(id, { status: 'failed', error: e?.message || 'Upload failed', progress: 0, stage: 'Failed' });
    const failed = items.find((i) => i.id === id);
    if (failed) emitFail(failed);
  }
}

async function processVideo(item, onProgress, isStory) {
  const { videoUri, durationMs, caption, collectionId, durationHours, audienceJson } = item.payload;
  const encBinFn = getEncryptImgBinFn();
  if (!encBinFn) throw new Error('Vault is locked. Log in and tap Retry.');

  onProgress(0.02, 'Preparing');
  let thumbPath = null;
  try {
    const { getFrameAt } = require('react-native-video-trim');
    const frame = await getFrameAt(videoUri, { time: 0, format: 'jpeg', quality: 80 });
    thumbPath = frame.outputPath;
    const it = items.find((i) => i.id === item.id);
    if (it) { it.payload.previewUri = thumbPath; emit(); }
  } catch {}

  onProgress(0.08, 'Encrypting');
  let encVideoUri = null, encThumbUri = null;
  try {
    encVideoUri = await encryptLocalVideo(videoUri, encBinFn);
    if (thumbPath) encThumbUri = await encryptLocalVideo(thumbPath, encBinFn);
    onProgress(0.25, 'Uploading');
    const durationSecs = durationMs ? Math.round(durationMs / 1000) : null;
    const mapUp = (p, stage) => onProgress(0.25 + p * 0.75, stage);
    const result = isStory
      ? await uploadStory(null, durationHours, caption, [{ encVideoUri, encThumbUri, durationSecs }], mapUp, audienceJson || 'all')
      : await uploadEncryptedVideo(encVideoUri, encThumbUri, caption, durationSecs, collectionId, mapUp);
    try {
      const { deleteFile } = require('react-native-video-trim');
      deleteFile(videoUri).catch(() => {});
    } catch {}
    return result;
  } finally {
    cleanupTempFiles([encVideoUri, encThumbUri]).catch(() => {});
  }
}

export function retryUpload(id) {
  const item = items.find((i) => i.id === id);
  if (!item || item.status === 'uploading') return;
  // Retry targets the currently connected vault — the user is looking at its feed
  update(id, { status: 'uploading', error: null, progress: 0, stage: 'Preparing', vaultUrl: getVaultUrl() });
  persist();
  schedule(id);
}

export function discardUpload(id) {
  remove(id);
}

// Re-attempt uploads that were interrupted by an app kill. Called once per
// launch after the vault is unlocked (encryption fns must exist first).
let resumed = false;
export async function resumePendingUploads() {
  if (resumed) return;
  resumed = true;
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const saved = raw ? JSON.parse(raw) : [];
    const fresh = saved.filter((s) => !items.some((i) => i.id === s.id));
    if (!fresh.length) return;
    for (const s of fresh) {
      items.push({ ...s, status: 'uploading', stage: 'Preparing', progress: 0, error: null });
    }
    emit();
    for (const s of fresh) schedule(s.id);
  } catch {}
}
