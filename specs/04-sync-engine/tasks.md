# Phase 4 — Tasks

## T4.1 — Server RPCs
- [ ] Implement `sync_push_batch` (HLC merge, soft-delete precedence, idempotency).
- [ ] Implement `sync_pull_changes(last_server_seq)` paginated.
- [ ] Create `processed_mutations` table.

## T4.2 — Client engine
- [ ] Implement outbox coalesce + FK topological order.
- [ ] Implement push batches (max 100) and pull pages (500).
- [ ] Wire NetInfo: suspend retries when offline.
- [ ] Handle crash: IN_FLIGHT → PENDING; downlink in single SQLite transaction with cursor.

## T4.3 — Tests & gates
- [ ] Automate TEST-SYNC-A..GH under `/tests/sync`.
- [ ] `yarn test -- tests/sync`
- [ ] `yarn tsc --noEmit && yarn lint`
- [ ] Stop for Phase 5.

