# Phase 4 — Offline-First Sync Engine (`/src/sync`)

## 1. Purpose
Implement bidirectional sync using **only** Supabase RPCs `sync_push_batch` and `sync_pull_changes`, driven by local `sync_outbox`, HLC/`field_hlc`, coalescing, topological ordering, idempotency, and NetInfo-aware retry.

## 2. Scope
- PostgreSQL RPC bodies for push/pull + `processed_mutations`.
- `/src/sync/syncEngine.ts` (+ helpers): coalesce, batch ≤100, pull pages 500, `EPOCH_MISMATCH` handling, PENDING/IN_FLIGHT outbox states.
- Concurrency suite `TEST-SYNC-A` … `TEST-SYNC-GH`.

### Out of scope
- Feature UI; Google backup (Phase 10).

## 3. Hard Requirements
- Soft delete + **Tombstone Precedence**.
- Field-level merge via HLC (not device wall-clock LWW alone; not last-upload-wins).
- Composite mutations share `batch_id` / `mutation_id`; push is transactional on server.
- Re-send is idempotent (`processed_mutations`).
- No `@powersync/*`.

## 4. Acceptance Gates
All of TEST-SYNC-A, B, C, D, EF, GH pass in automated harness simulating two SQLite clients.

