# Phase 2 — Plan: `/src/data`

## 1. Dependencies
- Phase 1 core types/helpers.
- Packages: `expo-sqlite`, `expo-secure-store`, `expo-crypto`, `drizzle-orm`, `drizzle-kit`; dev: `better-sqlite3` for Node tests.

## 2. Topology
```text
src/data/
  db.ts
  schema/domain.ts
  schema/sync.ts
  migrations/
  repositories/   # one transactional API per aggregate
drizzle.config.ts
tests/data/
  invariants.test.ts   # TEST-DB-01
  outbox-atomic.test.ts
```

## 3. DB Impact
**Full local schema freeze** for MVP — later phases must not require destructive rewrites. Include sync metadata columns (`deleted_at`, `field_hlc`, `server_seq` mirrors as needed) **now**.

## 4. Exit Criteria
Gates GATE-2.* green; repositories callable from tests without UI.

