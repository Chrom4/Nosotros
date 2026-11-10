# Phase 7 — Plan

```text
src/app/(tabs)/cards.tsx
src/app/(tabs)/invoices.tsx
src/components/InstallmentEditor.tsx
src/data/repositories/creditCards.ts
src/data/repositories/installments.ts
```

## DB Impact
Heavy use of `credit_cards`, `credit_card_invoices`, `installment_plans`, `transactions`. Ensure indexes for invoice month queries.

## Exit Criteria
Manual+automated checks for scopes A/B and payments pass.

