# Phase 2 — Tasks

## T2.1 — Packages
- [x] `yarn add expo-sqlite expo-secure-store expo-crypto drizzle-orm`
- [x] `yarn add -D drizzle-kit better-sqlite3 @types/better-sqlite3`

## T2.2 — Config
- [x] Add `drizzle.config.ts` targeting SQLite migrations under `src/data/migrations`.
- [x] Enable SQLCipher usage in DB bootstrap (`useSQLCipher: true`) per Expo docs for the chosen SDK.
- [x] Implement `/src/data/db.ts` key generation + SecureStore load/create.

## T2.3 — Schema & migrations
- [x] Author `domain.ts` + `sync.ts` with CHECKs matching AGENTS.md pointer rules.
- [x] Generate/apply SQL migrations; commit migration files.
- [x] Declare secondary indexes required for month aggregates and owner filters.

## T2.4 — Repositories
- [x] Implement transactional repositories (domain + `sync_outbox` in one transaction).
- [x] Soft-delete helpers only (set `deleted_at` + outbox enqueue).

## T2.5 — Gates
- [x] Add `tests/data/*` covering TEST-DB-01 and atomic outbox writes.
- [x] `yarn test -- tests/data`
- [x] `yarn tsc --noEmit && yarn lint`
- [x] Stop for Phase 3.
