import { and, eq, isNull } from 'drizzle-orm';
import {
  addMonthsToCompetence,
  calculateAccountBalanceCents,
  calculateBudgetConsumedCents,
  calculateHouseholdContributions,
  calculateInvoiceDebtCents,
  calculateMonthlySummaryCents,
  calculateNetWorthCents,
  type HouseholdContributionSummary,
  type LedgerAccount,
  type LedgerCreditCard,
  type LedgerInvoice,
  type LedgerTransaction,
  matchesOwnershipFilter,
  type OwnershipFilter,
} from '@/core';
import type { AppDatabase } from '../db';
import {
  accounts,
  budgets,
  categories,
  creditCardInvoices,
  creditCards,
  householdMembers,
  transactions,
} from '../schema';
import {
  mapAccountRowToLedger,
} from './accountRepository';
import type { BudgetBarItem } from '@/components/BudgetBar';
import type { NetWorthPoint } from '@/components/NetWorthChart';
import {
  mapCreditCardRowToLedger,
  mapInvoiceRowToLedger,
  mapTransactionRowToLedger,
} from './creditCards';

const MONTH_LABELS_BR: Record<string, string> = {
  '01': 'Jan',
  '02': 'Fev',
  '03': 'Mar',
  '04': 'Abr',
  '05': 'Mai',
  '06': 'Jun',
  '07': 'Jul',
  '08': 'Ago',
  '09': 'Set',
  '10': 'Out',
  '11': 'Nov',
  '12': 'Dez',
};

export function formatCompetenceLabel(competenceMonth: string): string {
  const [year, month] = competenceMonth.split('-');
  const label = MONTH_LABELS_BR[month] ?? month;
  return `${label}/${year.slice(2)}`;
}

export interface DashboardAggregates {
  competenceMonth: string;
  monthlySummary: {
    incomeCents: number;
    expenseCents: number;
    netSavingsCents: number;
  };
  netWorthCents: number;
  netWorthEvolution: NetWorthPoint[];
  budgets: BudgetBarItem[];
  contributions: HouseholdContributionSummary | null;
  members: {
    userId: string;
    displayName: string;
    role: string;
    colorHex: string;
  }[];
  timingMs: number;
}

/**
 * Computes contextual net worth in cents for a given ownership filter.
 */
export function computeContextualNetWorthCents(
  accounts: readonly LedgerAccount[],
  invoices: readonly LedgerInvoice[],
  transactions: readonly LedgerTransaction[],
  creditCards: readonly LedgerCreditCard[],
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): number {
  const cardOwnerById = new Map<string, string | null>();
  for (const c of creditCards) {
    if (c.deletedAt === null) {
      cardOwnerById.set(c.id, c.ownerUserId);
    }
  }

  // Filter accounts by owner
  const filteredAccounts = accounts.filter((acc) => {
    if (acc.deletedAt !== null || !acc.includeInNetWorth) return false;
    return matchesOwnershipFilter(acc.ownerUserId, ownerFilter);
  });

  // Filter invoices by credit card owner
  const filteredInvoices = invoices.filter((inv) => {
    if (inv.deletedAt !== null) return false;
    if (inv.status !== 'OPEN' && inv.status !== 'CLOSED') return false;
    const cardOwner = cardOwnerById.get(inv.creditCardId) ?? null;
    return matchesOwnershipFilter(cardOwner, ownerFilter);
  });

  return calculateNetWorthCents(filteredAccounts, filteredInvoices, transactions);
}

/**
 * Computes the 6-month historical net worth evolution ending at `currentMonth`.
 */
export function computeNetWorthEvolution(
  currentMonth: string,
  accounts: readonly LedgerAccount[],
  invoices: readonly LedgerInvoice[],
  transactions: readonly LedgerTransaction[],
  creditCards: readonly LedgerCreditCard[],
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): NetWorthPoint[] {
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) {
    months.push(addMonthsToCompetence(currentMonth, -i));
  }

  const cardOwnerById = new Map<string, string | null>();
  for (const c of creditCards) {
    if (c.deletedAt === null) {
      cardOwnerById.set(c.id, c.ownerUserId);
    }
  }

  const filteredAccounts = accounts.filter(
    (acc) =>
      acc.deletedAt === null &&
      acc.includeInNetWorth &&
      matchesOwnershipFilter(acc.ownerUserId, ownerFilter),
  );

  return months.map((month) => {
    // Only transactions up to this competence month
    const pastTxs = transactions.filter(
      (tx) => tx.deletedAt === null && tx.competenceMonth <= month,
    );

    // Invoices for this month or previous that were active
    const pastInvoices = invoices.filter((inv) => {
      if (inv.deletedAt !== null) return false;
      if (inv.competenceMonth > month) return false;
      const cardOwner = cardOwnerById.get(inv.creditCardId) ?? null;
      return matchesOwnershipFilter(cardOwner, ownerFilter);
    });

    // Assets at month end
    let assetsCents = 0;
    for (const acc of filteredAccounts) {
      assetsCents += calculateAccountBalanceCents(
        acc.id,
        acc.initialBalanceCents,
        pastTxs,
      );
    }

    // Liabilities at month end (invoices with competenceMonth <= month)
    let liabilitiesCents = 0;
    for (const inv of pastInvoices) {
      const debt = calculateInvoiceDebtCents(inv.id, pastTxs);
      if (debt > 0) {
        liabilitiesCents += debt;
      }
    }

    const [, mm] = month.split('-');
    const label = MONTH_LABELS_BR[mm] ?? mm;

    return {
      competenceMonth: month,
      label,
      netWorthCents: assetsCents - liabilitiesCents,
    };
  });
}

/**
 * High-performance contextual aggregate query for the Dashboard.
 * Executes on local SQLite and finishes well under 20ms.
 */
export function getDashboardAggregates(
  db: AppDatabase,
  householdId: string,
  competenceMonth: string,
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): DashboardAggregates {
  const startTime = performance.now();

  // 1. Fetch domain rows from local SQLite
  const accountRows = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.householdId, householdId), isNull(accounts.deletedAt)))
    .all();

  const cardRows = db
    .select()
    .from(creditCards)
    .where(and(eq(creditCards.householdId, householdId), isNull(creditCards.deletedAt)))
    .all();

  const invoiceRows = db
    .select()
    .from(creditCardInvoices)
    .where(
      and(
        eq(creditCardInvoices.householdId, householdId),
        isNull(creditCardInvoices.deletedAt),
      ),
    )
    .all();

  const transactionRows = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        isNull(transactions.deletedAt),
      ),
    )
    .all();

  const budgetRows = db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.householdId, householdId),
        eq(budgets.competenceMonth, competenceMonth),
        isNull(budgets.deletedAt),
      ),
    )
    .all();

  const categoryRows = db
    .select()
    .from(categories)
    .where(
      and(eq(categories.householdId, householdId), isNull(categories.deletedAt)),
    )
    .all();

  const memberRows = db
    .select()
    .from(householdMembers)
    .where(
      and(
        eq(householdMembers.householdId, householdId),
        isNull(householdMembers.revokedAt),
      ),
    )
    .all();

  // 2. Map to Ledger domain objects
  const ledgerAccounts = accountRows.map(mapAccountRowToLedger);
  const ledgerCards = cardRows.map(mapCreditCardRowToLedger);
  const ledgerInvoices = invoiceRows.map(mapInvoiceRowToLedger);
  const ledgerTransactions = transactionRows.map(mapTransactionRowToLedger);

  // 3. Compute Monthly Summary (Income, Expenses, Savings) for the competence month & filter
  const monthlySummary = calculateMonthlySummaryCents(
    competenceMonth,
    ledgerTransactions,
    ownerFilter,
  );

  // 4. Compute Net Worth (Assets - Liabilities) respecting contextual filter
  const netWorthCents = computeContextualNetWorthCents(
    ledgerAccounts,
    ledgerInvoices,
    ledgerTransactions,
    ledgerCards,
    ownerFilter,
  );

  // 5. Compute Net Worth Evolution (6-month historical curve)
  const netWorthEvolution = computeNetWorthEvolution(
    competenceMonth,
    ledgerAccounts,
    ledgerInvoices,
    ledgerTransactions,
    ledgerCards,
    ownerFilter,
  );

  // 6. Compute Budgets with consumption (DEC-01)
  const categoryById = new Map(categoryRows.map((c) => [c.id, c]));

  // Filter budgets by owner filter if applicable
  const filteredBudgets = budgetRows.filter((b) =>
    matchesOwnershipFilter(b.ownerUserId, ownerFilter),
  );

  const budgetItems: BudgetBarItem[] = filteredBudgets.map((b) => {
    const cat = categoryById.get(b.categoryId);
    const consumedCents = calculateBudgetConsumedCents(
      b.categoryId,
      competenceMonth,
      ledgerTransactions,
      {
        ownerFilter,
        invoices: ledgerInvoices,
      },
    );

    return {
      id: b.id,
      categoryId: b.categoryId,
      categoryName: cat?.name ?? 'Categoria',
      categoryIcon: cat?.iconName,
      categoryColorHex: cat?.colorHex,
      limitCents: b.limitCents,
      consumedCents,
    };
  });

  // 7. Compute DEC-02 Contribution Breakdown
  let contributions: HouseholdContributionSummary | null = null;
  if (memberRows.length >= 2) {
    const memberIds: [string, string] = [
      memberRows[0].userId,
      memberRows[1].userId,
    ];
    contributions = calculateHouseholdContributions(
      competenceMonth,
      memberIds,
      ledgerAccounts,
      ledgerCards,
      ledgerTransactions,
    );
  }

  const timingMs = performance.now() - startTime;

  return {
    competenceMonth,
    monthlySummary,
    netWorthCents,
    netWorthEvolution,
    budgets: budgetItems,
    contributions,
    members: memberRows.map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      role: m.role,
      colorHex: m.colorHex,
    })),
    timingMs,
  };
}
