# Phase 4 — Plan: Sync Topology

```text
supabase/migrations/00xx_sync_rpcs.sql
src/sync/syncEngine.ts
src/sync/outboxCoalesce.ts
src/sync/topoSort.ts
tests/sync/test-sync-*.test.ts
```

## DB Impact
Adds/locks RPC contracts and `processed_mutations`. Client cursor: `last_server_seq`, `sync_epoch`.

## Exit Criteria
Concurrency suite 100% green.

