# Phase 8 — Recurring Rules & Monthly Projections

## 1. Purpose
Allow `recurring_rules` CRUD and **deterministic** materialization of `PENDING` occurrences when opening a month (UUIDv5), with one-tap confirm `PENDING → CLEARED`, converging across two offline devices without duplicates (TEST-FIN-06).

## 2. Scope
- Recurring rules screens.
- Month-open materialization job (local).
- Confirmation UX.
- Sync convergence verification.

### Out of scope
- Dashboard net-worth charts (Phase 9); Google Calendar push (Phase 10 may subscribe later).

## 3. Hard Requirements
- Occurrence id = `UUIDv5(NAMESPACE, rule_id + ":" + competence_month)`.
- Materialization must be idempotent locally and after sync.
- Soft delete rules stop future materialization without erasing history.

## 4. Acceptance Gates
- Dual-offline materialization → single remote row after sync.

