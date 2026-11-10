# Phase 10 — Tasks

## T10.1 — Crypto
- [x] `yarn add @noble/ciphers @noble/hashes` (or audit-approved noble stack)
- [x] Implement PBKDF2 + AES-256-GCM envelope `[version|salt|iv|ciphertext+tag]`.
- [x] Add TEST-BKP-01.

## T10.2 — Google clients
- [x] `yarn add @react-native-google-signin/google-signin`
- [x] Drive appDataFolder upload/list/rotate (keep 10).
- [x] Calendar idempotent event upsert via REST + private extendedProperties.
- [x] Ensure `googleapis` is **not** installed.

## T10.3 — UX + restore
- [x] Passphrase setup / unlock screens.
- [x] Backup now + restore flow with sync_epoch bump.

## T10.4 — Gates
- [x] `yarn test -- tests/backup`
- [x] Disaster drill checklist signed off.
- [x] `yarn tsc --noEmit && yarn lint`
- [x] Stop for Phase 11–12.
