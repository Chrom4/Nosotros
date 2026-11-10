# Phase 7 — Credit Cards, Invoices & Installments

## 1. Purpose
Manage credit cards, `credit_card_invoices` (`OPEN`/`CLOSED`/`PAID`), one-shot and installment purchases via `installment_plans`, `CREDIT_REFUND`, and `INVOICE_PAYMENT` without double-counting expenses in monthly summaries (TEST-FIN-02/05).

## 2. Scope
- Card & invoice screens.
- Installment creation using core `splitInstallments` (remainder on 1st installment).
- Edit scopes A/B for installment changes (per audit financial model).
- Partial/full invoice payment flows.

### Out of scope
- Recurring rules UI (Phase 8), dashboard charts (Phase 9).

## 3. Hard Requirements
- `CREDIT_PURCHASE`/`CREDIT_REFUND` never touch bank balance directly.
- `INVOICE_PAYMENT` reduces bank + invoice debt and is not categorized as a new expense.
- Closing-day allocation immutable for historical invoices (TEST-FIN-05).
- Composite installment writes share one outbox `batch_id`.

## 4. Acceptance Gates
- Installment + payment scenarios match core tests when persisted.
- No duplicate expense on payment month summary.

