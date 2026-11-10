# Phase 3 — Plan: `/supabase`

## 1. Topology
```text
supabase/migrations/
  0001_init_schema.sql
  0002_rls_policies.sql
  0003_invite_rpcs.sql
.github/workflows/supabase-keepalive.yml
tests/security/test-sec-01.md  # or automated script if CI credentials exist
```

## 2. DB Impact
Remote schema becomes source of truth for sync. Must mirror local domain + add `processed_mutations`, `global_sync_seq`, household pairing tables.

## 3. Exit Criteria
Migrations applied; TEST-SEC-01 evidence recorded; keep-alive scheduled.

