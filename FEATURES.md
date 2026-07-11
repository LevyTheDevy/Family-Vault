# FamilyVault — Current Build

This document covers what is built and working in the current version. FamilyVault is a proof of concept and not a production product.

---

## App

### Feed
- Full-screen vertical scroll feed, one post per screen
- Photo and video posts with in-app video trimming (up to 60 seconds)
- Like, comment, and bookmark actions
- Multi-photo posts with swipe between images
- Post captions (end-to-end encrypted)
- Author name, avatar, and timestamp on each post
- Long-press post menu: view full screen, add to collection
- Pull-to-refresh and infinite scroll pagination

### Dailies (Stories)
- Disappearing photo and video stories
- Configurable expiry: 1 hour, 6 hours, 24 hours, 48 hours, or 1 week
- Story ring on the feed header showing active dailies from all members
- Tap to view, swipe to advance

### Collections
- Shared photo albums between selected family members
- Built-in "All Members" collection — every post made without picking a collection lands here automatically, so the full family archive is always browsable
- Save any feed post to a collection
- Per-collection member access control
- Offline collection: save posts to device for offline viewing
- Cover photo auto-selected from first item

### Messages
- Direct messages between two members
- Group conversations with any number of members
- End-to-end encrypted text messages
- Image sharing in chat (encrypted)
- GIF support via built-in GIF picker
- Swipe-to-reply with quoted message preview
- Read receipts and delivery indicators
- Unread badge count on tab bar
- Lock icon on each message confirming encryption

### Notifications
- In-app notification center (bell icon on the feed): likes, comments, new posts, unread chats
- Unseen-count badge on the bell, unread-message badge on the Messages tab
- OS push notifications via Expo push service (new messages, posts, likes, comments)
- Push content is generic by design — names and event type only, never decrypted content

### Settings
- Display name and password change
- Theme and appearance customization
- Multi-vault management (connect to multiple servers)
- Disconnect from all vaults

### Appearance
- Light and dark base themes
- Custom accent color picker (10 preset colors)
- Custom app background image (applies across all screens including chat)
- Per-vault color identity

---

## Security and Encryption

- All messages, captions, comments, photos, and videos encrypted with AES-256-GCM on-device before upload
- Vault key derived via PBKDF2-SHA256, never transmitted to the server
- Vault key wrapped individually per member with their password
- Vault key stored in device secure enclave (Android Keystore / iOS Secure Enclave)
- Server stores only ciphertext — plaintext content is never visible server-side
- JWT authentication required on every API request
- Media files require valid JWT to serve — no unauthenticated access to storage
- Invite links are single-use and revocable
- Passwords hashed with PBKDF2 (100,000 iterations, SHA-256)
- Login attempts rate-limited per IP
- Admin panel never routed through Cloudflare Tunnel — local network only

---

## Server

- Node.js and Express API
- SQLite database via better-sqlite3
- Encrypted file storage with three image variants per upload: full resolution, feed resolution, thumbnail
- JWT-authenticated media serving
- Automatic story expiry
- Server-side backup and restore via admin panel
- Health endpoint for vault name and status

---

## Admin Panel

- Local-only web UI on port 3001 (never internet-facing)
- Member management: view all members, reset passwords
- Invite link generation with QR code
- Single-use invite enforcement
- Server URL configuration
- Backup and restore
- Vault name configuration

---

## Infrastructure

- Docker and Docker Compose for zero-dependency deployment
- Runs on Raspberry Pi, spare PC, Mac, Linux, or Windows with Docker Desktop
- Auto-detects LAN IP on startup
- Cloudflare Tunnel integration for remote access (optional)
- Tunnel starts automatically on server start if configured
- `start.bat` / `start.sh` setup scripts for non-technical users
- `remote-access.bat` / `remote-access.sh` for Cloudflare Tunnel setup

---

## Mobile App Distribution

- Android: APK via GitHub Releases
- iOS: TestFlight (external testing, pending Apple review)
- Built with React Native and Expo
- EAS cloud builds — no Mac required for iOS builds

---

## Known Limitations

- iOS requires TestFlight — no App Store listing
- Android requires sideloading — not on Google Play
- No web client
- Single vault key shared across all members (no per-member key isolation)
- Admin panel has no per-post moderation tools — content removal requires direct server access
- No audit log of uploads or member activity
- Video posts limited to 60 seconds
