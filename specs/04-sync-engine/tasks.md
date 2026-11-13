# Phase 4 — Tasks

## T4.1 — Server RPCs
- [x] Implement `sync_push_batch` (HLC merge, soft-delete precedence, idempotency).
- [x] Implement `sync_pull_changes(last_server_seq)` paginated.
- [x] Create `processed_mutations` table. _(also present in `0001`; RPC bodies in `0004_sync_rpcs.sql`)_

## T4.2 — Client engine
- [x] Implement outbox coalesce + FK topological order.
- [x] Implement push batches (max 100) and pull pages (500).
- [x] Wire NetInfo: suspend retries when offline.
- [x] Handle crash: IN_FLIGHT → PENDING; downlink in single SQLite transaction with cursor.

## T4.3 — Tests & gates
- [x] Automate TEST-SYNC-A..GH under `/tests/sync`.
- [x] `yarn test -- tests/sync`
- [x] `yarn tsc --noEmit && yarn lint`
- [x] Stop for Phase 5.
