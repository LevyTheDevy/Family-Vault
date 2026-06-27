# FamilyVault

A self-hosted private social media app for families. Photos, videos, stories, and group chat — stored on hardware you own, with no third-party cloud.

---

## Quick Start

You need one computer to act as the server (always-on works best — a spare PC, a Raspberry Pi, or any home server). Everyone else just installs the app.

### Step 1 — Install Docker Desktop

Download and install Docker Desktop for your operating system:

- Windows: https://docs.docker.com/desktop/install/windows-install/
- Mac: https://docs.docker.com/desktop/install/mac-install/
- Linux: https://docs.docker.com/desktop/install/linux-install/

Once installed, open Docker Desktop and make sure it is running (you will see a whale icon in your taskbar or menu bar).

### Step 2 — Download FamilyVault

Download this repository as a ZIP file from GitHub (click the green Code button, then Download ZIP), then unzip it somewhere you will remember, like your Documents folder.

### Step 3 — Start the server

Open a terminal in the folder you unzipped:

- Windows: right-click the folder and choose "Open in Terminal"
- Mac: right-click the folder, hold Option, and choose "Open Terminal Here"

Then run:

```
docker compose up -d
```

That is it. Docker will download everything it needs, build the server, and start it. The first run takes a few minutes.

### Step 4 — Create your admin account

Open your browser and go to:

```
http://localhost:3001/admin
```

The admin panel runs on port 3001, which is bound to localhost only. It is never reachable through Cloudflare or from any other device on your network — only from a browser on the machine running the server.

Create your admin account here. This gives you access to the admin panel where you can create invite links for family members.

### Step 5 — Invite family members

In the admin panel, create an invite link and share it with family members. They scan the QR code in the app to join.

### Stopping and starting

```
docker compose stop      # stop the server
docker compose start     # start it again
docker compose down      # stop and remove containers (data is kept)
```

### Updating

```
docker compose down
docker compose build --no-cache
docker compose up -d
```

---

## Accessing from outside your home

By default the server is only accessible on your home network. To let family members connect remotely, set up a Cloudflare Tunnel (free):

1. Create a free account at cloudflare.com
2. Follow the Cloudflare Tunnel setup guide to point a domain or subdomain at `localhost:3000`

The app will work over the tunnel the same way it works locally.

---

## Raspberry Pi

Docker works on the Pi out of the box. Install Docker with:

```
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Log out and back in, then follow the same steps from Step 2 above. The Pi makes an ideal always-on server since it draws very little power.

---

## Manual setup (advanced)

If you prefer not to use Docker:

**Requirements:** Node.js 18 or later

```bash
cd vault
npm install
node src/index.js
```

All secrets (JWT key, vault access key) are auto-generated on first run and saved to the data directory. No environment variables required.

To customise paths or use your own secrets, set these environment variables before starting:

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `./data` | Where the database and generated secrets are stored |
| `STORAGE_DIR` | `./storage` | Where uploaded photos and videos are stored |
| `BACKUP_DIR` | `./backups` | Where server-side backups are saved |
| `VAULT_NAME` | `Family Vault` | Name shown in the app |
| `JWT_SECRET` | auto-generated | Override the JWT signing secret |
| `VAULT_ACCESS_KEY` | auto-generated | Override the vault access key shown in the admin QR code |
| `PORT` | `3000` | App API port |
| `ADMIN_PORT` | `3001` | Admin panel port (localhost only) |

---

## Features

- Photo and video feed with likes, comments, and saves
- Stories with configurable expiration
- Private collections shared between selected family members
- Group chat and direct messages with GIF support and media sharing
- Invite-link based registration — no email required
- Admin panel for member management and server-side backups
- Password reset flow managed through the admin panel

---

## Tech Stack

**Server:** Node.js, Express, better-sqlite3, Multer, JWT

**App:** React Native, Expo, expo-image, React Navigation, expo-av

---

## Security Notes

- The admin panel does not expose user content. Backups are server-side only and accessible via SSH.
- Invite links are single-use and can be revoked.
- Passwords are hashed with PBKDF2 (100,000 iterations, SHA-256).
- Login attempts are rate-limited per IP.
- Media files are served with JWT authentication.

---

## License

PolyForm Noncommercial 1.0.0 — free to use, modify, and self-host for personal or organizational non-commercial purposes. Commercial use (selling the software or offering paid services built on it) is not permitted. See [LICENSE](LICENSE) for full terms.
