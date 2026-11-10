export type TransactionType =
  | 'INCOME'
  | 'EXPENSE'
  | 'TRANSFER'
  | 'CREDIT_PURCHASE'
  | 'CREDIT_REFUND'
  | 'DEBIT_REFUND'
  | 'INVOICE_PAYMENT';

export type TransactionStatus = 'PENDING' | 'CLEARED';

export type InvoiceStatus = 'OPEN' | 'CLOSED' | 'PAID';

export type AccountType = 'CHECKING' | 'SAVINGS' | 'WALLET' | 'INVESTMENT';

export type OwnershipFilter =
  | { mode: 'CONSOLIDATED' }
  | { mode: 'DOMESTIC' }
  | { mode: 'USER'; userId: string };

export interface LedgerAccount {
  id: string;
  ownerUserId: string | null; // null = Conta Conjunta / Doméstica
  initialBalanceCents: number;
  includeInNetWorth: boolean;
  deletedAt: string | null;
}

export interface LedgerCreditCard {
  id: string;
  ownerUserId: string | null; // null = Cartão Compartilhado da Casa
  limitCents: number;
  closingDay: number;
  dueDay: number;
  deletedAt: string | null;
}

export interface LedgerInvoice {
  id: string;
  creditCardId: string;
  competenceMonth: string; // YYYY-MM
  closingDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  status: InvoiceStatus;
  deletedAt: string | null;
}

export interface LedgerTransaction {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  amountCents: number; // Always positive safe integer > 0
  transactionDate: string; // YYYY-MM-DD
  competenceMonth: string; // YYYY-MM
  description?: string;
  accountId: string | null;
  transferAccountId: string | null;
  creditCardId: string | null;
  invoiceId: string | null;
  categoryId: string | null;
  ownerUserId: string | null; // null = Doméstico (Casa)
  installmentPlanId?: string | null;
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  recurringRuleId?: string | null;
  refundedTransactionId?: string | null;
  isHouseholdContribution: boolean;
  deletedAt: string | null;
}

export interface InstallmentSlice {
  installmentNumber: number;
  totalInstallments: number;
  amountCents: number;
  competenceMonth: string;
}

export interface MemberContributionBreakdown {
  userId: string;
  explicitTransferCents: number;
  directDomesticExpenseCents: number;
  totalContributionCents: number;
  shareRatio: number; // 0..1
  sharePercentage: number; // 0..100
}

export interface HouseholdContributionSummary {
  competenceMonth: string;
  totalContributionCents: number;
  members: [MemberContributionBreakdown, MemberContributionBreakdown];
}

const COMPETENCE_MONTH_REGEX = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ISO_DATE_REGEX = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Ensures the monetary value is a strictly positive safe integer in cents (`> 0`).
 */
export function assertValidCents(value: number, fieldName = 'amountCents'): void {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid monetary integer in cents for ${fieldName}: ${value}`);
  }
}

/**
 * Ensures the monetary value is a non-negative safe integer in cents (`>= 0`).
 */
export function assertNonNegativeCents(value: number, fieldName = 'amountCents'): void {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid non-negative integer in cents for ${fieldName}: ${value}`);
  }
}

/**
 * Ensures a string matches `YYYY-MM`.
 */
export function assertCompetenceMonth(
  competenceMonth: string,
  fieldName = 'competenceMonth',
): void {
  if (!COMPETENCE_MONTH_REGEX.test(competenceMonth)) {
    throw new Error(`Invalid ${fieldName} format (expected YYYY-MM): ${competenceMonth}`);
  }
}

/**
 * Ensures a string matches `YYYY-MM-DD` with a valid calendar day for the month.
 */
export function assertIsoDate(dateIso: string, fieldName = 'dateIso'): void {
  const match = ISO_DATE_REGEX.exec(dateIso);
  if (!match) {
    throw new Error(`Invalid ${fieldName} format (expected YYYY-MM-DD): ${dateIso}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maxDay = daysInMonth(year, month);
  if (day > maxDay) {
    throw new Error(`Invalid calendar day in ${fieldName}: ${dateIso}`);
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

/**
 * Validates the strict pointer invariants (`chk_accounting_invariants` in AGENTS.md §4.2).
 */
export function assertTransactionInvariants(
  tx: Pick<
    LedgerTransaction,
    | 'type'
    | 'amountCents'
    | 'accountId'
    | 'transferAccountId'
    | 'creditCardId'
    | 'invoiceId'
    | 'categoryId'
  >,
): void {
  assertValidCents(tx.amountCents, 'amountCents');

  switch (tx.type) {
    case 'INCOME':
    case 'EXPENSE':
    case 'DEBIT_REFUND': {
      if (
        tx.accountId === null ||
        tx.transferAccountId !== null ||
        tx.creditCardId !== null ||
        tx.invoiceId !== null ||
        tx.categoryId === null
      ) {
        throw new Error(
          `Constraint chk_accounting_invariants violated for ${tx.type}: requires accountId != null, transferAccountId == null, creditCardId == null, invoiceId == null, categoryId != null`,
        );
      }
      return;
    }

    case 'TRANSFER': {
      if (
        tx.accountId === null ||
        tx.transferAccountId === null ||
        tx.accountId === tx.transferAccountId ||
        tx.creditCardId !== null ||
        tx.invoiceId !== null ||
        tx.categoryId !== null
      ) {
        throw new Error(
          'Constraint chk_accounting_invariants violated for TRANSFER: requires accountId != null, transferAccountId != null (<> accountId), creditCardId == null, invoiceId == null, categoryId == null',
        );
      }
      return;
    }

    case 'CREDIT_PURCHASE':
    case 'CREDIT_REFUND': {
      if (
        tx.accountId !== null ||
        tx.transferAccountId !== null ||
        tx.creditCardId === null ||
        tx.invoiceId === null ||
        tx.categoryId === null
      ) {
        throw new Error(
          `Constraint chk_accounting_invariants violated for ${tx.type}: requires accountId == null, transferAccountId == null, creditCardId != null, invoiceId != null, categoryId != null`,
        );
      }
      return;
    }

    case 'INVOICE_PAYMENT': {
      if (
        tx.accountId === null ||
        tx.transferAccountId !== null ||
        tx.creditCardId === null ||
        tx.invoiceId === null ||
        tx.categoryId !== null
      ) {
        throw new Error(
          'Constraint chk_accounting_invariants violated for INVOICE_PAYMENT: requires accountId != null, transferAccountId == null, creditCardId != null, invoiceId != null, categoryId == null',
        );
      }
      return;
    }

    default: {
      const exhaustive: never = tx.type;
      throw new Error(`Unsupported transaction type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Adds months to a `YYYY-MM` competence string using pure integer arithmetic (no Date/timezone).
 */
export function addMonthsToCompetence(competenceMonth: string, monthsToAdd: number): string {
  assertCompetenceMonth(competenceMonth, 'competenceMonth');
  if (!Number.isInteger(monthsToAdd) || !Number.isSafeInteger(monthsToAdd)) {
    throw new Error(`Invalid monthsToAdd: ${monthsToAdd}`);
  }

  const [yearStr, monthStr] = competenceMonth.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1; // 0..11

  const totalMonths = year * 12 + monthIndex + monthsToAdd;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12 + 1;

  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}`;
}

/**
 * Determines the invoice competence month (`YYYY-MM`) based on purchase date and card closing day.
 * Standard banking rule:
 * - Purchases strictly before `closingDay` (`day < closingDay`) belong to the same month (`YYYY-MM`).
 * - Purchases on or after `closingDay` (`day >= closingDay`) belong to the next month (`YYYY-MM + 1`).
 */
export function resolveInvoiceCompetenceMonth(
  purchaseDateIso: string,
  closingDay: number,
): string {
  assertIsoDate(purchaseDateIso, 'purchaseDateIso');
  if (!Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31) {
    throw new Error(`Invalid closingDay: ${closingDay}`);
  }

  const yearMonth = purchaseDateIso.slice(0, 7);
  const day = Number(purchaseDateIso.slice(8, 10));

  return day < closingDay ? yearMonth : addMonthsToCompetence(yearMonth, 1);
}

/**
 * Computes the concrete `closingDate` and `dueDate` (`YYYY-MM-DD`) for an invoice competence month,
 * clamping the day to the last day of the month when necessary (e.g. Feb 28/29).
 * Once persisted on `credit_card_invoices`, these dates remain immutable even if `closingDay` changes later.
 */
export function computeInvoiceCycleDates(
  competenceMonth: string,
  closingDay: number,
  dueDay: number,
): { closingDate: string; dueDate: string } {
  assertCompetenceMonth(competenceMonth, 'competenceMonth');
  if (!Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31) {
    throw new Error(`Invalid closingDay: ${closingDay}`);
  }
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    throw new Error(`Invalid dueDay: ${dueDay}`);
  }

  const [yearStr, monthStr] = competenceMonth.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);

  const clampedDueDay = Math.min(dueDay, daysInMonth(year, month));
  const dueDate = `${competenceMonth}-${String(clampedDueDay).padStart(2, '0')}`;

  // If closingDay >= dueDay, the invoice closes in the calendar month prior to dueDate
  const closingCompetence =
    closingDay < dueDay ? competenceMonth : addMonthsToCompetence(competenceMonth, -1);
  const [cYearStr, cMonthStr] = closingCompetence.split('-');
  const clampedClosingDay = Math.min(
    closingDay,
    daysInMonth(Number(cYearStr), Number(cMonthStr)),
  );
  const closingDate = `${closingCompetence}-${String(clampedClosingDay).padStart(2, '0')}`;

  return { closingDate, dueDate };
}

/**
 * Splits a total amount in cents into N installments without losing 1 cent.
 * Deterministic rule: the integer division remainder (`total % N`) is allocated to the 1st installment.
 */
export function splitInstallments(
  totalAmountCents: number,
  totalInstallments: number,
  firstCompetenceMonth: string,
): InstallmentSlice[] {
  assertValidCents(totalAmountCents, 'totalAmountCents');
  assertCompetenceMonth(firstCompetenceMonth, 'firstCompetenceMonth');
  if (
    !Number.isInteger(totalInstallments) ||
    totalInstallments < 2 ||
    totalInstallments > 240
  ) {
    throw new Error(`Invalid totalInstallments: ${totalInstallments}`);
  }

  const baseAmount = Math.floor(totalAmountCents / totalInstallments);
  const remainder = totalAmountCents % totalInstallments;

  const slices: InstallmentSlice[] = [];
  for (let i = 0; i < totalInstallments; i++) {
    const amountCents = i === 0 ? baseAmount + remainder : baseAmount;
    assertValidCents(amountCents, `installment[${i + 1}].amountCents`);
    slices.push({
      installmentNumber: i + 1,
      totalInstallments,
      amountCents,
      competenceMonth: addMonthsToCompetence(firstCompetenceMonth, i),
    });
  }

  return slices;
}

/**
 * Recalculates `installment_plans.total_amount_cents` as the exact sum of active (`deletedAt === null`)
 * installment transactions linked to the plan (Scope A / Scope B rule).
 */
export function recalculateInstallmentPlanTotalCents(
  installmentPlanId: string,
  transactions: readonly LedgerTransaction[],
): number {
  let total = 0;
  for (const tx of transactions) {
    if (tx.deletedAt === null && tx.installmentPlanId === installmentPlanId) {
      total += tx.amountCents;
    }
  }
  return total;
}

/**
 * Applies a Scope B edit ("This and all following installments") to an installment plan:
 * updates only installments where `installmentNumber >= fromInstallmentNumber` AND whose
 * associated invoice is still `'OPEN'` (or not attached to a closed/paid invoice).
 * Installments in `'CLOSED'` or `'PAID'` invoices remain immutable.
 */
export function applyInstallmentScopeBEdit(
  installmentPlanId: string,
  fromInstallmentNumber: number,
  changes: Partial<
    Pick<LedgerTransaction, 'amountCents' | 'categoryId' | 'description' | 'ownerUserId'>
  >,
  transactions: readonly LedgerTransaction[],
  invoices: readonly LedgerInvoice[],
): { updatedTransactions: LedgerTransaction[]; newTotalAmountCents: number } {
  if (!Number.isInteger(fromInstallmentNumber) || fromInstallmentNumber < 1) {
    throw new Error(`Invalid fromInstallmentNumber: ${fromInstallmentNumber}`);
  }
  if (changes.amountCents !== undefined) {
    assertValidCents(changes.amountCents, 'changes.amountCents');
  }

  const invoiceStatusById = new Map<string, InvoiceStatus>();
  for (const inv of invoices) {
    if (inv.deletedAt === null) {
      invoiceStatusById.set(inv.id, inv.status);
    }
  }

  const updatedTransactions = transactions.map((tx) => {
    if (
      tx.deletedAt !== null ||
      tx.installmentPlanId !== installmentPlanId ||
      typeof tx.installmentNumber !== 'number' ||
      tx.installmentNumber < fromInstallmentNumber
    ) {
      return tx;
    }

    if (tx.invoiceId !== null) {
      const invStatus = invoiceStatusById.get(tx.invoiceId);
      if (invStatus === 'CLOSED' || invStatus === 'PAID') {
        return tx;
      }
    }

    return {
      ...tx,
      ...(changes.amountCents !== undefined ? { amountCents: changes.amountCents } : {}),
      ...(changes.categoryId !== undefined ? { categoryId: changes.categoryId } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      ...(changes.ownerUserId !== undefined ? { ownerUserId: changes.ownerUserId } : {}),
    };
  });

  const newTotalAmountCents = recalculateInstallmentPlanTotalCents(
    installmentPlanId,
    updatedTransactions,
  );

  return { updatedTransactions, newTotalAmountCents };
}

/**
 * Checks whether an installment plan can be soft-deleted as a whole (permitted only if
 * none of its active installments belong to a `CLOSED` or `PAID` invoice).
 */
export function canHardCancelInstallmentPlan(
  installmentPlanId: string,
  transactions: readonly LedgerTransaction[],
  invoices: readonly LedgerInvoice[],
): boolean {
  const invoiceStatusById = new Map<string, InvoiceStatus>();
  for (const inv of invoices) {
    if (inv.deletedAt === null) {
      invoiceStatusById.set(inv.id, inv.status);
    }
  }

  for (const tx of transactions) {
    if (tx.deletedAt !== null || tx.installmentPlanId !== installmentPlanId) {
      continue;
    }
    if (tx.invoiceId !== null) {
      const status = invoiceStatusById.get(tx.invoiceId);
      if (status === 'CLOSED' || status === 'PAID') {
        return false;
      }
    }
  }

  return true;
}

/**
 * Reconstructs the exact balance of a bank account/wallet from its initial balance and transaction ledger.
 * Only active (`deletedAt === null`) and settled (`status === 'CLEARED'`) transactions affect account balance.
 */
export function calculateAccountBalanceCents(
  accountId: string,
  initialBalanceCents: number,
  transactions: readonly LedgerTransaction[],
): number {
  if (!Number.isInteger(initialBalanceCents) || !Number.isSafeInteger(initialBalanceCents)) {
    throw new Error(`Invalid initialBalanceCents: ${initialBalanceCents}`);
  }

  let balance = initialBalanceCents;

  for (const tx of transactions) {
    if (tx.deletedAt !== null || tx.status !== 'CLEARED') continue;

    if (tx.accountId === accountId) {
      if (tx.type === 'INCOME' || tx.type === 'DEBIT_REFUND') {
        balance += tx.amountCents;
      } else if (
        tx.type === 'EXPENSE' ||
        tx.type === 'TRANSFER' ||
        tx.type === 'INVOICE_PAYMENT'
      ) {
        balance -= tx.amountCents;
      }
    } else if (tx.transferAccountId === accountId && tx.type === 'TRANSFER') {
      balance += tx.amountCents;
    }
  }

  return balance;
}

/**
 * Calculates the current unpaid debt of a credit card invoice in cents.
 */
export function calculateInvoiceDebtCents(
  invoiceId: string,
  transactions: readonly LedgerTransaction[],
): number {
  let debt = 0;

  for (const tx of transactions) {
    if (tx.deletedAt !== null || tx.invoiceId !== invoiceId) continue;

    if (tx.type === 'CREDIT_PURCHASE') {
      debt += tx.amountCents;
    } else if (tx.type === 'CREDIT_REFUND') {
      debt -= tx.amountCents;
    } else if (tx.type === 'INVOICE_PAYMENT' && tx.status === 'CLEARED') {
      debt -= tx.amountCents;
    }
  }

  return debt;
}

/**
 * Calculates the available credit limit of a credit card (`limitCents - totalOpenInvoiceDebtCents`).
 * All unpaid future installments on the card reduce the available limit immediately.
 */
export function calculateCreditCardAvailableLimitCents(
  creditCard: Pick<LedgerCreditCard, 'id' | 'limitCents'>,
  transactions: readonly LedgerTransaction[],
  invoices?: readonly LedgerInvoice[],
): number {
  assertNonNegativeCents(creditCard.limitCents, 'creditCard.limitCents');

  const invoiceIds = new Set<string>();

  if (invoices && invoices.length > 0) {
    for (const inv of invoices) {
      if (
        inv.deletedAt === null &&
        inv.creditCardId === creditCard.id &&
        inv.status !== 'PAID'
      ) {
        invoiceIds.add(inv.id);
      }
    }
  } else {
    for (const tx of transactions) {
      if (
        tx.deletedAt === null &&
        tx.creditCardId === creditCard.id &&
        tx.invoiceId !== null
      ) {
        invoiceIds.add(tx.invoiceId);
      }
    }
  }

  let committedDebtCents = 0;
  for (const invoiceId of invoiceIds) {
    const debt = calculateInvoiceDebtCents(invoiceId, transactions);
    if (debt > 0) {
      committedDebtCents += debt;
    }
  }

  return creditCard.limitCents - committedDebtCents;
}

/**
 * Evaluates whether a record's `ownerUserId` matches the active contextual filter.
 */
export function matchesOwnershipFilter(
  ownerUserId: string | null,
  filter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): boolean {
  switch (filter.mode) {
    case 'CONSOLIDATED':
      return true;
    case 'DOMESTIC':
      return ownerUserId === null;
    case 'USER':
      return ownerUserId === filter.userId;
  }
}

export interface BudgetCalculationOptions {
  ownerFilter?: OwnershipFilter;
  /**
   * When true, credit card purchases/refunds only count if their invoice has a CLEARED
   * `INVOICE_PAYMENT` (or has `status === 'PAID'` in `invoices`), using the payment's competence month
   * when available. Defaults to false (where `tx.competenceMonth` already reflects the invoice's due/payment month per DEC-01).
   */
  requireInvoicePaymentCleared?: boolean;
  invoices?: readonly LedgerInvoice[];
}

/**
 * Calculates net budget consumption in cents for a category and competence month (`YYYY-MM`).
 * - Sums `EXPENSE` and `CREDIT_PURCHASE` in that category and competence month.
 * - Subtracts contra-expenses (`DEBIT_REFUND` and `CREDIT_REFUND`) so refunds restore budget
 *   without inflating income.
 * - Honors DEC-01: credit card purchases carry the competence month of the invoice payment cycle
 *   (and optionally can be gated on settled `INVOICE_PAYMENT`).
 */
export function calculateBudgetConsumedCents(
  categoryId: string,
  competenceMonth: string,
  transactions: readonly LedgerTransaction[],
  options: BudgetCalculationOptions = {},
): number {
  assertCompetenceMonth(competenceMonth, 'competenceMonth');
  const ownerFilter = options.ownerFilter ?? { mode: 'CONSOLIDATED' };

  const paidInvoiceMonthMap = new Map<string, string>();
  if (options.requireInvoicePaymentCleared) {
    if (options.invoices) {
      for (const inv of options.invoices) {
        if (inv.deletedAt === null && inv.status === 'PAID') {
          paidInvoiceMonthMap.set(inv.id, inv.competenceMonth);
        }
      }
    }
    for (const tx of transactions) {
      if (
        tx.deletedAt === null &&
        tx.type === 'INVOICE_PAYMENT' &&
        tx.status === 'CLEARED' &&
        tx.invoiceId !== null
      ) {
        paidInvoiceMonthMap.set(tx.invoiceId, tx.competenceMonth);
      }
    }
  }

  let consumed = 0;

  for (const tx of transactions) {
    if (tx.deletedAt !== null || tx.categoryId !== categoryId) continue;
    if (!matchesOwnershipFilter(tx.ownerUserId, ownerFilter)) continue;

    if (tx.type === 'EXPENSE' || tx.type === 'DEBIT_REFUND') {
      if (tx.competenceMonth !== competenceMonth) continue;
      consumed += tx.type === 'EXPENSE' ? tx.amountCents : -tx.amountCents;
    } else if (tx.type === 'CREDIT_PURCHASE' || tx.type === 'CREDIT_REFUND') {
      let effectiveCompetenceMonth = tx.competenceMonth;
      if (options.requireInvoicePaymentCleared) {
        if (tx.invoiceId === null || !paidInvoiceMonthMap.has(tx.invoiceId)) {
          continue;
        }
        effectiveCompetenceMonth = paidInvoiceMonthMap.get(tx.invoiceId)!;
      }
      if (effectiveCompetenceMonth !== competenceMonth) continue;
      consumed += tx.type === 'CREDIT_PURCHASE' ? tx.amountCents : -tx.amountCents;
    }
  }

  return consumed;
}

/**
 * Calculates total monthly income and expenses in cents for a competence month.
 * - `TRANSFER` and `INVOICE_PAYMENT` never add to income or expenses.
 * - `DEBIT_REFUND` and `CREDIT_REFUND` subtract from expenses and never add to `INCOME`.
 */
export function calculateMonthlySummaryCents(
  competenceMonth: string,
  transactions: readonly LedgerTransaction[],
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): { incomeCents: number; expenseCents: number; netSavingsCents: number } {
  assertCompetenceMonth(competenceMonth, 'competenceMonth');

  let incomeCents = 0;
  let expenseCents = 0;

  for (const tx of transactions) {
    if (tx.deletedAt !== null || tx.competenceMonth !== competenceMonth) continue;
    if (!matchesOwnershipFilter(tx.ownerUserId, ownerFilter)) continue;

    if (tx.type === 'INCOME') {
      incomeCents += tx.amountCents;
    } else if (tx.type === 'EXPENSE' || tx.type === 'CREDIT_PURCHASE') {
      expenseCents += tx.amountCents;
    } else if (tx.type === 'DEBIT_REFUND' || tx.type === 'CREDIT_REFUND') {
      expenseCents -= tx.amountCents;
    }
    // TRANSFER and INVOICE_PAYMENT are intentionally excluded
  }

  return {
    incomeCents,
    expenseCents,
    netSavingsCents: incomeCents - expenseCents,
  };
}

/**
 * Calculates Consolidated Net Worth (`Patrimônio Líquido Consolidado`) in cents:
 * sum of balances of active accounts with `includeInNetWorth === true`
 * minus sum of `max(0, invoiceDebt)` for active `OPEN` and `CLOSED` invoices.
 */
export function calculateNetWorthCents(
  accounts: readonly LedgerAccount[],
  invoices: readonly LedgerInvoice[],
  transactions: readonly LedgerTransaction[],
): number {
  let assetsCents = 0;
  for (const account of accounts) {
    if (account.deletedAt !== null || !account.includeInNetWorth) continue;
    assetsCents += calculateAccountBalanceCents(
      account.id,
      account.initialBalanceCents,
      transactions,
    );
  }

  let liabilitiesCents = 0;
  for (const invoice of invoices) {
    if (invoice.deletedAt !== null) continue;
    if (invoice.status !== 'OPEN' && invoice.status !== 'CLOSED') continue;
    const debt = calculateInvoiceDebtCents(invoice.id, transactions);
    if (debt > 0) {
      liabilitiesCents += debt;
    }
  }

  return assetsCents - liabilitiesCents;
}

/**
 * Calculates each partner's contribution to household finances in a competence month (`DEC-02`):
 * 1. Explicit transfers (`type === 'TRANSFER'`, `status === 'CLEARED'`, `isHouseholdContribution === true`)
 *    from a member's individual account (`account.ownerUserId === memberId`) to a shared account
 *    (`transferAccount.ownerUserId === null`).
 * 2. Direct payment of a shared domestic expense (`tx.ownerUserId === null`) via an individual
 *    bank account (`account.ownerUserId === memberId`, `status === 'CLEARED'`) or individual
 *    credit card (`creditCard.ownerUserId === memberId`), net of any shared refunds (`DEBIT_REFUND` / `CREDIT_REFUND`).
 */
export function calculateHouseholdContributions(
  competenceMonth: string,
  memberUserIds: readonly [string, string],
  accounts: readonly LedgerAccount[],
  creditCards: readonly LedgerCreditCard[],
  transactions: readonly LedgerTransaction[],
): HouseholdContributionSummary {
  assertCompetenceMonth(competenceMonth, 'competenceMonth');

  const accountOwnerById = new Map<string, string | null>();
  for (const acc of accounts) {
    if (acc.deletedAt === null) {
      accountOwnerById.set(acc.id, acc.ownerUserId);
    }
  }

  const cardOwnerById = new Map<string, string | null>();
  for (const card of creditCards) {
    if (card.deletedAt === null) {
      cardOwnerById.set(card.id, card.ownerUserId);
    }
  }

  const stats = new Map<
    string,
    { explicitTransferCents: number; directDomesticExpenseCents: number }
  >([
    [memberUserIds[0], { explicitTransferCents: 0, directDomesticExpenseCents: 0 }],
    [memberUserIds[1], { explicitTransferCents: 0, directDomesticExpenseCents: 0 }],
  ]);

  for (const tx of transactions) {
    if (tx.deletedAt !== null || tx.competenceMonth !== competenceMonth) continue;

    // 1. Explicit transfer to shared account
    if (
      tx.type === 'TRANSFER' &&
      tx.status === 'CLEARED' &&
      tx.isHouseholdContribution &&
      tx.accountId !== null &&
      tx.transferAccountId !== null
    ) {
      const originOwner = accountOwnerById.get(tx.accountId) ?? tx.ownerUserId;
      const destOwner = accountOwnerById.get(tx.transferAccountId);
      if (originOwner && stats.has(originOwner) && destOwner === null) {
        stats.get(originOwner)!.explicitTransferCents += tx.amountCents;
      }
      continue;
    }

    // 2. DEC-02: Shared expense (ownerUserId === null) paid with an individual account or credit card
    if (tx.ownerUserId === null) {
      if ((tx.type === 'EXPENSE' || tx.type === 'DEBIT_REFUND') && tx.status === 'CLEARED' && tx.accountId !== null) {
        const accountOwner = accountOwnerById.get(tx.accountId);
        if (accountOwner && stats.has(accountOwner)) {
          const delta = tx.type === 'EXPENSE' ? tx.amountCents : -tx.amountCents;
          stats.get(accountOwner)!.directDomesticExpenseCents += delta;
        }
      } else if (
        (tx.type === 'CREDIT_PURCHASE' || tx.type === 'CREDIT_REFUND') &&
        tx.creditCardId !== null
      ) {
        const cardOwner = cardOwnerById.get(tx.creditCardId);
        if (cardOwner && stats.has(cardOwner)) {
          const delta = tx.type === 'CREDIT_PURCHASE' ? tx.amountCents : -tx.amountCents;
          stats.get(cardOwner)!.directDomesticExpenseCents += delta;
        }
      }
    }
  }

  const m0 = stats.get(memberUserIds[0])!;
  const m1 = stats.get(memberUserIds[1])!;
  const total0 = Math.max(0, m0.explicitTransferCents + m0.directDomesticExpenseCents);
  const total1 = Math.max(0, m1.explicitTransferCents + m1.directDomesticExpenseCents);
  const grandTotal = total0 + total1;

  const buildBreakdown = (
    userId: string,
    raw: { explicitTransferCents: number; directDomesticExpenseCents: number },
    memberTotal: number,
  ): MemberContributionBreakdown => {
    const shareRatio = grandTotal > 0 ? memberTotal / grandTotal : 0;
    return {
      userId,
      explicitTransferCents: raw.explicitTransferCents,
      directDomesticExpenseCents: raw.directDomesticExpenseCents,
      totalContributionCents: memberTotal,
      shareRatio,
      sharePercentage: Math.round(shareRatio * 10000) / 100,
    };
  };

  return {
    competenceMonth,
    totalContributionCents: grandTotal,
    members: [
      buildBreakdown(memberUserIds[0], m0, total0),
      buildBreakdown(memberUserIds[1], m1, total1),
    ],
  };
}
