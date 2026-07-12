import { b64ToBytes } from './crypto';

let _url = null, _token = null, _name = null, _pic = null;
let _encryptFn = null, _decryptFn = null;
// _decryptImgFn: legacy encb: base64-format files
// _encryptImgBinFn / _decryptImgBinFn: new binary-format files (no hex/b64 loop on download)
let _decryptImgFn = null;
let _encryptImgBinFn = null, _decryptImgBinFn = null;

// Set by VaultContext after key derivation — bound closures with the vault key baked in
export const setVaultCrypto = (encFn, decFn, decImgFn, encImgBinFn, decImgBinFn) => {
  _encryptFn = encFn; _decryptFn = decFn;
  _decryptImgFn = decImgFn;
  _encryptImgBinFn = encImgBinFn; _decryptImgBinFn = decImgBinFn;
};
export const clearVaultCrypto = () => {
  _encryptFn = null; _decryptFn = null;
  _decryptImgFn = null;
  _encryptImgBinFn = null; _decryptImgBinFn = null;
  _decCache.clear();
};
export const getStoredAuthHeader = () => _token ? { Authorization: `Bearer ${_token}` } : {};
export const getDecryptFn = () => _decryptFn;
export const getDecryptImgFn = () => _decryptImgFn;       // legacy encb: path
export const getDecryptImgBinFn = () => _decryptImgBinFn; // new binary path
export const getEncryptImgBinFn = () => _encryptImgBinFn; // encrypt binary files (images + video)

let _feedDirty = false;
export const markFeedDirty = () => { _feedDirty = true; };
export const consumeFeedDirty = () => { const d = _feedDirty; _feedDirty = false; return d; };

// GIF search availability, reported by the server (needs a TENOR_KEY there).
// Defaults to enabled so old servers without the flag keep their buttons.
let _gifEnabled = true;
export const setGifEnabled = (v) => { _gifEnabled = v !== false; };
export const isGifEnabled = () => _gifEnabled;

async function encryptBytes(jpegBytes) {
  const LegacyFS = require('expo-file-system/legacy');
  const { File } = require('expo-file-system');
  const combined = await _encryptImgBinFn(jpegBytes);
  const uri = LegacyFS.cacheDirectory + 'enc_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.enc';
  await new File(uri).write(combined);
  return uri;
}

// Read a local file's raw bytes. fetch() on a file:// URI returns bytes
// natively (same trick videoProcessing uses) — no base64 string through the
// JS bridge and no charCodeAt decode loop, which were most of the CPU cost
// of preparing an upload. Falls back to the legacy base64 path if the URI
// scheme isn't fetchable.
async function readLocalBytes(uri) {
  try {
    const localUri = uri.startsWith('file://') || uri.startsWith('content://') ? uri : `file://${uri}`;
    const res = await fetch(localUri);
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    const LegacyFS = require('expo-file-system/legacy');
    const b64 = await LegacyFS.readAsStringAsync(uri, { encoding: LegacyFS.EncodingType.Base64 });
    return b64ToBytes(b64);
  }
}

// Encrypt a single URI as-is (used by message/story image paths)
export async function encryptImageUri(uri) {
  if (!_encryptImgBinFn || !uri) return { uri, encrypted: false, originalUri: uri };
  try {
    const encUri = await encryptBytes(await readLocalBytes(uri));
    return { uri: encUri, encrypted: true, originalUri: uri };
  } catch (e) {
    console.error('[FV] encryptImageUri: FAILED', e?.message || e);
    return { uri, encrypted: false, originalUri: uri };
  }
}

// Produce three encrypted variants of an image: full-res, feed (1080px), thumb (200×200 crop)
async function prepareImageVariants(uri) {
  if (!_encryptImgBinFn || !uri) return { fullUri: uri, feedUri: null, thumbUri: null, encrypted: false };
  try {
    const { manipulateAsync, SaveFormat } = require('expo-image-manipulator');
    const { Image } = require('react-native');

    // Get original dimensions without re-encoding
    const { w: origW, h: origH } = await new Promise((res, rej) =>
      Image.getSize(uri, (w, h) => res({ w, h }), rej));

    // Full — encrypt original bytes unchanged
    const fullUri = await encryptBytes(await readLocalBytes(uri));

    // Feed — resize down to 1080px wide (skip if already smaller)
    const feedActions = origW > 1080 ? [{ resize: { width: 1080 } }] : [];
    const feedResult = await manipulateAsync(uri, feedActions, { compress: 0.85, format: SaveFormat.JPEG });
    const feedUri = await encryptBytes(await readLocalBytes(feedResult.uri));

    // Thumb — center-crop to square then resize to 200×200
    const side = Math.min(origW, origH);
    const thumbResult = await manipulateAsync(uri, [
      { crop: { originX: Math.round((origW - side) / 2), originY: Math.round((origH - side) / 2), width: side, height: side } },
      { resize: { width: 200, height: 200 } },
    ], { compress: 0.8, format: SaveFormat.JPEG });
    const thumbUri = await encryptBytes(await readLocalBytes(thumbResult.uri));

    return { fullUri, feedUri, thumbUri, encrypted: true };
  } catch (e) {
    console.error('[FV] prepareImageVariants: FAILED', e?.message || e);
    // On an encrypted vault, never fall back to uploading plaintext — fail the
    // post instead; the queue shows Retry. (Unencrypted return only happens
    // when the vault has no crypto at all, via the guard at the top.)
    if (_encryptImgBinFn) throw new Error('Could not prepare the photo. Try again.');
    return { fullUri: uri, feedUri: null, thumbUri: null, encrypted: false };
  }
}

async function encryptMsg(text) {
  if (!text || !_encryptFn) return text;
  try { return 'enc:' + await _encryptFn(text); } catch { return text; }
}

// Ciphertext → plaintext cache. Chat polls re-fetch the same messages every few
// seconds; caching by ciphertext makes repeat decrypts free and is safe because
// the same ciphertext always yields the same plaintext under the same key
// (cleared in clearVaultCrypto when the key goes away).
const _decCache = new Map();
const DEC_CACHE_MAX = 3000;

async function decryptMsg(text) {
  if (!text || !text.startsWith('enc:')) return text;
  if (!_decryptFn) return '[Encrypted]';
  const hit = _decCache.get(text);
  if (hit !== undefined) return hit;
  try {
    const plain = await _decryptFn(text.slice(4));
    if (_decCache.size >= DEC_CACHE_MAX) _decCache.clear();
    _decCache.set(text, plain);
    return plain;
  } catch { return '[Encrypted]'; }
}
const _avatarV = {};

// Rebase a server-returned URL to use the client's connected base (_url).
// Fixes Cloudflare Tunnel stripping https: the server sees http internally but
// the client must request over https.
const _rebaseCache = new Map();
const rebase = (url) => {
  if (!url || !_url) return url;
  if (url.startsWith('/')) return `${_url}${url}`;
  const cached = _rebaseCache.get(url);
  if (cached) return cached;
  try {
    const parsed = new URL(url);
    const base = new URL(_url);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    const result = parsed.toString();
    _rebaseCache.set(url, result);
    return result;
  } catch { return url; }
};

// Append JWT as query param so React Native Image (no custom headers) can access protected media
const withToken = (url) => {
  if (!url || !_token) return url;
  const u = rebase(url);
  return u.includes('?') ? `${u}&token=${_token}` : `${u}?token=${_token}`;
};

const addTokenToPost = (p) => ({
  ...p,
  imageUrls:     (p.imageUrls     || []).map(withToken),
  feedImageUrls: (p.feedImageUrls || []).map(withToken),
  thumbImageUrls:(p.thumbImageUrls|| []).map(withToken),
  imageUrl:      withToken(p.imageUrl),
  feedImageUrl:  withToken(p.feedImageUrl),
  thumbImageUrl: withToken(p.thumbImageUrl),
  videoUrl:      withToken(p.videoUrl),
  thumbnailUrl:  withToken(p.thumbnailUrl),
  videoClips:    (p.videoClips || []).map((c) => ({
    ...c,
    url:      withToken(c.url),
    thumbUrl: withToken(c.thumbUrl),
  })),
});

const addTokenToStory = (s) => ({
  ...s,
  imageUrl: withToken(s.imageUrl),
  clips: (s.clips || []).map((c) => ({
    ...c,
    url:      withToken(c.url),
    thumbUrl: withToken(c.thumbUrl),
  })),
});

const addTokenToMessage = (m) => ({
  ...m,
  imageUrl: withToken(m.imageUrl),
  videoUrl: withToken(m.videoUrl),
});

export const setVault = (url, token, name, pic = null) => {
  _url = url.replace(/\/$/, '');
  _token = token;
  _name = name;
  _pic = pic;
  _rebaseCache.clear();
};
export const getVaultUrl = () => _url;
export const getMemberName = () => _name;
export const getProfilePicUri = () => _pic;
export const setProfilePicUri = (uri) => { _pic = uri; };
export const setMemberName = (name) => { _name = name; };
export const setToken = (token) => { _token = token; };
export const getToken = () => _token;

const h = () => ({ Authorization: `Bearer ${_token}` });
const jh = () => ({ ...h(), 'Content-Type': 'application/json' });

// RN fetch has no default timeout — a dropped tunnel connection hangs forever.
// Uploads (FormData bodies) get 5 min; everything else 15s. Callers passing
// their own signal manage their own lifetime.
const API_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 300_000;

async function req(url, opts = {}) {
  let timedOut = false, timer;
  if (!opts.signal) {
    const controller = new AbortController();
    const ms = opts.timeoutMs ?? (opts.body instanceof FormData ? UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
    opts = { ...opts, signal: controller.signal };
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (timedOut) throw new Error('Request timed out. Check your connection and that the server is running.');
      throw e;
    }
    throw new Error('Cannot reach vault. Check Wi-Fi and that the server is running.');
  } finally {
    clearTimeout(timer);
  }
  let json = {};
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    // Expired/invalid session — let the app route to re-auth instead of
    // leaving every screen quietly broken. Login/join endpoints are excluded
    // (a wrong password 401 is not a session expiry).
    if (res.status === 401 && !/\/(login|join)$/.test(url.split('?')[0])) emitAuthExpired();
    throw new Error(json.error || `Server error (${res.status})`);
  }
  return json;
}

// ── Session-expiry signal ────────────────────────────────────────────────────
const _authExpiredSubs = new Set();
let _lastAuthEmit = 0;
export const onAuthExpired = (cb) => { _authExpiredSubs.add(cb); return () => _authExpiredSubs.delete(cb); };
function emitAuthExpired() {
  const now = Date.now();
  if (now - _lastAuthEmit < 15_000) return; // polls can 401 in bursts — emit once
  _lastAuthEmit = now;
  for (const cb of _authExpiredSubs) { try { cb(); } catch {} }
}

// Exchange the current token for a fresh full-length one (sliding session).
// 404 on old servers / offline is fine — the existing token keeps working.
export const refreshToken = () =>
  req(`${_url}/refresh`, { method: 'POST', headers: h() });

// Multipart upload with real progress. RN's fetch can't report upload
// progress, but its XMLHttpRequest can — used whenever a caller wants a
// percentage. onProgress receives 0..1.
function uploadWithProgress(url, fd, onProgress, timeoutMs = UPLOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader('Authorization', `Bearer ${_token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) { try { onProgress?.(e.loaded / e.total); } catch {} }
    };
    xhr.onload = () => {
      let json = {};
      try { json = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(json);
      else reject(new Error(json.error || `Server error (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Cannot reach vault. Check Wi-Fi and that the server is running.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out. Check your connection.'));
    xhr.send(fd);
  });
}

function syncAvatarVersions(members) {
  for (const m of members) {
    if (m.name && m.avatarVersion) _avatarV[m.name] = m.avatarVersion;
  }
  return members;
}

// Auth
export const fetchMembers = (url) =>
  req(`${url.replace(/\/$/, '')}/members`).then(syncAvatarVersions);

export const joinVault = (url, name, password, inviteCode) =>
  req(`${url.replace(/\/$/, '')}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password, inviteCode }),
  });

export const loginVault = (url, name, password) =>
  req(`${url.replace(/\/$/, '')}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });

// Posts
async function decryptPost(p) {
  return {
    ...p,
    caption: await decryptMsg(p.caption),
    comments: p.comments
      ? await Promise.all(p.comments.map(async (c) => ({ ...c, text: await decryptMsg(c.text) })))
      : p.comments,
  };
}

export const fetchPosts = async ({ limit = 20, offset = 0 } = {}) => {
  const { posts, total } = await req(`${_url}/posts?limit=${limit}&offset=${offset}`, { headers: h() });
  const decrypted = await Promise.all(posts.map((p) => decryptPost(addTokenToPost(p))));
  return { posts: decrypted, total, hasMore: offset + decrypted.length < total };
};

export const deletePost = (id) =>
  req(`${_url}/posts/${id}`, { method: 'DELETE', headers: h() });

export const likePost = (id) =>
  req(`${_url}/posts/${id}/like`, { method: 'POST', headers: h() });

export const recordPostView = (id) =>
  req(`${_url}/posts/${id}/view`, { method: 'POST', headers: h() });

// Single post (notification taps) — 404 on servers without the route
export const fetchPost = async (id) => {
  const p = await req(`${_url}/posts/${id}`, { headers: h() });
  return decryptPost(addTokenToPost(p));
};

export const savePost = (id) =>
  req(`${_url}/posts/${id}/save`, { method: 'POST', headers: h() });

export const addComment = async (id, text, gifUrl = null, imageX = null, imageY = null, imageIndex = 0) => {
  const encText = await encryptMsg(text);
  const comment = await req(`${_url}/posts/${id}/comments`, {
    method: 'POST', headers: jh(),
    body: JSON.stringify({ text: encText, gifUrl, imageX, imageY, imageIndex }),
  });
  return { ...comment, text: await decryptMsg(comment.text) };
};

export const deleteComment = (postId, commentId) =>
  req(`${_url}/posts/${postId}/comments/${commentId}`, { method: 'DELETE', headers: h() });

// Upload one or more photos as a single post — generates full/feed/thumb variants per image.
// onProgress(pct 0..1, stage) — encrypt phase maps to 0..0.4, upload to 0.4..1.
export async function uploadPhotos(imageUris, caption = '', collectionId = null, onProgress = null) {
  const uris = Array.isArray(imageUris) ? imageUris : [imageUris];
  const report = (pct, stage) => { try { onProgress?.(pct, stage); } catch {} };
  report(0.02, 'Encrypting');
  let prepared = 0;
  const variants = await Promise.all(uris.map(async (u) => {
    const v = await prepareImageVariants(u);
    prepared += 1;
    report((prepared / uris.length) * 0.4, 'Encrypting');
    return v;
  }));
  const fd = new FormData();
  variants.forEach(({ fullUri, feedUri, thumbUri, encrypted }, i) => {
    const ext = uris[i].split('?')[0].split('.').pop()?.toLowerCase() || 'jpg';
    console.log(`[FV] uploadPhotos: photo${i} encrypted=${encrypted}`);
    if (encrypted) {
      fd.append('photos',      { uri: fullUri,  type: 'application/octet-stream', name: `photo${i}.enc` });
      fd.append('feedPhotos',  { uri: feedUri,  type: 'application/octet-stream', name: `photo${i}_feed.enc` });
      fd.append('thumbPhotos', { uri: thumbUri, type: 'application/octet-stream', name: `photo${i}_thumb.enc` });
    } else {
      fd.append('photos', { uri: fullUri, type: 'image/jpeg', name: `photo${i}.${ext}` });
    }
  });
  const encCaption = await encryptMsg(caption);
  if (encCaption) fd.append('caption', encCaption);
  // Server files the post into this collection at creation (falls back to All
  // Members) so new-post notifications only reach people who can see it
  if (collectionId) fd.append('collectionId', String(collectionId));
  console.log('[FV] uploadPhotos: POSTing to', `${_url}/posts`);
  report(0.4, 'Uploading');
  const post = onProgress
    ? await uploadWithProgress(`${_url}/posts`, fd, (p) => report(0.4 + p * 0.6, 'Uploading'))
    : await req(`${_url}/posts`, { method: 'POST', headers: h(), body: fd });
  console.log('[FV] uploadPhotos: success, post id', post?.id);
  markFeedDirty();
  if (collectionId) await addToCollection(collectionId, post.id).catch(() => {});
  return decryptPost(addTokenToPost(post));
}

export async function uploadVideo(videoUri, thumbnailUri = null, caption = '', durationSecs = null, collectionId = null, onProgress = null) {
  // For small videos, use the regular direct upload
  let fileSize = 0;
  try {
    const FileSystem = require('expo-file-system/legacy');
    const info = await FileSystem.getInfoAsync(videoUri, { size: true });
    fileSize = info.size || 0;
  } catch {}

  const CHUNK_THRESHOLD = 90 * 1024 * 1024; // 90MB — below Cloudflare's 100MB limit

  if (fileSize > CHUNK_THRESHOLD) {
    return uploadVideoChunked(videoUri, thumbnailUri, caption, durationSecs, collectionId, onProgress, fileSize);
  }

  const fd = new FormData();
  const ext = videoUri.split('.').pop()?.toLowerCase() || 'mp4';
  fd.append('video', { uri: videoUri, type: `video/${ext === 'mov' ? 'quicktime' : ext}`, name: `video.${ext}` });
  if (thumbnailUri) {
    fd.append('thumbnail', { uri: thumbnailUri, type: 'image/jpeg', name: 'thumbnail.jpg' });
  }
  const encCaption = await encryptMsg(caption);
  if (encCaption) fd.append('caption', encCaption);
  if (durationSecs != null) fd.append('durationSecs', String(durationSecs));
  if (collectionId) fd.append('collectionId', String(collectionId));
  if (onProgress) onProgress(0.5); // indeterminate for small uploads
  const post = await req(`${_url}/posts`, { method: 'POST', headers: h(), body: fd });
  markFeedDirty();
  if (collectionId) await addToCollection(collectionId, post.id).catch(() => {});
  if (onProgress) onProgress(1);
  return decryptPost(addTokenToPost(post));
}

// Chunked upload for large videos (>90MB) — bypasses Cloudflare's 100MB request body limit
async function uploadVideoChunked(videoUri, thumbnailUri, caption, durationSecs, collectionId, onProgress, fileSize) {
  const FileSystem = require('expo-file-system/legacy');
  const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB chunks
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const ext = videoUri.split('.').pop()?.toLowerCase() || 'mp4';
  const mimeType = `video/${ext === 'mov' ? 'quicktime' : ext}`;

  // 1. Init upload session
  const { uploadId } = await req(`${_url}/upload/init`, { method: 'POST', headers: jh(), body: '{}' });

  // 2. Upload chunks
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const length = Math.min(CHUNK_SIZE, fileSize - start);

    // Read chunk as base64 then write to a temp file for FormData
    const chunkB64 = await FileSystem.readAsStringAsync(videoUri, {
      encoding: FileSystem.EncodingType.Base64,
      position: start,
      length,
    });
    const chunkUri = FileSystem.cacheDirectory + `chunk_${uploadId}_${i}`;
    await FileSystem.writeAsStringAsync(chunkUri, chunkB64, { encoding: FileSystem.EncodingType.Base64 });

    const fd = new FormData();
    fd.append('chunk', { uri: chunkUri, type: 'application/octet-stream', name: `chunk${i}` });
    fd.append('uploadId', uploadId);
    fd.append('chunkIndex', String(i));
    fd.append('totalChunks', String(totalChunks));
    await req(`${_url}/upload/chunk`, { method: 'POST', headers: h(), body: fd });

    // Clean up temp chunk file
    FileSystem.deleteAsync(chunkUri, { idempotent: true }).catch(() => {});
    if (onProgress) onProgress((i + 1) / (totalChunks + 2)); // +2 for thumbnail + finalize
  }

  // 3. Upload thumbnail separately (small, always direct)
  let thumbnailFilename = null;
  if (thumbnailUri) {
    const thumbFd = new FormData();
    thumbFd.append('thumbnail', { uri: thumbnailUri, type: 'image/jpeg', name: 'thumbnail.jpg' });
    thumbFd.append('uploadId', `thumb-${uploadId}`);
    thumbFd.append('chunkIndex', '0');
    thumbFd.append('totalChunks', '1');
    await req(`${_url}/upload/chunk`, { method: 'POST', headers: h(), body: thumbFd });
    const thumbResult = await req(`${_url}/upload/finalize`, {
      method: 'POST', headers: jh(),
      body: JSON.stringify({ uploadId: `thumb-${uploadId}`, totalChunks: 1, mimeType: 'image/jpeg' }),
    });
    thumbnailFilename = thumbResult.filename;
    if (onProgress) onProgress((totalChunks + 1) / (totalChunks + 2));
  }

  // 4. Finalize video
  const { filename: videoFilename } = await req(`${_url}/upload/finalize`, {
    method: 'POST', headers: jh(),
    body: JSON.stringify({ uploadId, totalChunks, mimeType }),
  });
  if (onProgress) onProgress(1);

  // 5. Create post from uploaded filenames
  const encCaption = await encryptMsg(caption);
  const post = await req(`${_url}/posts/from-upload`, {
    method: 'POST', headers: jh(),
    body: JSON.stringify({ videoFilename, thumbnailFilename, caption: encCaption, durationSecs, collectionId }),
  });
  markFeedDirty();
  if (collectionId) await addToCollection(collectionId, post.id).catch(() => {});
  return decryptPost(addTokenToPost(post));
}

export async function sendChatMedia(conversationId, uri, mimeType) {
  const fd = new FormData();
  const isVideo = mimeType?.startsWith('video') || /\.(mp4|mov|avi|mkv)$/i.test(uri);
  if (!isVideo) {
    const { uri: encUri, encrypted } = await encryptImageUri(uri);
    fd.append('media', encrypted
      ? { uri: encUri, type: 'image/jpeg', name: 'media.enc' }
      : { uri: encUri, type: mimeType || 'image/jpeg', name: 'media.jpg' });
  } else {
    const ext = uri.split('.').pop()?.toLowerCase() || 'mp4';
    fd.append('media', { uri, type: mimeType || `video/${ext}`, name: `media.${ext}` });
  }
  return req(`${_url}/conversations/${conversationId}/media`, { method: 'POST', headers: h(), body: fd })
    .then(addTokenToMessage);
}

// Backward-compat alias
export const uploadPhoto = (uri, caption, colId) => uploadPhotos([uri], caption, colId);

// Single encrypted video post (trimmed on-device via react-native-video-trim)
export async function uploadEncryptedVideo(encVideoUri, encThumbUri, caption = '', durationSecs = null, collectionId = null, onProgress = null) {
  const fd = new FormData();
  fd.append('video', { uri: encVideoUri, type: 'video/mp4', name: 'video.enc' });
  if (encThumbUri) fd.append('thumbnail', { uri: encThumbUri, type: 'image/jpeg', name: 'thumb.enc' });
  if (durationSecs != null) fd.append('durationSecs', String(Math.round(durationSecs)));
  const encCaption = await encryptMsg(caption);
  if (encCaption) fd.append('caption', encCaption);
  if (collectionId) fd.append('collectionId', String(collectionId));
  const post = onProgress
    ? await uploadWithProgress(`${_url}/posts`, fd, (p) => { try { onProgress(p, 'Uploading'); } catch {} })
    : await req(`${_url}/posts`, { method: 'POST', headers: h(), body: fd });
  markFeedDirty();
  if (collectionId) await addToCollection(collectionId, post.id).catch(() => {});
  return decryptPost(addTokenToPost(post));
}

// Stories
export const fetchStories = async () => {
  const stories = await req(`${_url}/stories`, { headers: h() });
  return Promise.all(stories.map(async (s) => ({ ...addTokenToStory(s), caption: await decryptMsg(s.caption) })));
};

export const deleteStory = (id) =>
  req(`${_url}/stories/${id}`, { method: 'DELETE', headers: h() });

export async function uploadStory(imageUri, durationHours, caption = '', videoClips = null, onProgress = null) {
  const fd = new FormData();
  if (videoClips && videoClips.length > 0) {
    // Video story with encrypted clips
    for (let i = 0; i < videoClips.length; i++) {
      const { encVideoUri, encThumbUri, durationSecs } = videoClips[i];
      fd.append('videoClips', { uri: encVideoUri, type: 'application/octet-stream', name: `clip${i}.enc` });
      if (encThumbUri) fd.append('thumbClips', { uri: encThumbUri, type: 'application/octet-stream', name: `thumb${i}.enc` });
      if (durationSecs != null) fd.append(`clipDuration${i}`, String(Math.round(durationSecs)));
    }
  } else {
    // Image story
    const { uri: encUri, encrypted } = await encryptImageUri(imageUri);
    fd.append('photo', encrypted
      ? { uri: encUri, type: 'application/octet-stream', name: 'story.enc' }
      : { uri: encUri, type: 'image/jpeg', name: 'story.jpg' });
  }
  fd.append('durationHours', String(durationHours));
  const encCaption = await encryptMsg(caption);
  if (encCaption) fd.append('caption', encCaption);
  const story = onProgress
    ? await uploadWithProgress(`${_url}/stories`, fd, (p) => { try { onProgress(p, 'Uploading'); } catch {} })
    : await req(`${_url}/stories`, { method: 'POST', headers: h(), body: fd });
  return { ...addTokenToStory(story), caption: await decryptMsg(story.caption) };
}

// Collections
export const fetchCollections = () =>
  req(`${_url}/collections`, { headers: h() })
  .then((cols) => cols.map((c) => ({ ...c, thumbnailUrl: withToken(c.thumbnailUrl) })));

export const createCollection = (name) =>
  req(`${_url}/collections`, { method: 'POST', headers: jh(), body: JSON.stringify({ name }) });

export const deleteCollection = (id) =>
  req(`${_url}/collections/${id}`, { method: 'DELETE', headers: h() });

export const fetchCollectionPosts = async (id) => {
  const posts = await req(`${_url}/collections/${id}/posts`, { headers: h() });
  return Promise.all(posts.map((p) => decryptPost(addTokenToPost(p))));
};

export const addToCollection = (colId, postId) =>
  req(`${_url}/collections/${colId}/posts`, {
    method: 'POST',
    headers: jh(),
    body: JSON.stringify({ postId }),
  });

export const removeFromCollection = (colId, postId) =>
  req(`${_url}/collections/${colId}/posts/${postId}`, { method: 'DELETE', headers: h() });

export const addCollectionMember = (colId, memberName) =>
  req(`${_url}/collections/${colId}/members`, { method: 'POST', headers: jh(), body: JSON.stringify({ memberName }) });

export const removeCollectionMember = (colId, memberName) =>
  req(`${_url}/collections/${colId}/members/${encodeURIComponent(memberName)}`, { method: 'DELETE', headers: h() });

// Stories — views and reactions
export const viewStory = (id) =>
  req(`${_url}/stories/${id}/view`, { method: 'POST', headers: h() });

export const reactToStory = (id, emoji) =>
  req(`${_url}/stories/${id}/reactions`, {
    method: 'POST', headers: jh(), body: JSON.stringify({ emoji }),
  });

export const fetchStoryViewers = (id) =>
  req(`${_url}/stories/${id}/viewers`, { headers: h() });

// Profile
// kdfSalt/wrappedVaultKey: the vault key re-wrapped with the NEW password —
// must accompany every password change or future logins can't unlock E2E data
export const updateProfile = ({ newName, currentPassword, newPassword, kdfSalt, wrappedVaultKey }) =>
  req(`${_url}/members/me`, {
    method: 'PATCH',
    headers: jh(),
    body: JSON.stringify({ newName, currentPassword, newPassword, kdfSalt, wrappedVaultKey }),
  });

// Standalone re-wrap endpoint — fallback when the server predates atomic
// crypto-in-PATCH (response without cryptoUpdated)
export const updateCrypto = (kdfSalt, wrappedVaultKey) =>
  req(`${_url}/update-crypto`, {
    method: 'POST', headers: jh(), body: JSON.stringify({ kdfSalt, wrappedVaultKey }),
  });

export const uploadAvatar = async (uri) => {
  const fd = new FormData();
  fd.append('avatar', { uri, type: 'image/jpeg', name: 'avatar.jpg' });
  const result = await req(`${_url}/members/me/avatar`, { method: 'POST', headers: h(), body: fd });
  // Use server-returned version so ALL clients pick up the same cache-buster
  _avatarV[_name] = result.avatarVersion || Date.now();
  return result;
};

export const renameAvatarCache = (oldName, newName) => {
  _avatarV[newName] = _avatarV[oldName] || Date.now();
  delete _avatarV[oldName];
};

export const deleteAvatar = () => {
  _avatarV[_name] = Date.now(); // bump version so cached old avatar is evicted
  return req(`${_url}/members/me/avatar`, { method: 'DELETE', headers: h() });
};

export const getAvatarUrl = (name) => {
  if (!name || !_url) return null;
  const v = _avatarV[name];
  const base = `${_url}/members/${encodeURIComponent(name)}/avatar`;
  const params = [v ? `v=${v}` : '', _token ? `token=${_token}` : ''].filter(Boolean).join('&');
  return params ? `${base}?${params}` : base;
};

// Messaging
export const fetchFamilyMembers = () =>
  req(`${_url}/members`, { headers: h() }).then(syncAvatarVersions);

export const fetchConversations = async () => {
  const convos = await req(`${_url}/conversations`, { headers: h() });
  return Promise.all(convos.map(async (c) => {
    if (!c.lastMessage?.text) return c;
    return { ...c, lastMessage: { ...c.lastMessage, text: await decryptMsg(c.lastMessage.text) } };
  }));
};

export const createConversation = (name, memberNames = []) =>
  req(`${_url}/conversations`, {
    method: 'POST', headers: jh(), body: JSON.stringify({ name, memberNames }),
  });

export const startDM = (targetMember) =>
  req(`${_url}/conversations/dm`, {
    method: 'POST', headers: jh(), body: JSON.stringify({ targetMember }),
  });

export const deleteConversation = (id) =>
  req(`${_url}/conversations/${id}`, { method: 'DELETE', headers: h() });

export const addConversationMember = (id, memberName) =>
  req(`${_url}/conversations/${id}/members`, { method: 'POST', headers: jh(), body: JSON.stringify({ memberName }) });

export const removeConversationMember = (id, memberName) =>
  req(`${_url}/conversations/${id}/members/${encodeURIComponent(memberName)}`, { method: 'DELETE', headers: h() });

// Tiny change-detection payload for the chat poll (404 on old servers)
export const fetchMessagesDigest = (conversationId) =>
  req(`${_url}/conversations/${conversationId}/digest`, { headers: h() });

export const fetchMessages = async (conversationId) => {
  const msgs = await req(`${_url}/conversations/${conversationId}/messages`, { headers: h() });
  const withTokens = msgs.map(addTokenToMessage);
  return Promise.all(withTokens.map(async (m) => ({
    ...m,
    text: await decryptMsg(m.text),
    replyPreview: m.replyPreview ? { ...m.replyPreview, text: await decryptMsg(m.replyPreview.text) } : null,
  })));
};

export const sendMessage = async (conversationId, text, gifUrl = null, replyToId = null, postRef = null) => {
  const encText = await encryptMsg(text);
  const msg = await req(`${_url}/conversations/${conversationId}/messages`, {
    method: 'POST', headers: jh(), body: JSON.stringify({ text: encText, gifUrl, replyToId, postRef }),
  });
  const withToken = addTokenToMessage(msg);
  return { ...withToken, text: await decryptMsg(withToken.text) };
};

export const reactToMessage = (conversationId, messageId, emoji) =>
  req(`${_url}/conversations/${conversationId}/messages/${messageId}/react`, {
    method: 'POST', headers: jh(), body: JSON.stringify({ emoji }),
  });

// Screens (MessagesScreen) subscribe to zero out a conversation's unread row
// the moment a chat confirms its read — no refetch needed
const _convoReadSubs = new Set();
export const onConversationRead = (cb) => { _convoReadSubs.add(cb); return () => _convoReadSubs.delete(cb); };

export const markConversationRead = (conversationId) =>
  req(`${_url}/conversations/${conversationId}/read`, { method: 'POST', headers: h() })
    .then((r) => {
      for (const cb of _convoReadSubs) { try { cb(conversationId); } catch {} }
      return r;
    });

export const deleteChatMessage = (conversationId, messageId) =>
  req(`${_url}/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE', headers: h() });

export const searchGifs = (q) =>
  req(`${_url}/gif/search?q=${encodeURIComponent(q)}`, { headers: h() });

export const likeDaily = (id) =>
  req(`${_url}/stories/${id}/like`, { method: 'POST', headers: h() });

// Notifications
export const fetchNotifications = () =>
  req(`${_url}/notifications`, { headers: h() })
    .then((items) => items.map((n) => ({ ...n, thumbUrl: withToken(n.thumbUrl) })));

export const markNotificationsSeen = () =>
  req(`${_url}/notifications/seen`, { method: 'POST', headers: h() });

// { unseenNotifications, unreadMessages } — cheap poll for the badges
export const fetchNotifSummary = () =>
  req(`${_url}/notifications/summary`, { headers: h() });

export const registerPushToken = (token) =>
  req(`${_url}/push/register`, { method: 'POST', headers: jh(), body: JSON.stringify({ token }) });
