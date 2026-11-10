# Phase 1 — Plan: Pure Domain Architecture & Module Topology

## 1. Architectural Intent
Phase 1 builds the pure TypeScript financial domain under `/src/core/` with zero coupling to React Native, SQLite, or Supabase. Every formula, invariant check, HLC comparator, and deterministic UUIDv5 generator is implemented as a pure function and verified via Jest unit tests under `/tests/`.

## 2. Target File Layout

```text
/
├── specs/
│   └── 01-accounting-core/
│       ├── spec.md                # Requirements & accounting invariants
│       ├── plan.md                # Module topology & interfaces (this file)
│       └── tasks.md               # Atomic execution & test checklist
├── src/
│   └── core/
│       ├── accounting.ts          # Cent arithmetic, pointers, balances, invoices, installments, net worth, budgets (DEC-01), contributions (DEC-02)
│       ├── hlc.ts                 # 42-char Hybrid Logical Clock, offset calibration, field-level LWW merge + Tombstone Precedence
│       ├── recurring.ts           # Pure RFC 4122 SHA-1 UUIDv5 generator & deterministic recurring/invoice materialization
│       ├── validators.ts          # Zod schemas enforcing domain & pointer invariants
│       └── index.ts               # Barrel export for clean imports (`@/core`)
└── tests/
    ├── smoke.test.ts              # Phase 0 smoke test (kept intact)
    ├── accounting.test.ts         # TEST-FIN-01 .. TEST-FIN-05 + edge cases
    ├── recurring.test.ts          # TEST-FIN-06 + UUIDv5 RFC 4122 vectors
    ├── hlc.test.ts                # HLC monotonicity, clock drift, LWW & tombstone merge
    └── validators.test.ts         # Zod schema & chk_accounting_invariants validation
```

## 3. Module Contracts

### 3.1 `src/core/accounting.ts`
- **Types**:
  - `TransactionType`: `'INCOME' | 'EXPENSE' | 'TRANSFER' | 'CREDIT_PURCHASE' | 'CREDIT_REFUND' | 'DEBIT_REFUND' | 'INVOICE_PAYMENT'`
  - `TransactionStatus`: `'PENDING' | 'CLEARED'`
  - `InvoiceStatus`: `'OPEN' | 'CLOSED' | 'PAID'`
  - `AccountType`: `'CHECKING' | 'SAVINGS' | 'WALLET' | 'INVESTMENT'`
  - `OwnershipFilter`: `{ mode: 'CONSOLIDATED' } | { mode: 'DOMESTIC' } | { mode: 'USER'; userId: string }`
  - `LedgerAccount`, `LedgerCreditCard`, `LedgerInvoice`, `LedgerTransaction`, `InstallmentSlice`, `HouseholdContributionSummary`
- **Functions**:
  - `assertValidCents(value: number, fieldName?: string): void`
  - `assertTransactionInvariants(tx: Pick<LedgerTransaction, 'type' | 'amountCents' | 'accountId' | 'transferAccountId' | 'creditCardId' | 'invoiceId' | 'categoryId'>): void`
  - `addMonthsToCompetence(competenceMonth: string, monthsToAdd: number): string`
  - `resolveInvoiceCompetenceMonth(purchaseDateIso: string, closingDay: number): string`
  - `splitInstallments(totalAmountCents: number, totalInstallments: number, firstCompetenceMonth: string): InstallmentSlice[]`
  - `recalculateInstallmentPlanTotalCents(installmentPlanId: string, transactions: readonly LedgerTransaction[]): number`
  - `applyInstallmentScopeBEdit(installmentPlanId: string, fromInstallmentNumber: number, changes: Partial<Pick<LedgerTransaction, 'amountCents' | 'categoryId' | 'description' | 'ownerUserId'>>, transactions: readonly LedgerTransaction[], invoices: readonly LedgerInvoice[]): { updatedTransactions: LedgerTransaction[]; newTotalAmountCents: number }`
  - `canHardCancelInstallmentPlan(installmentPlanId: string, transactions: readonly LedgerTransaction[], invoices: readonly LedgerInvoice[]): boolean`
  - `calculateAccountBalanceCents(accountId: string, initialBalanceCents: number, transactions: readonly LedgerTransaction[]): number`
  - `calculateInvoiceDebtCents(invoiceId: string, transactions: readonly LedgerTransaction[]): number`
  - `calculateCreditCardAvailableLimitCents(creditCard: Pick<LedgerCreditCard, 'id' | 'limitCents'>, invoices: readonly LedgerInvoice[], transactions: readonly LedgerTransaction[]): number`
  - `calculateBudgetConsumedCents(categoryId: string, competenceMonth: string, transactions: readonly LedgerTransaction[], options?: { ownerFilter?: OwnershipFilter; onlyPaidInvoices?: boolean; invoices?: readonly LedgerInvoice[] }): number`
  - `calculateMonthlyCashSummaryCents(competenceMonth: string, transactions: readonly LedgerTransaction[], ownerFilter?: OwnershipFilter): { incomeCents: number; expenseCents: number; netCents: number }`
  - `calculateNetWorthCents(accounts: readonly LedgerAccount[], invoices: readonly LedgerInvoice[], transactions: readonly LedgerTransaction[]): number`
  - `calculateHouseholdContributions(competenceMonth: string, memberUserIds: readonly [string, string], accounts: readonly LedgerAccount[], creditCards: readonly LedgerCreditCard[], transactions: readonly LedgerTransaction[]): HouseholdContributionSummary`

### 3.2 `src/core/hlc.ts`
- **Types**:
  - `HlcState`: `{ lastWallMs: number; counter: number; nodeId: string }`
  - `FieldHlcMap`: `Record<string, string>`
- **Functions**:
  - `packHlc(wallMs: number, counter: number, nodeId: string): string`
  - `unpackHlc(hlc: string): HlcState`
  - `isValidHlc(hlc: string): boolean`
  - `compareHlc(a: string, b: string): -1 | 0 | 1`
  - `computeServerTimeOffsetMs(serverNowMs: number, localNowMs: number): number`
  - `computeCorrectedNowMs(localNowMs: number, serverTimeOffsetMs: number): number`
  - `nextLocalHlc(state: HlcState, correctedNowMs: number): { hlc: string; nextState: HlcState }`
  - `receiveRemoteHlc(state: HlcState, remoteHlc: string, correctedNowMs: number): HlcState`
  - `mergeRecordLww<T extends Record<string, unknown> & { hlcTimestamp: string; fieldHlc: FieldHlcMap; deletedAt: string | null }>(existing: T, incoming: T, mutableFields: readonly (keyof T & string)[]): T`

### 3.3 `src/core/recurring.ts`
- **Constants**:
  - `NAMESPACE_RECURRING = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'` (or project-specific fixed RFC 4122 UUID namespace)
  - `NAMESPACE_INVOICE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'`
- **Functions**:
  - `uuidv5(namespaceUuid: string, name: string): string` (pure TypeScript SHA-1 RFC 4122 §4.3 implementation — zero native dependencies)
  - `generateRecurringTransactionId(recurringRuleId: string, competenceMonth: string): string`
  - `generateInvoiceId(creditCardId: string, competenceMonth: string): string`
  - `materializeRecurringTransaction(rule: RecurringRuleDefinition, competenceMonth: string, options?: { invoiceId?: string | null; hlcTimestamp?: string }): LedgerTransaction`

### 3.4 `src/core/validators.ts`
- **Dependency**: `zod` (installed via `yarn add zod`)
- **Schemas**:
  - `CompetenceMonthSchema`, `IsoDateSchema`, `CentsPositiveSchema`, `CentsNonNegativeSchema`, `UuidSchema`, `HlcStringSchema`
  - `TransactionInputSchema` (enforcing `chk_accounting_invariants` via `.superRefine`)
  - `AccountInputSchema`, `CategoryInputSchema`, `CreditCardInputSchema`, `CreditCardInvoiceInputSchema`, `InstallmentPlanInputSchema`, `RecurringRuleInputSchema`, `BudgetInputSchema`

## 4. Database / Sync Impact
- **Direct DB changes in Phase 1**: None (Phase 2 creates Drizzle schemas).
- **Contract alignment**: All field names, enum literals, and pointer invariants in `/src/core` match the PostgreSQL/SQLite DDL in `AGENTS.md` §4 so Phase 2 repositories and Phase 4 sync engine consume them directly without adapters.

## 5. Exit Criteria
All tasks in `specs/01-accounting-core/tasks.md` are checked off and `yarn tsc --noEmit`, `yarn test`, and `yarn lint` exit 0.
