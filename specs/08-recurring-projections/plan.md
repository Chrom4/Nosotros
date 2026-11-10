# Phase 8 — Plan

```text
src/app/(tabs)/recurring.tsx
src/data/repositories/recurring.ts
src/core/recurring.ts          # already from Phase 1 — reuse
tests/recurring/materialize.test.ts
```

## DB Impact
Uses `recurring_rules` + `transactions` status fields. No PowerSync / no materialized SQLite views.

## Exit Criteria
TEST-FIN-06 style persistence+sync check green.

