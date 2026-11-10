# Phase 1 — Pure Accounting Core & Hybrid Logical Clock (`/src/core`)

## 1. Purpose
Implement the 100% pure, deterministic financial domain and Hybrid Logical Clock (HLC) foundation under `/src/core`. This layer has **zero dependencies** on React, React Native, SQLite/Drizzle, or network clients, enabling sub-second execution in Jest and guaranteeing mathematical and accounting integrity before local persistence (Phase 2) and offline-first sync (Phase 4) are built.

## 2. Scope

### In scope
- **`/src/core/accounting.ts`**:
  - Safe integer cents validation (`assertValidCents`, `assertSafeCents`).
  - Transaction pointer invariants enforcement (`validateTransactionPointers` / `assertTransactionInvariants`).
  - Installment splitting with integer division remainder allocated to the 1st installment (`splitInstallments`), plus installment recalculation and Scope A / Scope B edit helpers (`recalculateInstallmentPlanTotalCents`, `applyInstallmentScopeBEdit`, `canDeleteInstallmentPlan`).
  - Invoice competence resolution (`resolveInvoiceCompetenceMonth`, `addMonthsToCompetence`, `computeInvoiceDates`).
  - Bank account balance reconstruction (`calculateAccountBalanceCents`).
  - Credit card invoice debt and available limit calculation (`calculateInvoiceDebtCents`, `calculateCreditCardAvailableLimitCents`).
  - Monthly income, expense, and category budget net consumption (`calculateBudgetConsumedCents`, `calculateMonthlySummaryCents`) honoring contra-expense refunds (`DEBIT_REFUND`, `CREDIT_REFUND`) and **DEC-01**.
  - Consolidated Net Worth (`calculateNetWorthCents`) and Ownership Context filtering (`filterByOwnershipContext`).
  - Couple Household Contributions (`calculateHouseholdContributions`) honoring **DEC-02** (both explicit transfers with `isHouseholdContribution = true` and shared expenses `ownerUserId = null` paid via an individual account or individual credit card).
- **`/src/core/hlc.ts`**:
  - Canonical 42-character Hybrid Logical Clock (`<ISO-8601 UTC 24 chars>-<counter hex 4 chars>-<node_id 12 hex chars>`).
  - `packHlc`, `unpackHlc`, `isValidHlc`, `compareHlc`.
  - Monotonic local advancement (`nextLocalHlc`) and remote reception (`receiveRemoteHlc`).
  - Clock-drift offset calculation (`computeServerTimeOffsetMs`, `computeCorrectedNowMs`).
  - Field-level Last-Write-Wins (LWW) dictionary merge (`mergeFieldHlc`) with Tombstone Precedence (`deletedAt`).
- **`/src/core/recurring.ts`**:
  - RFC 4122 deterministic `UUIDv5` (SHA-1 namespace hashing) in pure TypeScript (`uuidv5`, `NAMESPACE_RECURRING`, `NAMESPACE_INVOICE`).
  - Deterministic IDs for recurring occurrences (`generateRecurringTransactionId(ruleId, competenceMonth)`) and credit card invoices (`generateInvoiceId(creditCardId, competenceMonth)`).
  - Deterministic recurring rule materialization (`materializeRecurringTransaction`) and scope guard ensuring rule edits only affect `PENDING` or future occurrences.
- **`/src/core/validators.ts`**:
  - Strict Zod schemas for domain inputs (`TransactionInputSchema`, `AccountInputSchema`, `CategoryInputSchema`, `CreditCardInputSchema`, `CreditCardInvoiceInputSchema`, `InstallmentPlanInputSchema`, `RecurringRuleInputSchema`, `BudgetInputSchema`).
- **Automated unit tests under `/tests`**:
  - Complete coverage of `TEST-FIN-01` through `TEST-FIN-06`, HLC monotonicity, and Zod validator invariants.

### Out of scope
- SQLite / SQLCipher / Drizzle tables and migrations (Phase 2).
- Supabase RLS, PostgreSQL triggers, and RPCs (Phase 3–4).
- UI screens, React hooks, or Zustand stores (Phases 5–9).

## 3. Accounting & Synchronisation Invariants (`AGENTS.md` §4)

### INV-1.1 — Monetary Values in Integer Cents
All monetary transaction amounts (`amountCents`), credit limits (`limitCents`), and budget limits (`limitCents`) must be safe positive integers (`Number.isSafeInteger(v) && v > 0`), except `initialBalanceCents` on accounts (which may be `>= 0` or any safe integer) and `limitCents` on credit cards (`>= 0`). Floating-point values (`float`/`double`) are strictly forbidden.

### INV-1.2 — Transaction Pointer Invariants (`chk_accounting_invariants`)
Every `LedgerTransaction` must satisfy one of four mutually exclusive pointer configurations:
1. **`INCOME` | `EXPENSE` | `DEBIT_REFUND`**:
   - `accountId !== null`
   - `transferAccountId === null`
   - `creditCardId === null`
   - `invoiceId === null`
   - `categoryId !== null`
2. **`TRANSFER`**:
   - `accountId !== null`
   - `transferAccountId !== null` and `transferAccountId !== accountId`
   - `creditCardId === null`
   - `invoiceId === null`
   - `categoryId === null`
3. **`CREDIT_PURCHASE` | `CREDIT_REFUND`**:
   - `accountId === null`
   - `transferAccountId === null`
   - `creditCardId !== null`
   - `invoiceId !== null`
   - `categoryId !== null`
4. **`INVOICE_PAYMENT`**:
   - `accountId !== null`
   - `transferAccountId === null`
   - `creditCardId !== null`
   - `invoiceId !== null`
   - `categoryId === null`

### INV-1.3 — Installments (`installment_plans`)
- No non-computable parent transaction may exist in `transactions`; the header lives in `installment_plans`.
- Given `totalAmountCents > 0` and `totalInstallments` ($N \in [2, 240]$):
  $$\text{baseAmount} = \lfloor \text{totalAmountCents} \div N \rfloor, \quad \text{remainder} = \text{totalAmountCents} \bmod N$$
  - Slice $k = 1$: `baseAmount + remainder`
  - Slice $k \in [2, N]$: `baseAmount`
  - Exact sum invariant: $\sum_{k=1}^{N} \text{slice}_k.\text{amountCents} = \text{totalAmountCents}$.
- Scope A edit updates a single installment and recalculates `installment_plans.totalAmountCents` as the exact sum of active (`deletedAt === null`) slices.
- Scope B edit updates installments where `installmentNumber >= currentInstallment` AND the linked invoice has `status === 'OPEN'`. Installments in `CLOSED` or `PAID` invoices are immutable.

### INV-1.4 — Invoice Cutoff (`closing_day`) & Historical Immutability
- For a purchase on `YYYY-MM-DD` and a card with `closingDay` ($1 \dots 31$):
  - If `day < closingDay`: invoice competence is `YYYY-MM`.
  - If `day >= closingDay`: invoice competence is `addMonthsToCompetence('YYYY-MM', 1)`.
- Once an invoice record is materialized with its `closingDate`, `dueDate`, and `id`, future edits to `creditCard.closingDay` must never mutate historical invoices or reassign existing transactions.

### INV-1.5 — Refunds & DEC-01 (Budget Regime)
- `DEBIT_REFUND` and `CREDIT_REFUND` are contra-expenses: they subtract from category consumption and monthly expenses, and **never** add to `INCOME`.
- **DEC-01**: Credit card purchases (`CREDIT_PURCHASE`) and credit refunds (`CREDIT_REFUND`) carry the `competenceMonth` of the invoice in which they are billed/paid (and when invoice payment filtering is active, only count on invoice settlement). `INVOICE_PAYMENT` settles the liability without double-counting as a new expense.

### INV-1.6 — Net Worth & DEC-02 (Couple Household Contributions)
- **Net Worth**:
  $$\text{NetWorth} = \sum_{\substack{a \in \text{Accounts} \\ a.\text{includeInNetWorth} \\ a.\text{deletedAt} = \text{null}}} \text{Balance}(a) - \sum_{\substack{i \in \text{Invoices} \\ i.\text{status} \in \{\text{OPEN}, \text{CLOSED}\} \\ i.\text{deletedAt} = \text{null}}} \max(0, \text{InvoiceDebt}(i))$$
- **DEC-02 (Contributions)**: A partner $U$'s contribution to the household in month $M$ equals:
  1. `TRANSFER` transactions (`status === 'CLEARED'`, `deletedAt === null`, `competenceMonth === M`, `isHouseholdContribution === true`) from an individual account owned by $U$ (`account.ownerUserId === U`) to a shared account (`transferAccount.ownerUserId === null`).
  2. Plus shared expenses (`ownerUserId === null`, `deletedAt === null`, `competenceMonth === M`) of type `EXPENSE` (`status === 'CLEARED'`) or `CREDIT_PURCHASE` paid via an individual account (`account.ownerUserId === U`) or individual credit card (`creditCard.ownerUserId === U`), net of any shared refunds (`DEBIT_REFUND` / `CREDIT_REFUND`, `ownerUserId === null`) on $U$'s individual instruments.

### INV-1.7 — Deterministic Recurring IDs (`UUIDv5`)
- Recurring rule occurrences use deterministic RFC 4122 `UUIDv5`:
  $$\text{id} = \text{UUIDv5}(\text{NAMESPACE\_RECURRING}, \text{recurringRuleId} \mathbin{\Vert} \text{":"} \mathbin{\Vert} \text{competenceMonth})$$
- Both partners' offline devices materializing the same rule for the same month always generate the exact same `id`.

### INV-1.8 — Canonical HLC (42 Characters)
- Format: `YYYY-MM-DDTHH:mm:ss.sssZ-XXXX-NNNNNNNNNNNN` (24-char ISO UTC + `-` + 4 lowercase hex counter `0000..ffff` + `-` + 12 lowercase hex `nodeId` = 42 chars).
- Strictly monotonic per node: `nextLocalHlc(state, correctedNowMs)` always produces `hlc > packHlc(state.lastWallMs, state.counter, state.nodeId)`.
- `receiveRemoteHlc(state, remoteHlc, correctedNowMs)` advances `lastWallMs` to $\max(\text{correctedNowMs}, \text{state.lastWallMs}, \text{remote.lastWallMs})$ and increments the logical counter on ties.
- Tombstone Precedence: once `deletedAt !== null`, field-level merges keep the tombstone active.

## 4. Non-Functional Requirements / Gates (DoD)

| Gate ID | Criterion |
|---|---|
| GATE-1.1 | `TEST-FIN-01` through `TEST-FIN-06` and HLC monotonicity tests pass (`yarn test`) |
| GATE-1.2 | `yarn tsc --noEmit` exits 0 with `strict: true` |
| GATE-1.3 | `yarn lint` exits 0 |
| GATE-1.4 | `/src/core/*` has zero imports from `react`, `react-native`, `expo-*`, `drizzle-orm`, or `/src/data` |
| GATE-1.5 | Combined `yarn tsc --noEmit && yarn test` runs in **< 5 seconds** |
