# Phase 9 — Plan

```text
src/app/(tabs)/index.tsx          # dashboard
src/components/ContextPills.tsx
src/components/BudgetBar.tsx
src/components/NetWorthChart.tsx  # react-native-svg
src/store/filters.ts
```

## DB Impact
Read-mostly; ensure indexes from Phase 2 cover dashboard queries. May add budget repository helpers.

## Exit Criteria
Perf note for aggregates + visual QA of four contexts.

