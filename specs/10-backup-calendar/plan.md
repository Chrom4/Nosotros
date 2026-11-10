# Phase 10 — Plan

```text
src/sync/backupCrypto.ts
src/sync/googleDriveClient.ts
src/sync/googleCalendarClient.ts
src/app/(tabs)/settings/backup.tsx
tests/backup/test-bkp-01.test.ts
```

## DB Impact
Restore bumps `sync_epoch` and rebuilds local DB from plaintext snapshot after decrypt; then sync reconciles.

## Exit Criteria
TEST-BKP-01 + documented disaster drill.

