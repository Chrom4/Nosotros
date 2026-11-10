# Phase 3 — Backend Supabase, RLS, Pairing & Keep-Alive

## 1. Purpose
Provision the **remote authority**: PostgreSQL schema (≈12 tables), `global_sync_seq`, RLS via `get_my_active_household_ids()`, hard cap of **2 active members** per household, invite RPCs, and a GitHub Actions keep-alive ping every **5 days** (free-tier hibernation mitigation).

## 2. Scope
- `/supabase/migrations/*` — tables, sequences, triggers, RLS policies, invite RPCs.
- `TEST-SEC-01` against a Supabase project (local or hosted).
- Keep-alive workflow under `.github/workflows/`.

### Out of scope
- Mobile sync engine client (Phase 4), auth UI screens (Phase 5).

## 3. Hard Requirements (AGENTS.md §5)
- RLS policies must use `(SELECT public.get_my_active_household_ids())` (`SECURITY DEFINER STABLE`) for `initPlan` caching; prevent recursive RLS on `household_members`.
- Never expose `service_role` to the mobile client.
- `BEFORE UPDATE` trigger blocks permission changes by non-owners.
- Trigger rejects a 3rd active member (`HOUSEHOLD_FULL`).
- Soft delete / tombstone columns aligned with local schema.

## 4. Acceptance Gates
| Gate | Criterion |
|---|---|
| GATE-3.1 | `TEST-SEC-01`: external user reads 0 rows from household AB |
| GATE-3.2 | Inserting 3rd active member fails with `HOUSEHOLD_FULL` |
| GATE-3.3 | Revoked member gets `FORBIDDEN` on protected RPCs |
| GATE-3.4 | `EXPLAIN` shows InitPlan usage for RLS helper |
| GATE-3.5 | Keep-alive workflow present (cron ≤ 5 days) |

