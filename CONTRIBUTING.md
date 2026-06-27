# Contributing to FamilyVault

Thanks for your interest in contributing. FamilyVault is a self-hosted family app — contributions that make it easier to deploy, more private, or more reliable are very welcome.

## Before You Start

- Check existing [Issues](https://github.com/LevyTheDevy/Family-Vault/issues) and [Pull Requests](https://github.com/LevyTheDevy/Family-Vault/pulls) to avoid duplicate work
- For large changes, open an Issue first to discuss the approach before writing code

## What We Welcome

- Bug fixes
- Security improvements
- Performance improvements
- Better self-hosting documentation
- Accessibility improvements in the app
- Translations

## What We Won't Accept

- Features that send user data to any third-party service
- Anything that weakens or bypasses the E2E encryption model
- Commercial integrations
- Content that violates the [Code of Conduct](CODE_OF_CONDUCT.md)

## How to Contribute

1. Fork the repository
2. Create a branch: `git checkout -b fix/your-description`
3. Make your changes and test them (server + app)
4. Commit with a clear message describing what and why
5. Open a Pull Request against `master`

## Development Setup

**Server:**
```bash
cd vault
npm install
node src/index.js
```

**App:**
```bash
cd app
npm install
npx expo start
```

You'll need Node.js 18+ and the Expo Go app (or a simulator) to run the app locally.

## Security Issues

Do not open public Issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the private reporting process.
