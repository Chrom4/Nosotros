# Phase 1 — Tasks (Atomic Checklist)

> Execute tasks in order. Tick each box only after implementation and automated tests pass (`yarn test`).
> Package manager: **Yarn**.

## T1.1 — Preconditions & Dependencies

- [x] Confirm Phase 1 SDD artifacts exist in `specs/01-accounting-core/` (`spec.md`, `plan.md`, `tasks.md`).
- [x] Install `zod` for runtime input validation in `src/core/validators.ts`:
  ```bash
  yarn add zod
  ```

## T1.2 — Hybrid Logical Clock (`src/core/hlc.ts`)

- [x] Implement canonical 42-char HLC (`packHlc`, `unpackHlc`, `isValidHlc`, `compareHlc`).
- [x] Implement server offset calibration (`computeServerTimeOffsetMs`, `computeCorrectedNowMs`).
- [x] Implement monotonic local tick (`nextLocalHlc`) and remote sync merge (`receiveRemoteHlc`) with 16-bit counter overflow protection (`0xffff`).
- [x] Implement Field-Level LWW record merger (`mergeRecordLww`) with Tombstone Precedence (`deletedAt`).

## T1.3 — Deterministic Recurring & Invoice UUIDv5 (`src/core/recurring.ts`)

- [x] Implement pure RFC 4122 SHA-1 `uuidv5(namespace, name)` with zero native dependencies.
- [x] Define `NAMESPACE_RECURRING` and `NAMESPACE_INVOICE` and implement `generateRecurringTransactionId(ruleId, competenceMonth)` and `generateInvoiceId(creditCardId, competenceMonth)`.
- [x] Implement `materializeRecurringTransaction` and `applyRecurringRuleUpdateToOccurrences` (preserving `CLEARED` and past occurrences).

## T1.4 — Pure Accounting Engine (`src/core/accounting.ts`)

- [x] Implement integer cents assertions (`assertValidCents`, `assertNonNegativeCents`) and pointer invariant verifier (`assertTransactionInvariants`).
- [x] Implement competence arithmetic (`addMonthsToCompetence`, `resolveInvoiceCompetenceMonth`, `computeInvoiceCycleDates`).
- [x] Implement installment engine (`splitInstallments` with `total % N` on 1st slice, `recalculateInstallmentPlanTotalCents`, `applyInstallmentScopeBEdit`, `canHardCancelInstallmentPlan`).
- [x] Implement account & credit card calculators (`calculateAccountBalanceCents`, `calculateInvoiceDebtCents`, `calculateCreditCardAvailableLimitCents`).
- [x] Implement budget & monthly cashflow calculators (`calculateBudgetConsumedCents` honoring DEC-01 and contra-expense refunds, `calculateMonthlySummaryCents`).
- [x] Implement Net Worth (`calculateNetWorthCents`) and Couple Household Contributions (`calculateHouseholdContributions` honoring DEC-02).

## T1.5 — Zod Validators (`src/core/validators.ts`) & Barrel (`src/core/index.ts`)

- [x] Implement Zod schemas for all domain entities and `TransactionInputSchema` with `chk_accounting_invariants` `.superRefine` check.
- [x] Export all core types, functions, and schemas from `src/core/index.ts`.

## T1.6 — Automated Test Suite (`/tests`)

- [x] Create `tests/accounting.test.ts` covering `TEST-FIN-01`, `TEST-FIN-02`, `TEST-FIN-03` (including DEC-02), `TEST-FIN-04` (including DEC-01), `TEST-FIN-05`, and installment Scope A/B rules.
- [x] Create `tests/recurring.test.ts` covering `TEST-FIN-06` and RFC 4122 UUIDv5 determinism.
- [x] Create `tests/hlc.test.ts` covering HLC format, monotonicity, clock drift, counter overflow, and Field-level LWW + Tombstone Precedence.
- [x] Create `tests/validators.test.ts` covering Zod validation and pointer invariant rejections.

## T1.7 — Definition of Done Gates

- [x] Typecheck passes: `yarn tsc --noEmit`
- [x] All unit tests pass: `yarn test`
- [x] Linter passes: `yarn lint`
- [x] Zero forbidden dependencies or React/DB imports in `src/core/*`.
