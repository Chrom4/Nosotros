# Phase 6 — Accounts, Categories & Base Ledger UI

## 1. Purpose
Ship offline-first UI for accounts/wallets, hierarchical categories, and quick capture of `INCOME`, `EXPENSE`, `DEBIT_REFUND`, and `TRANSFER` (with `is_household_contribution` + ownership selector), reflecting instantly via `useLiveQuery`.

## 2. Scope
- Tabs/screens for accounts & categories.
- Quick-add modal for base transaction kinds (not credit-card kinds yet).
- Owner filters prepare for dashboard contexts.
- Performance: live update perceived within **< 16ms** local path.

### Out of scope
- Credit cards/invoices/installments (Phase 7), recurring (Phase 8).

## 3. Hard Requirements
- All writes go through transactional repositories (domain + outbox).
- Soft delete only.
- Respect pointer invariants from `/src/core`.
- DEC-02: shared expense paid from individual account contributes to household contribution semantics.

## 4. Acceptance Gates
- Offline create visible immediately on device A; syncs to device B on reconnect.
- Invalid pointer combos rejected before/at persistence.

