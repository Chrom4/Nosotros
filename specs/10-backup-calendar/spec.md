# Phase 10 — Encrypted Google Drive Backup & Google Calendar

## 1. Purpose
Implement passphrase-derived backup encryption (**PBKDF2-HMAC-SHA256** 210k iters + **AES-256-GCM**), Google Drive `appDataFolder` client via **REST fetch** (no `googleapis`), 10-file rotation, restore with `sync_epoch` bump, and idempotent Calendar reminders via `extendedProperties.private`.

## 2. Scope
- `/src/sync/backupCrypto.ts`
- `/src/sync/googleDriveClient.ts`
- `/src/sync/googleCalendarClient.ts`
- Settings UX for passphrase + backup/restore.
- `TEST-BKP-01` + disaster-recovery drill (audit §8 / §13.8.5).

### Out of scope
- Receipt photo attachments (DEC-04 deferred to V2).

## 3. Hard Requirements
- Unique salt (16B) + IV (12B) per file; never reuse IV.
- Key derivation from couple passphrase — not only device SecureStore secret.
- Google auth via `@react-native-google-signin/google-signin` + REST v3.
- Forbidden: `googleapis` package.

## 4. Acceptance Gates
- TEST-BKP-01: encrypt/decrypt, tamper detect, IV uniqueness.
- Full disaster test between two devices succeeds.

