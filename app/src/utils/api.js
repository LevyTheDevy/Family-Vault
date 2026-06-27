let _url = null, _token = null, _name = null, _pic = null;
let _encryptFn = null, _decryptFn = null;

// Set by VaultContext after key derivation — bound closures with the vault key baked in
export const setVaultCrypto = (encFn, decFn) => { _encryptFn = encFn; _decryptFn = decFn; };
export const clearVaultCrypto = () => { _encryptFn = null; _decryptFn = null; };
export const getStoredAuthHeader = () => _token ? { Authorization: `Bearer ${_token}` } : {};

async function encryptMsg(text) {
  if (!text || !_encryptFn) return text;
  try { return 'enc:' + await _encryptFn(text); } catch { return text; }
}

async function decryptMsg(text) {
  if (!text || !text.startsWith('enc:')) return text;
  if (!_decryptFn) return '[Encrypted]';
  try { return await _decryptFn(text.slice(4)); } catch { return '[Encrypted]'; }
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
  imageUrls: (p.imageUrls || []).map(withToken),
  imageUrl: withToken(p.imageUrl),
  videoUrl: withToken(p.videoUrl),
  thumbnailUrl: withToken(p.thumbnailUrl),
});

const addTokenToStory = (s) => ({ ...s, imageUrl: withToken(s.imageUrl) });

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

async function req(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error('Cannot reach vault. Check Wi-Fi and that the server is running.');
  }
  let json = {};
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error(json.error || `Server error (${res.status})`);
  return json;
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

// Upload one or more photos as a single post
export async function uploadPhotos(imageUris, caption = '', collectionId = null) {
  const uris = Array.isArray(imageUris) ? imageUris : [imageUris];
  const fd = new FormData();
  uris.forEach((uri, i) => {
    fd.append('photos', { uri, type: 'image/jpeg', name: `photo${i}.jpg` });
  });
  const encCaption = await encryptMsg(caption);
  if (encCaption) fd.append('caption', encCaption);
  const post = await req(`${_url}/posts`, { method: 'POST', headers: h(), body: fd });
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
  if (onProgress) onProgress(0.5); // indeterminate for small uploads
  const post = await req(`${_url}/posts`, { method: 'POST', headers: h(), body: fd });
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
    body: JSON.stringify({ videoFilename, thumbnailFilename, caption: encCaption, durationSecs }),
  });
  if (collectionId) await addToCollection(collectionId, post.id).catch(() => {});
  return decryptPost(addTokenToPost(post));
}

export async function sendChatMedia(conversationId, uri, mimeType) {
  const fd = new FormData();
  const ext = uri.split('.').pop()?.toLowerCase() || 'jpg';
  fd.append('media', { uri, type: mimeType || `image/${ext}`, name: `media.${ext}` });
  return req(`${_url}/conversations/${conversationId}/media`, { method: 'POST', headers: h(), body: fd })
    .then(addTokenToMessage);
}

// Backward-compat alias
export const uploadPhoto = (uri, caption, colId) => uploadPhotos([uri], caption, colId);

// Stories
export const fetchStories = async () => {
  const stories = await req(`${_url}/stories`, { headers: h() });
  return Promise.all(stories.map(async (s) => ({ ...addTokenToStory(s), caption: await decryptMsg(s.caption) })));
};

export const deleteStory = (id) =>
  req(`${_url}/stories/${id}`, { method: 'DELETE', headers: h() });

export async function uploadStory(imageUri, durationHours, caption = '') {
  const fd = new FormData();
  fd.append('photo', { uri: imageUri, type: 'image/jpeg', name: 'story.jpg' });
  fd.append('durationHours', String(durationHours));
  const encCaption = await encryptMsg(caption);
  if (encCaption) fd.append('caption', encCaption);
  const story = await req(`${_url}/stories`, { method: 'POST', headers: h(), body: fd });
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
export const updateProfile = ({ newName, currentPassword, newPassword }) =>
  req(`${_url}/members/me`, {
    method: 'PATCH',
    headers: jh(),
    body: JSON.stringify({ newName, currentPassword, newPassword }),
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

export const fetchConversations = () =>
  req(`${_url}/conversations`, { headers: h() });

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

export const fetchMessages = async (conversationId) => {
  const msgs = await req(`${_url}/conversations/${conversationId}/messages`, { headers: h() });
  const withTokens = msgs.map(addTokenToMessage);
  return Promise.all(withTokens.map(async (m) => ({ ...m, text: await decryptMsg(m.text) })));
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

export const markConversationRead = (conversationId) =>
  req(`${_url}/conversations/${conversationId}/read`, { method: 'POST', headers: h() });

export const deleteChatMessage = (conversationId, messageId) =>
  req(`${_url}/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE', headers: h() });

export const searchGifs = (q) =>
  req(`${_url}/gif/search?q=${encodeURIComponent(q)}`, { headers: h() });

export const likeDaily = (id) =>
  req(`${_url}/stories/${id}/like`, { method: 'POST', headers: h() });
