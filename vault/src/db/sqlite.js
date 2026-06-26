const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const generateCode = () => crypto.randomBytes(3).toString('hex').toUpperCase();

function hashPassword(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(p, salt, 100_000, 32, 'sha256').toString('hex');
  return `pbkdf2:${salt}:${hash}`;
}

function checkPassword(p, stored) {
  if (!stored || !stored.startsWith('pbkdf2:')) {
    // Legacy SHA-256 + static salt — accept on login, will be re-hashed next time
    return stored === crypto.createHash('sha256').update(p + 'fv-salt').digest('hex');
  }
  const [, salt, hash] = stored.split(':');
  return crypto.pbkdf2Sync(p, salt, 100_000, 32, 'sha256').toString('hex') === hash;
}

function canAccessPost(memberName, postId, data) {
  const post = (data.posts || []).find((p) => p.id === postId);
  if (!post) return true; // deleted post — don't restrict
  if (post.author === memberName) return true;
  const postCols = (data.collections || []).filter((col) => (col.postIds || []).includes(postId));
  if (postCols.length === 0) return true; // not in any private collection
  return postCols.some((col) => (col.memberNames || [col.author]).includes(memberName));
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    const initial = {
      inviteCode: generateCode(),
      members: [],
      posts: [],
      stories: [],
      collections: [],
      conversations: [],
      messages: [],
      nextId: 1,
    };
    save(initial);
    return initial;
  }
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function normalizePost(p) {
  const filenames = p.filenames || (p.filename ? [p.filename] : []);
  return {
    ...p,
    filenames,
    caption: p.caption || '',
    likes: p.likes || [],
    comments: p.comments || [],
    savedBy: p.savedBy || [],
    mediaType: p.mediaType || 'image',
    videoFilename: p.videoFilename || null,
    thumbnailFilename: p.thumbnailFilename || null,
    durationSecs: p.durationSecs || null,
  };
}

function normalizeStory(s) {
  // Normalize legacy string views ["Levi"] → object views [{ viewer: "Levi", viewedAt: ... }]
  const views = (s.views || []).map((v) =>
    typeof v === 'string' ? { viewer: v, viewedAt: s.createdAt || new Date().toISOString() } : v,
  );
  return { ...s, views, reactions: s.reactions || [], likes: s.likes || [] };
}

const db = {
  // ─── Admin setup ──────────────────────────────────────────────────────────
  isSetupDone: () => (load().admins || []).length > 0,

  createAdmin(name, password) {
    const data = load();
    if (!data.admins) data.admins = [];
    if (data.admins.find((a) => a.name.toLowerCase() === name.toLowerCase())) throw new Error('Admin already exists');
    data.admins.push({ name, passwordHash: hashPassword(password), createdAt: new Date().toISOString() });
    save(data);
  },

  verifyAdmin(name, password) {
    const data = load();
    const admin = (data.admins || []).find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!admin || !checkPassword(password, admin.passwordHash)) return null;
    // Upgrade legacy SHA-256 hash on successful login
    if (!admin.passwordHash.startsWith('pbkdf2:')) {
      admin.passwordHash = hashPassword(password);
      save(data);
    }
    return admin;
  },

  listAdmins: () => (load().admins || []).map((a) => ({ name: a.name, createdAt: a.createdAt })),

  // ─── Invite links (per-member, one-time-use) ──────────────────────────────
  createInviteLink(label, createdBy) {
    const data = load();
    if (!data.inviteLinks) data.inviteLinks = [];
    const code = generateCode();
    const link = {
      id: data.nextId++,
      code,
      label: label || 'Invite',
      createdBy,
      createdAt: new Date().toISOString(),
      used: false,
      usedBy: null,
      usedAt: null,
      revoked: false,
    };
    data.inviteLinks.push(link);
    save(data);
    return link;
  },

  listInviteLinks: () => (load().inviteLinks || []).slice().reverse(),

  getInviteLink: (code) => (load().inviteLinks || []).find((l) => l.code === code.toUpperCase()),

  checkInviteCode(code) {
    const data = load();
    const upper = code.toUpperCase();
    const link = (data.inviteLinks || []).find((l) => l.code === upper);
    if (link) return !link.used && !link.revoked;
    return data.inviteCode === upper; // legacy global code fallback
  },

  markInviteLinkUsed(code, memberName) {
    const data = load();
    const link = (data.inviteLinks || []).find((l) => l.code === code.toUpperCase());
    if (link && !link.used) {
      link.used = true;
      link.usedBy = memberName;
      link.usedAt = new Date().toISOString();
      save(data);
    }
  },

  revokeInviteLink(code) {
    const data = load();
    const link = (data.inviteLinks || []).find((l) => l.code === code.toUpperCase());
    if (!link) throw new Error('Invite not found');
    if (link.used) throw new Error('This invite has already been used');
    link.revoked = true;
    save(data);
  },

  // ─── Members ──────────────────────────────────────────────────────────────
  getInviteCode: () => load().inviteCode,
  checkInviteCode_legacy: (code) => load().inviteCode === code.toUpperCase(),

  getMembers: () => load().members.map((m) => ({ id: m.id, name: m.name, avatarVersion: m.avatarVersion || null })),
  getMemberByName: (name) => load().members.find((m) => m.name.toLowerCase() === name.toLowerCase()),

  insertMember(name, password) {
    const data = load();
    if (data.members.find((m) => m.name.toLowerCase() === name.toLowerCase())) throw new Error('Name already taken');
    const member = { id: data.nextId++, name, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    data.members.push(member);
    save(data);
    return member;
  },

  verifyMember(name, password) {
    const data = load();
    const m = data.members.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!m || !checkPassword(password, m.passwordHash)) return null;
    // Upgrade legacy SHA-256 hash on successful login
    if (!m.passwordHash.startsWith('pbkdf2:')) {
      m.passwordHash = hashPassword(password);
      save(data);
    }
    return m;
  },

  deleteMember(name) {
    const data = load();
    const idx = data.members.findIndex((m) => m.name.toLowerCase() === name.toLowerCase());
    if (idx < 0) throw new Error('Member not found');
    data.members.splice(idx, 1);
    save(data);
  },

  // Delete a member and ALL their content. Returns { storageFiles, avatarName } for caller to delete from disk.
  removeMemberWithContent(name) {
    const data = load();
    const idx = data.members.findIndex((m) => m.name.toLowerCase() === name.toLowerCase());
    if (idx < 0) throw new Error('Member not found');
    const memberName = data.members[idx].name;

    const storageFiles = [];

    // Remove their posts; collect filenames for disk cleanup
    data.posts = (data.posts || []).filter((p) => {
      if (p.author !== memberName) return true;
      (p.filenames || []).forEach((f) => storageFiles.push(f));
      if (p.videoFilename) storageFiles.push(p.videoFilename);
      if (p.thumbnailFilename) storageFiles.push(p.thumbnailFilename);
      return false;
    });

    // Remove their comments/likes/saves from other posts
    (data.posts || []).forEach((p) => {
      p.comments = (p.comments || []).filter((c) => c.author !== memberName);
      p.likes = (p.likes || []).filter((n) => n !== memberName);
      p.savedBy = (p.savedBy || []).filter((n) => n !== memberName);
    });

    // Remove their stories
    data.stories = (data.stories || []).filter((s) => {
      if (s.author !== memberName) return true;
      storageFiles.push(s.filename);
      return false;
    });

    // Remove their messages
    data.messages = (data.messages || []).filter((m) => m.author !== memberName);

    // Delete DMs they were part of AND group chats they created (and their messages)
    const deadConvoIds = [];
    data.conversations = (data.conversations || []).filter((c) => {
      if ((c.isDM && (c.memberNames || []).includes(memberName)) || c.createdBy === memberName) {
        deadConvoIds.push(c.id);
        return false;
      }
      c.memberNames = (c.memberNames || []).filter((n) => n !== memberName);
      return true;
    });
    if (deadConvoIds.length) {
      data.messages = (data.messages || []).filter((m) => !deadConvoIds.includes(m.conversationId));
    }

    // Remove collections they own; remove them from others
    data.collections = (data.collections || []).filter((col) => {
      if (col.author === memberName) return false;
      col.memberNames = (col.memberNames || []).filter((n) => n !== memberName);
      return true;
    });

    data.members.splice(idx, 1);
    save(data);
    return { storageFiles, avatarName: memberName };
  },

  updateAvatarVersion(name) {
    const data = load();
    const member = data.members.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (!member) return null;
    member.avatarVersion = Date.now();
    save(data);
    return member.avatarVersion;
  },

  // Returns filenames of expired stories for disk cleanup, then removes them from DB
  purgeExpiredStories() {
    const data = load();
    const now = Date.now();
    const expired = [];
    data.stories = (data.stories || []).filter((s) => {
      if (new Date(s.expiresAt).getTime() > now) return true;
      expired.push(s.filename);
      return false;
    });
    if (expired.length) save(data);
    return expired;
  },

  updateMember(currentName, { newName, newPassword }) {
    const data = load();
    const member = data.members.find((m) => m.name.toLowerCase() === currentName.toLowerCase());
    if (!member) throw new Error('Member not found');

    if (newName && newName.trim() !== currentName) {
      const trimmed = newName.trim();
      if (data.members.find((m) => m.name.toLowerCase() === trimmed.toLowerCase() && m.id !== member.id))
        throw new Error('That name is already taken');

      const old = member.name;
      member.name = trimmed;

      // Cascade rename across all content
      (data.posts || []).forEach((p) => {
        if (p.author === old) p.author = trimmed;
        (p.comments || []).forEach((c) => { if (c.author === old) c.author = trimmed; });
        if (p.likes) p.likes = p.likes.map((n) => n === old ? trimmed : n);
        if (p.savedBy) p.savedBy = p.savedBy.map((n) => n === old ? trimmed : n);
      });
      (data.stories || []).forEach((s) => {
        if (s.author === old) s.author = trimmed;
        if (s.views) s.views = s.views.map((n) => n === old ? trimmed : n);
      });
      (data.messages || []).forEach((m) => {
        if (m.author === old) m.author = trimmed;
        if (m.readBy) m.readBy = m.readBy.map((n) => n === old ? trimmed : n);
      });
      (data.conversations || []).forEach((c) => {
        if (c.createdBy === old) c.createdBy = trimmed;
        c.memberNames = (c.memberNames || []).map((n) => n === old ? trimmed : n);
      });
      (data.collections || []).forEach((col) => {
        if (col.author === old) col.author = trimmed;
        col.memberNames = (col.memberNames || []).map((n) => n === old ? trimmed : n);
        if (col.postIds) {
          // collection posts' comments handled above in posts loop
        }
      });
    }

    if (newPassword) member.passwordHash = hashPassword(newPassword);

    save(data);
    return member;
  },

  // Posts
  getPosts(memberName) {
    const data = load();
    const posts = data.posts.slice().reverse().map(normalizePost);
    if (!memberName) return posts;
    const postCollMap = {};
    for (const col of (data.collections || [])) {
      for (const pid of (col.postIds || [])) {
        if (!postCollMap[pid]) postCollMap[pid] = [];
        postCollMap[pid].push(col.memberNames || [col.author]);
      }
    }
    return posts.filter((p) => {
      const collMemberLists = postCollMap[p.id];
      if (!collMemberLists) return true;
      return collMemberLists.some((members) => members.includes(memberName));
    });
  },

  getPostById(id) {
    const p = load().posts.find((p) => p.id === id);
    return p ? normalizePost(p) : null;
  },

  insertPost(filenames, author, caption, mediaType = 'image', videoFilename = null, thumbnailFilename = null, durationSecs = null) {
    const data = load();
    const arr = Array.isArray(filenames) ? filenames : [filenames];
    const post = {
      id: data.nextId++,
      filenames: arr,
      author,
      caption: caption || '',
      likes: [],
      comments: [],
      savedBy: [],
      createdAt: new Date().toISOString(),
      mediaType,
      videoFilename: videoFilename || null,
      thumbnailFilename: thumbnailFilename || null,
      durationSecs: durationSecs ? Number(durationSecs) : null,
    };
    data.posts.push(post);
    save(data);
    return post;
  },

  deletePost(id, requestingMember) {
    const data = load();
    const idx = data.posts.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error('Post not found');
    if (data.posts[idx].author !== requestingMember) throw new Error('Not your post');
    const [post] = data.posts.splice(idx, 1);
    save(data);
    const files = post.filenames || (post.filename ? [post.filename] : []);
    if (post.videoFilename) files.push(post.videoFilename);
    if (post.thumbnailFilename) files.push(post.thumbnailFilename);
    return files;
  },

  toggleLike(id, memberName) {
    const data = load();
    const post = data.posts.find((p) => p.id === id);
    if (!post) throw new Error('Post not found');
    if (!post.likes) post.likes = [];
    const i = post.likes.indexOf(memberName);
    if (i >= 0) post.likes.splice(i, 1); else post.likes.push(memberName);
    save(data);
    return post.likes;
  },

  addComment(postId, author, text, gifUrl = null, imageX = null, imageY = null, imageIndex = 0) {
    const data = load();
    const post = data.posts.find((p) => p.id === postId);
    if (!post) throw new Error('Post not found');
    if (!post.comments) post.comments = [];
    const comment = {
      id: data.nextId++,
      author,
      text,
      gifUrl: gifUrl || null,
      imageX: imageX != null ? Number(imageX) : null,
      imageY: imageY != null ? Number(imageY) : null,
      imageIndex: Number(imageIndex) || 0,
      createdAt: new Date().toISOString(),
    };
    post.comments.push(comment);
    save(data);
    return comment;
  },

  deleteComment(postId, commentId, requestingMember) {
    const data = load();
    const post = data.posts.find((p) => p.id === postId);
    if (!post) throw new Error('Post not found');
    const i = (post.comments || []).findIndex((c) => c.id === commentId);
    if (i < 0) throw new Error('Comment not found');
    if (post.comments[i].author !== requestingMember) throw new Error('Not your comment');
    post.comments.splice(i, 1);
    save(data);
  },

  toggleSave(postId, memberName) {
    const data = load();
    const post = data.posts.find((p) => p.id === postId);
    if (!post) throw new Error('Post not found');
    if (!post.savedBy) post.savedBy = [];
    const i = post.savedBy.indexOf(memberName);
    if (i >= 0) post.savedBy.splice(i, 1); else post.savedBy.push(memberName);
    save(data);
    return post.savedBy;
  },

  // Stories
  insertStory(filename, author, durationHours, caption = '') {
    const data = load();
    if (!data.stories) data.stories = [];
    const story = {
      id: data.nextId++,
      filename,
      author,
      caption: caption || '',
      durationHours,
      expiresAt: new Date(Date.now() + durationHours * 3600000).toISOString(),
      createdAt: new Date().toISOString(),
      views: [],
      reactions: [],
      likes: [],
    };
    data.stories.push(story);
    save(data);
    return story;
  },

  getActiveStories() {
    const now = Date.now();
    return (load().stories || []).filter((s) => new Date(s.expiresAt).getTime() > now).map(normalizeStory);
  },

  deleteStory(id, requestingMember) {
    const data = load();
    const i = (data.stories || []).findIndex((s) => s.id === id);
    if (i < 0) throw new Error('Story not found');
    if (data.stories[i].author !== requestingMember) throw new Error('Not your story');
    data.stories.splice(i, 1);
    save(data);
  },

  recordStoryView(storyId, memberName) {
    const data = load();
    const story = (data.stories || []).find((s) => s.id === storyId);
    if (!story) return;
    if (!story.views) story.views = [];
    // Normalize any legacy string entries first
    story.views = story.views.map((v) =>
      typeof v === 'string' ? { viewer: v, viewedAt: story.createdAt || new Date().toISOString() } : v,
    );
    const alreadyViewed = story.views.some((v) => v.viewer === memberName);
    if (!alreadyViewed) {
      story.views.push({ viewer: memberName, viewedAt: new Date().toISOString() });
      save(data);
    }
    return story.views;
  },

  toggleStoryReaction(storyId, memberName, emoji) {
    const data = load();
    const story = (data.stories || []).find((s) => s.id === storyId);
    if (!story) throw new Error('Story not found');
    if (!story.reactions) story.reactions = [];
    const existing = story.reactions.find((r) => r.author === memberName);
    if (existing) {
      if (existing.emoji === emoji) {
        // same emoji → remove reaction
        story.reactions = story.reactions.filter((r) => r.author !== memberName);
      } else {
        // different emoji → replace
        existing.emoji = emoji;
        existing.createdAt = new Date().toISOString();
      }
    } else {
      story.reactions.push({ author: memberName, emoji, createdAt: new Date().toISOString() });
    }
    save(data);
    return story.reactions;
  },

  getStoryViewers(storyId, requestingMember) {
    const data = load();
    const story = (data.stories || []).find((s) => s.id === storyId);
    if (!story) throw new Error('Story not found');
    if (story.author !== requestingMember) throw new Error('Only the story author can see viewers');
    const normalized = normalizeStory(story);
    return { views: normalized.views, reactions: normalized.reactions };
  },

  deleteConversation(id, requestingMember) {
    const data = load();
    const i = (data.conversations || []).findIndex((c) => c.id === id);
    if (i < 0) throw new Error('Conversation not found');
    const convo = data.conversations[i];
    // Must be a member of the conversation
    if (!(convo.memberNames || []).includes(requestingMember))
      throw new Error('You cannot delete this conversation');
    // For group chats, only the creator can fully delete
    if (!convo.isDM && convo.createdBy !== requestingMember)
      throw new Error('Only the creator can delete a group chat');
    data.conversations.splice(i, 1);
    data.messages = (data.messages || []).filter((m) => m.conversationId !== id);
    save(data);
  },

  // Find or create a 1:1 DM conversation between two members
  findOrCreateDM(memberA, memberB) {
    const data = load();
    if (!data.conversations) data.conversations = [];
    const existing = data.conversations.find(
      (c) => c.isDM && c.memberNames.includes(memberA) && c.memberNames.includes(memberB) && c.memberNames.length === 2
    );
    if (existing) return existing;
    const dm = {
      id: data.nextId++,
      isDM: true,
      memberNames: [memberA, memberB],
      createdBy: memberA,
      createdAt: new Date().toISOString(),
    };
    data.conversations.push(dm);
    save(data);
    return dm;
  },

  // Conversations visible to a member — strictly filtered to their memberNames
  getConversations(memberName = null) {
    const data = load();
    if (!data.conversations) data.conversations = [];
    if (!data.messages) data.messages = [];
    // Only return conversations the requesting member actually belongs to
    const visible = memberName
      ? data.conversations.filter((c) => (c.memberNames || []).includes(memberName))
      : data.conversations;
    return visible.map((c) => {
      const msgs = (data.messages || []).filter((m) => m.conversationId === c.id);
      const last = msgs[msgs.length - 1] || null;
      const unreadCount = memberName
        ? msgs.filter((m) => !(m.readBy || []).includes(memberName)).length
        : 0;
      return { ...c, lastMessage: last, messageCount: msgs.length, unreadCount };
    }).sort((a, b) => {
      const ta = a.lastMessage?.createdAt || a.createdAt;
      const tb = b.lastMessage?.createdAt || b.createdAt;
      return new Date(tb) - new Date(ta);
    });
  },

  insertConversation(name, memberNames, createdBy) {
    const data = load();
    if (!data.conversations) data.conversations = [];
    const col = {
      id: data.nextId++,
      name,
      memberNames,
      createdBy,
      createdAt: new Date().toISOString(),
    };
    data.conversations.push(col);
    save(data);
    return col;
  },

  addConversationMember(conversationId, memberName, requestingMember) {
    const data = load();
    const conv = (data.conversations || []).find((c) => c.id === conversationId);
    if (!conv) throw new Error('Conversation not found');
    if (conv.isDM) throw new Error('Cannot add members to a DM');
    if (conv.createdBy !== requestingMember) throw new Error('Only the creator can add members');
    if (!conv.memberNames.includes(memberName)) conv.memberNames.push(memberName);
    save(data);
    return conv;
  },

  removeConversationMember(conversationId, memberName, requestingMember) {
    const data = load();
    const conv = (data.conversations || []).find((c) => c.id === conversationId);
    if (!conv) throw new Error('Conversation not found');
    if (conv.isDM) throw new Error('Cannot remove members from a DM');
    if (conv.createdBy !== requestingMember && requestingMember !== memberName)
      throw new Error('Only the creator can remove others');
    conv.memberNames = conv.memberNames.filter((n) => n !== memberName);
    save(data);
    return conv;
  },

  getMessages(conversationId, requestingMember) {
    const data = load();
    if (!data.conversations) data.conversations = [];
    const conv = data.conversations.find((c) => c.id === conversationId);
    if (!conv) throw new Error('Conversation not found');
    if (requestingMember && !(conv.memberNames || []).includes(requestingMember))
      throw new Error('Not a member of this conversation');
    const msgs = (data.messages || []).filter((m) => m.conversationId === conversationId);
    const last200 = msgs.slice(-200);
    if (!requestingMember) return last200;
    return last200.map((m) => {
      if (!m.postRef || !m.postRef.imageUrl) return m;
      if (canAccessPost(requestingMember, m.postRef.id, data)) return m;
      return { ...m, postRef: { ...m.postRef, imageUrl: null, isRestricted: true } };
    });
  },

  insertMessage(conversationId, author, text, gifUrl = null, imageUrl = null, videoUrl = null, replyToId = null, postRef = null) {
    const data = load();
    if (!data.conversations) data.conversations = [];
    const conv = data.conversations.find((c) => c.id === conversationId);
    if (!conv) throw new Error('Conversation not found');
    if (!(conv.memberNames || []).includes(author)) throw new Error('Not a member of this conversation');
    if (!data.messages) data.messages = [];
    let replyPreview = null;
    if (replyToId) {
      const ref = data.messages.find((m) => m.id === Number(replyToId));
      if (ref) replyPreview = { id: ref.id, author: ref.author, text: ref.text || null };
    }
    const msg = {
      id: data.nextId++,
      conversationId,
      author,
      text,
      gifUrl: gifUrl || null,
      imageUrl: imageUrl || null,
      videoUrl: videoUrl || null,
      replyToId: replyToId ? Number(replyToId) : null,
      replyPreview,
      postRef: postRef || null,
      reactions: {},
      createdAt: new Date().toISOString(),
      readBy: [author],
    };
    data.messages.push(msg);
    save(data);
    return msg;
  },

  reactToMessage(messageId, memberName, emoji) {
    const data = load();
    const msg = (data.messages || []).find((m) => m.id === messageId);
    if (!msg) throw new Error('Message not found');
    const conv = (data.conversations || []).find((c) => c.id === msg.conversationId);
    if (conv && !(conv.memberNames || []).includes(memberName))
      throw new Error('Not a member of this conversation');
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(memberName);
    if (idx >= 0) {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(memberName);
    }
    save(data);
    return msg;
  },

  markMessagesRead(conversationId, memberName) {
    const data = load();
    const conv = (data.conversations || []).find((c) => c.id === conversationId);
    if (!conv || !(conv.memberNames || []).includes(memberName)) return;
    let changed = false;
    (data.messages || []).forEach((m) => {
      if (m.conversationId === conversationId && !(m.readBy || []).includes(memberName)) {
        if (!m.readBy) m.readBy = [];
        m.readBy.push(memberName);
        changed = true;
      }
    });
    if (changed) save(data);
  },

  deleteMessage(messageId, requestingMember) {
    const data = load();
    const idx = (data.messages || []).findIndex((m) => m.id === messageId);
    if (idx < 0) throw new Error('Message not found');
    if (data.messages[idx].author !== requestingMember) throw new Error('Not your message');
    data.messages.splice(idx, 1);
    save(data);
  },

  toggleStoryLike(storyId, memberName) {
    const data = load();
    const story = (data.stories || []).find((s) => s.id === storyId);
    if (!story) throw new Error('Story not found');
    if (!story.likes) story.likes = [];
    const i = story.likes.indexOf(memberName);
    if (i >= 0) story.likes.splice(i, 1);
    else story.likes.push(memberName);
    save(data);
    return story.likes;
  },

  // Collections
  getCollections(memberName) {
    const data = load();
    return (data.collections || []).filter((c) =>
      c.author === memberName || (c.memberNames || []).includes(memberName)
    );
  },

  insertCollection(name, author) {
    const data = load();
    if (!data.collections) data.collections = [];
    const col = { id: data.nextId++, name, author, memberNames: [author], postIds: [], createdAt: new Date().toISOString() };
    data.collections.push(col);
    save(data);
    return col;
  },

  deleteCollection(id, requestingMember) {
    const data = load();
    const i = (data.collections || []).findIndex((c) => c.id === id);
    if (i < 0) throw new Error('Collection not found');
    if (data.collections[i].author !== requestingMember) throw new Error('Not your collection');
    data.collections.splice(i, 1);
    save(data);
  },

  addCollectionMember(colId, memberName, requestingMember) {
    const data = load();
    const col = (data.collections || []).find((c) => c.id === colId);
    if (!col) throw new Error('Collection not found');
    if (col.author !== requestingMember) throw new Error('Only the creator can add members');
    if (!col.memberNames) col.memberNames = [col.author];
    if (!col.memberNames.includes(memberName)) col.memberNames.push(memberName);
    save(data);
    return col;
  },

  removeCollectionMember(colId, memberName, requestingMember) {
    const data = load();
    const col = (data.collections || []).find((c) => c.id === colId);
    if (!col) throw new Error('Collection not found');
    if (col.author !== requestingMember) throw new Error('Only the creator can remove members');
    if (memberName === col.author) throw new Error('Creator cannot be removed');
    col.memberNames = (col.memberNames || []).filter((n) => n !== memberName);
    save(data);
    return col;
  },

  addToCollection(colId, postId, requestingMember) {
    const data = load();
    const col = (data.collections || []).find((c) => c.id === colId);
    if (!col) throw new Error('Collection not found');
    if (requestingMember) {
      const post = (data.posts || []).find((p) => p.id === postId);
      if (!post) throw new Error('Post not found');
      if (post.author !== requestingMember) throw new Error('Only the post owner can add it to a collection');
      const members = col.memberNames || [col.author];
      if (!members.includes(requestingMember)) throw new Error('You are not a member of this collection');
    }
    if (!col.postIds.includes(postId)) col.postIds.push(postId);
    save(data);
    return col;
  },

  removeFromCollection(colId, postId) {
    const data = load();
    const col = (data.collections || []).find((c) => c.id === colId);
    if (!col) throw new Error('Collection not found');
    col.postIds = col.postIds.filter((id) => id !== postId);
    save(data);
  },

  getCollectionPosts(colId, memberName) {
    const data = load();
    const col = (data.collections || []).find((c) => c.id === colId);
    if (!col) throw new Error('Collection not found');
    const members = col.memberNames || [col.author];
    if (memberName && col.author !== memberName && !members.includes(memberName))
      throw new Error('You do not have access to this collection');
    return col.postIds.map((id) => data.posts.find((p) => p.id === id)).filter(Boolean).map(normalizePost);
  },
};

module.exports = db;
