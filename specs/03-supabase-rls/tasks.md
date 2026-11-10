# Phase 3 — Tasks

## T3.1 — SQL migrations
- [x] Author full PostgreSQL schema (12 tables) + `global_sync_seq`.
- [x] Add member-limit trigger (max 2 active).
- [x] Add RLS helper `get_my_active_household_ids()` + policies.
- [x] Add invite generate/accept/revoke RPCs.
- [x] Add owner-only permission `BEFORE UPDATE` trigger.

## T3.2 — Apply & verify
- [x] Apply migrations to the project Supabase instance (`supabase db push` or SQL editor / automated PostgreSQL PGlite harness).
- [x] Run EXPLAIN on a representative policy query; confirm InitPlan.
- [x] Execute TEST-SEC-01 checklist (isolation, HOUSEHOLD_FULL, revoked FORBIDDEN).

## T3.3 — Keep-alive
- [x] Add GitHub Action cron every 5 days: `SELECT 1` (or health RPC) against Supabase.
- [x] Store secrets in GitHub Actions secrets (never commit keys).

## T3.4 — Gates
- [x] Document TEST-SEC-01 results under `tests/security/`.
- [x] Stop for Phase 4.
