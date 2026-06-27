# FamilyVault

A self-hosted private social media app for families. Photos, videos, stories, and group chat — all stored on hardware you own, with no third-party cloud.

## Overview

FamilyVault runs as a Node.js server on a local machine or single-board computer (tested on Raspberry Pi CM4 with NVMe storage). The mobile app connects directly to your server over your home network or via a Cloudflare Tunnel for remote access.

There are no accounts, no subscriptions, and no data leaving your home.

## Features

- Photo and video feed with likes, comments, and saves
- Stories with configurable expiration
- Private collections shared between selected family members
- Group chat and direct messages with GIF support and media sharing
- Invite-link based registration — no email required
- Admin panel for member management and server-side backups
- Password reset flow managed through the admin panel

## Tech Stack

**Server**
- Node.js with Express
- better-sqlite3 (SQLite with WAL mode)
- JWT authentication
- Multer for media uploads
- Cloudflare Tunnel for remote access (optional)

**App**
- React Native with Expo
- expo-image for disk-cached media
- React Navigation
- expo-av for video playback

## Hardware

Developed and tested on a Raspberry Pi Compute Module 4 with a 938 GB NVMe drive. Any Linux machine running Node 18+ will work.

## Setup

### Server

```bash
cd vault
cp .env.example .env        # fill in JWT_SECRET and VAULT_ACCESS_KEY
npm install
npm start
```

Environment variables:

| Variable | Description |
|---|---|
| `JWT_SECRET` | Random secret for signing tokens. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `VAULT_ACCESS_KEY` | Short key shown in the admin QR code for joining the vault |
| `DATA_DIR` | Path to the SQLite database directory (default: `./data`) |
| `STORAGE_DIR` | Path to the media storage directory (default: `./storage`) |
| `PORT` | Server port (default: 3000) |

On first run the server creates the SQLite database and prompts you to create an admin account via the `/admin` panel.

### Systemd (Pi)

```ini
[Unit]
Description=FamilyVault
After=network.target

[Service]
WorkingDirectory=/path/to/vault
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
Environment=JWT_SECRET=...
Environment=VAULT_ACCESS_KEY=...
Environment=DATA_DIR=/mnt/storage/vault/data
Environment=STORAGE_DIR=/mnt/storage/vault/storage

[Install]
WantedBy=multi-user.target
```

### App

```bash
cd app
npm install
npx expo start
```

Scan the QR code in the admin panel with the mobile app to connect to your server.

## Security Notes

- The admin panel does not expose user content. Backups are server-side only and accessible via SSH.
- Invite links are single-use and can be revoked.
- Passwords are hashed with PBKDF2 (100,000 iterations, SHA-256).
- Login attempts are rate-limited per IP.
- Media files are served with JWT authentication.

## License

MIT
