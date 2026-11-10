# Phase 2 — Secure Local Persistence (expo-sqlite + SQLCipher + Drizzle)

## 1. Purpose
Introduce the **local primary store**: encrypted SQLite via `expo-sqlite` (`useSQLCipher: true`), Drizzle schema for **all domain + sync control tables**, migrations, and transactional repositories that write domain rows + `sync_outbox` atomically.

## 2. Scope

### In scope
- `/src/data/db.ts` — open DB with SQLCipher key from `expo-secure-store` / `expo-crypto`.
- `/src/data/schema/domain.ts` + `/src/data/schema/sync.ts` — full local schema (≈10 local tables) with **explicit secondary indexes**.
- Drizzle migrations under `/src/data/migrations/`.
- Repositories that: (a) mutate domain, (b) enqueue `sync_outbox` with HLC/`field_hlc`, (c) soft-delete only (`deleted_at`).
- `TEST-DB-01` (CHECK invariants) runnable in Node with `better-sqlite3` in-memory where practical.

### Out of scope
- Supabase SQL, RPCs, NetInfo sync worker UI, feature screens.

## 3. Hard Requirements
- SQLCipher key: 256-bit random via `expo-crypto`, stored in `expo-secure-store` (`local_sqlcipher_key_v1`).
- **No physical DELETE** on synced domain tables.
- Every write that will sync must be one SQLite transaction: domain upsert/soft-delete + outbox insert.
- Declare indexes explicitly (no reliance on accidental scans for 12-month aggregates).
- Forbidden: `@powersync/*`, materialized views in SQLite.

## 4. Acceptance Gates
| Gate | Criterion |
|---|---|
| GATE-2.1 | `TEST-DB-01` passes (illegal pointer combos rejected by CHECK) |
| GATE-2.2 | DB open + sample 12-month aggregate query **< 15ms** on target/dev harness |
| GATE-2.3 | Repository write atomically inserts outbox row with HLC metadata |
| GATE-2.4 | `yarn test`, `yarn tsc --noEmit`, `yarn lint` green |

## 5. Schema Expectations (minimum)
Domain tables sufficient for later phases: households/members refs as needed locally, accounts, categories, credit_cards, credit_card_invoices, installment_plans, recurring_rules, transactions, budgets (as required by audit §13.3/13.4), plus sync tables: `sync_outbox`, sync cursor/meta (`last_server_seq`, `sync_epoch`, etc.).

