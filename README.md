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

### Step 3 — Run the setup script

This detects your IP, configures everything, starts the server, and opens the admin panel automatically.

- **Windows:** Double-click `start.bat`
- **Mac / Linux:** Open a terminal in the folder and run `./start.sh`

The first run takes a few minutes while Docker builds the server. After that it starts in seconds.

### Step 4 — Create your admin account

The setup script opens the admin panel in your browser automatically. Create your admin account there.

The admin panel is only accessible on your local network — it is never reachable from the internet.

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
- End-to-end encryption for all messages, captions, comments, and photos

---

## Tech Stack

**Server:** Node.js, Express, better-sqlite3, Multer, JWT

**App:** React Native, Expo, expo-image, React Navigation, expo-av

---

## Security Notes

- **End-to-end encryption:** All messages, captions, comments, and photos are encrypted with AES-256-GCM before leaving the device. The server stores only ciphertext — it never sees plaintext content.
- **Vault key:** A single vault key is shared across all members, derived via PBKDF2-SHA256 and wrapped individually with each member's password. The server never holds the unwrapped key.
- The admin panel does not expose user content. Backups are server-side only and accessible via SSH.
- Invite links are single-use and can be revoked.
- Passwords are hashed with PBKDF2 (100,000 iterations, SHA-256).
- Login attempts are rate-limited per IP.
- Media files are served with JWT authentication.

To report a security vulnerability, see [SECURITY.md](SECURITY.md).

---

## Legal & Content Policy

FamilyVault is a self-hosted tool. **The person who deploys and operates the server is solely responsible** for all content stored and for compliance with applicable laws in their jurisdiction, including but not limited to:

- Data protection and privacy laws (e.g. GDPR, CCPA, COPPA)
- Laws governing the storage of images and videos of minors
- Parental consent requirements for children's data

**Prohibited content:** FamilyVault must not be used to store, share, or distribute any illegal content, including child sexual abuse material (CSAM). This is an absolute prohibition with no exceptions. If you encounter or suspect CSAM, report it immediately to the [National Center for Missing & Exploited Children (NCMEC)](https://www.missingkids.org/gethelpnow/cybertipline) or your country's equivalent authority.

The author provides this software as-is with no warranty. See [LICENSE](LICENSE) for full terms.

---

## License

PolyForm Noncommercial 1.0.0 — free to use, modify, and self-host for personal or organizational non-commercial purposes. Commercial use (selling the software or offering paid services built on it) is not permitted. See [LICENSE](LICENSE) for full terms.
