# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in FamilyVault, please **do not open a public GitHub issue**. Instead, report it privately:

- **GitHub:** Use [GitHub's private vulnerability reporting](https://github.com/LevyTheDevy/Family-Vault/security/advisories/new)
- **Email:** levieichelberg2000@gmail.com

Please include:
- A description of the vulnerability
- Steps to reproduce it
- The potential impact
- Any suggested fix (optional)

You can expect an acknowledgement within 48 hours and a status update within 7 days.

## Encryption Model

FamilyVault uses end-to-end encryption for all user content:

- **Algorithm:** AES-256-GCM with a random 12-byte IV per message
- **Key derivation:** PBKDF2-SHA256 (10,000 iterations) from the user's password
- **Vault key:** A single 32-byte key shared across vault members, wrapped individually per user with their derived key
- **Scope:** Messages, captions, comments, and photos are encrypted on-device before upload. The server stores and serves only ciphertext.
- **Not encrypted:** Avatars, usernames, timestamps, and video files

The cryptographic primitives are provided by [@noble/hashes](https://github.com/paulmillr/noble-hashes) and [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) — pure JavaScript, no native modules.

## Scope

This policy covers the FamilyVault server (`vault/`) and mobile app (`app/`). Third-party dependencies are out of scope — please report those to their respective maintainers.
