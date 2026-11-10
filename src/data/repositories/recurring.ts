import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import {
  assertCompetenceMonth,
  generateRecurringTransactionId,
  isRecurringRuleDueInMonth,
  materializeRecurringTransaction,
  matchesOwnershipFilter,
  type OwnershipFilter,
  type RecurringFrequency,
  type RecurringRuleDefinition,
  type RecurringRuleType,
} from '@/core';
import type { AppDatabase, DbExecutor } from '../db';
import {
  accounts,
  type AccountRow,
  categories,
  type CategoryRow,
  creditCards,
  type CreditCardRow,
  householdMembers,
  type HouseholdMemberRow,
  recurringRules,
  type RecurringRuleRow,
  transactions,
  type TransactionRow,
} from '../schema';
import { ensureCardInvoiceForCompetenceInTx } from './creditCards';
import { type MutationContextOptions } from './outbox';
import {
  updateRecurringRule,
  type UpdateRecurringRulePatch,
} from './recurringRuleRepository';
import {
  insertTransactionInTx,
  updateTransactionInTx,
} from './transactionRepository';

export * from './recurringRuleRepository';

export interface MaterializeMonthParams {
  householdId: string;
  competenceMonth: string; // YYYY-MM
  defaultCreatedByUserId?: string;
}

export interface RecurringRuleWithDetails {
  rule: RecurringRuleRow;
  category: CategoryRow | null;
  account: AccountRow | null;
  creditCard: CreditCardRow | null;
  ownerMember: HouseholdMemberRow | null;
}

export interface RecurringOccurrenceWithDetails {
  transaction: TransactionRow;
  rule: RecurringRuleRow | null;
  category: CategoryRow | null;
  account: AccountRow | null;
  creditCard: CreditCardRow | null;
  ownerMember: HouseholdMemberRow | null;
}

export interface MonthlyProjectionSummary {
  projectedIncomeCents: number;
  projectedExpenseCents: number;
  projectedNetBalanceCents: number;
  totalOccurrencesCount: number;
  pendingCount: number;
  clearedCount: number;
  pendingIncomeCents: number;
  pendingExpenseCents: number;
}

function mapRuleRowToDefinition(row: RecurringRuleRow): RecurringRuleDefinition {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    type: row.type as RecurringRuleType,
    accountId: row.accountId,
    creditCardId: row.creditCardId,
    categoryId: row.categoryId,
    description: row.description,
    amountCents: row.amountCents,
    frequency: row.frequency as RecurringFrequency,
    dayOfMonth: row.dayOfMonth,
    startMonth: row.startMonth,
    endMonth: row.endMonth,
    isActive: row.isActive,
    deletedAt: row.deletedAt,
  };
}

/**
 * Deterministically materializes `PENDING` occurrences for a given `competenceMonth` (UUIDv5)
 * within an active SQLite transaction and enqueues `UPSERT` mutations to `sync_outbox`.
 *
 * Requirements (Phase 8 / TEST-FIN-06):
 * - Occurrence id = `UUIDv5(NAMESPACE, rule_id + ":" + competence_month)`.
 * - Idempotent: If an occurrence transaction with that UUIDv5 already exists locally
 *   (whether PENDING, CLEARED, or soft-deleted), it is NOT recreated or overwritten.
 * - Soft-deleted rules stop future materialization without erasing past history.
 * - For `CREDIT_PURCHASE` rules, the corresponding invoice is deterministically resolved or created.
 */
export function materializeMonthInTx(
  tx: DbExecutor,
  params: MaterializeMonthParams,
  options: MutationContextOptions = {},
): TransactionRow[] {
  assertCompetenceMonth(params.competenceMonth, 'competenceMonth');

  const activeRules = tx
    .select()
    .from(recurringRules)
    .where(
      and(
        eq(recurringRules.householdId, params.householdId),
        eq(recurringRules.isActive, true),
        isNull(recurringRules.deletedAt),
      ),
    )
    .all();

  const materializedRows: TransactionRow[] = [];

  for (const ruleRow of activeRules) {
    const ruleDef = mapRuleRowToDefinition(ruleRow);
    if (!isRecurringRuleDueInMonth(ruleDef, params.competenceMonth)) {
      continue;
    }

    const deterministicTxId = generateRecurringTransactionId(
      ruleRow.id,
      params.competenceMonth,
    );

    // Idempotency check: does this occurrence already exist?
    const existingTx = tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, deterministicTxId))
      .get();

    if (existingTx) {
      // Already materialized (or previously processed) — keep idempotent
      continue;
    }

    let invoiceId: string | null = null;
    if (ruleRow.type === 'CREDIT_PURCHASE') {
      if (!ruleRow.creditCardId) {
        throw new Error(
          `Recurring CREDIT_PURCHASE rule ${ruleRow.id} must have creditCardId`,
        );
      }
      const invoice = ensureCardInvoiceForCompetenceInTx(
        tx,
        {
          householdId: params.householdId,
          creditCardId: ruleRow.creditCardId,
          competenceMonth: params.competenceMonth,
        },
        options,
      );
      invoiceId = invoice.id;
    }

    const ledgerTx = materializeRecurringTransaction(
      ruleDef,
      params.competenceMonth,
      { invoiceId },
    );

    const createdTx = insertTransactionInTx(
      tx,
      {
        id: ledgerTx.id,
        householdId: params.householdId,
        createdByUserId:
          params.defaultCreatedByUserId ?? ruleRow.createdByUserId,
        ownerUserId: ledgerTx.ownerUserId,
        type: ledgerTx.type,
        status: 'PENDING',
        amountCents: ledgerTx.amountCents,
        transactionDate: ledgerTx.transactionDate,
        competenceMonth: ledgerTx.competenceMonth,
        description: ledgerTx.description ?? ruleRow.description,
        notes: null,
        accountId: ledgerTx.accountId,
        transferAccountId: null,
        creditCardId: ledgerTx.creditCardId,
        invoiceId: ledgerTx.invoiceId,
        categoryId: ledgerTx.categoryId,
        installmentPlanId: null,
        installmentNumber: null,
        totalInstallments: null,
        recurringRuleId: ruleRow.id,
        refundedTransactionId: null,
        isHouseholdContribution: false,
        calendarEventId: null,
      },
      options,
    );

    materializedRows.push(createdTx);
  }

  return materializedRows;
}

export function materializeMonth(
  db: AppDatabase,
  params: MaterializeMonthParams,
  options: MutationContextOptions = {},
): TransactionRow[] {
  return db.transaction((tx) => materializeMonthInTx(tx, params, options));
}

/**
 * One-tap confirmation: transitions a transaction from `PENDING` to `CLEARED`
 * in an atomic transaction and enqueues outbox `UPSERT` with `fieldHlc.status`.
 * Idempotent if already `CLEARED`.
 */
export function confirmPendingTransactionInTx(
  tx: DbExecutor,
  transactionId: string,
  options: MutationContextOptions = {},
): TransactionRow {
  const existing = tx
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .get();

  if (!existing || existing.deletedAt !== null) {
    throw new Error(`Active transaction not found: ${transactionId}`);
  }

  if (existing.status === 'CLEARED') {
    return existing;
  }

  return updateTransactionInTx(
    tx,
    transactionId,
    { status: 'CLEARED' },
    options,
  );
}

export function confirmPendingTransaction(
  db: AppDatabase,
  transactionId: string,
  options: MutationContextOptions = {},
): TransactionRow {
  return db.transaction((tx) =>
    confirmPendingTransactionInTx(tx, transactionId, options),
  );
}

/**
 * Updates a recurring rule and optionally propagates amount/category/description/owner
 * changes to existing future occurrences or current month's PENDING occurrences.
 */
export function updateRecurringRuleWithOccurrences(
  db: AppDatabase,
  ruleId: string,
  patch: UpdateRecurringRulePatch,
  currentCompetenceMonth?: string,
  options: MutationContextOptions = {},
): RecurringRuleRow {
  return db.transaction((tx) => {
    const updatedRule = updateRecurringRule(db, ruleId, patch, options);

    if (currentCompetenceMonth) {
      assertCompetenceMonth(currentCompetenceMonth, 'currentCompetenceMonth');
      const ruleTransactions = tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.recurringRuleId, ruleId),
            isNull(transactions.deletedAt),
          ),
        )
        .all();

      for (const t of ruleTransactions) {
        if (t.status === 'CLEARED') continue;
        if (t.competenceMonth < currentCompetenceMonth) continue;

        const updatePatch: Parameters<typeof updateTransactionInTx>[2] = {};
        if (patch.amountCents !== undefined) updatePatch.amountCents = patch.amountCents;
        if (patch.categoryId !== undefined) updatePatch.categoryId = patch.categoryId;
        if (patch.description !== undefined) updatePatch.description = patch.description;
        if (patch.ownerUserId !== undefined) updatePatch.ownerUserId = patch.ownerUserId;

        if (Object.keys(updatePatch).length > 0) {
          updateTransactionInTx(tx, t.id, updatePatch, options);
        }
      }
    }

    return updatedRule;
  });
}

/**
 * Computes projected income, expenses, and pending counts from a list of transactions.
 */
export function calculateRecurringProjectionSummary(
  txList: readonly TransactionRow[],
): MonthlyProjectionSummary {
  let projectedIncomeCents = 0;
  let projectedExpenseCents = 0;
  let pendingCount = 0;
  let clearedCount = 0;
  let pendingIncomeCents = 0;
  let pendingExpenseCents = 0;

  for (const t of txList) {
    if (t.deletedAt !== null) continue;

    if (t.type === 'INCOME') {
      projectedIncomeCents += t.amountCents;
      if (t.status === 'PENDING') {
        pendingIncomeCents += t.amountCents;
      }
    } else if (t.type === 'EXPENSE' || t.type === 'CREDIT_PURCHASE') {
      projectedExpenseCents += t.amountCents;
      if (t.status === 'PENDING') {
        pendingExpenseCents += t.amountCents;
      }
    }

    if (t.status === 'PENDING') {
      pendingCount += 1;
    } else if (t.status === 'CLEARED') {
      clearedCount += 1;
    }
  }

  return {
    projectedIncomeCents,
    projectedExpenseCents,
    projectedNetBalanceCents: projectedIncomeCents - projectedExpenseCents,
    totalOccurrencesCount: txList.length,
    pendingCount,
    clearedCount,
    pendingIncomeCents,
    pendingExpenseCents,
  };
}

/**
 * Lists all active recurring rules with joined category, account, credit card, and owner details.
 */
export function listRecurringRulesWithDetails(
  db: AppDatabase,
  householdId: string,
): RecurringRuleWithDetails[] {
  const rules = db
    .select()
    .from(recurringRules)
    .where(
      and(
        eq(recurringRules.householdId, householdId),
        isNull(recurringRules.deletedAt),
      ),
    )
    .orderBy(desc(recurringRules.createdAt))
    .all();

  const allCategories = db
    .select()
    .from(categories)
    .where(eq(categories.householdId, householdId))
    .all();
  const catMap = new Map(allCategories.map((c) => [c.id, c]));

  const allAccounts = db
    .select()
    .from(accounts)
    .where(eq(accounts.householdId, householdId))
    .all();
  const accMap = new Map(allAccounts.map((a) => [a.id, a]));

  const allCards = db
    .select()
    .from(creditCards)
    .where(eq(creditCards.householdId, householdId))
    .all();
  const cardMap = new Map(allCards.map((c) => [c.id, c]));

  const allMembers = db
    .select()
    .from(householdMembers)
    .where(eq(householdMembers.householdId, householdId))
    .all();
  const memberMap = new Map(allMembers.map((m) => [m.userId, m]));

  return rules.map((rule) => ({
    rule,
    category: catMap.get(rule.categoryId) ?? null,
    account: rule.accountId ? accMap.get(rule.accountId) ?? null : null,
    creditCard: rule.creditCardId ? cardMap.get(rule.creditCardId) ?? null : null,
    ownerMember: rule.ownerUserId ? memberMap.get(rule.ownerUserId) ?? null : null,
  }));
}

/**
 * Lists all recurring transaction occurrences for a given `competenceMonth`, filtered by ownership,
 * with joined rule, category, account, credit card, and member details.
 */
export function listRecurringOccurrencesForMonth(
  db: AppDatabase,
  householdId: string,
  competenceMonth: string,
  ownershipFilter?: OwnershipFilter,
): RecurringOccurrenceWithDetails[] {
  assertCompetenceMonth(competenceMonth, 'competenceMonth');

  const txRows = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        eq(transactions.competenceMonth, competenceMonth),
        isNull(transactions.deletedAt),
      ),
    )
    .orderBy(asc(transactions.transactionDate))
    .all();

  const recurringTxRows = txRows.filter((t) => {
    if (!t.recurringRuleId) return false;
    if (ownershipFilter && !matchesOwnershipFilter(t.ownerUserId, ownershipFilter)) {
      return false;
    }
    return true;
  });

  const allRules = db
    .select()
    .from(recurringRules)
    .where(eq(recurringRules.householdId, householdId))
    .all();
  const ruleMap = new Map(allRules.map((r) => [r.id, r]));

  const allCategories = db
    .select()
    .from(categories)
    .where(eq(categories.householdId, householdId))
    .all();
  const catMap = new Map(allCategories.map((c) => [c.id, c]));

  const allAccounts = db
    .select()
    .from(accounts)
    .where(eq(accounts.householdId, householdId))
    .all();
  const accMap = new Map(allAccounts.map((a) => [a.id, a]));

  const allCards = db
    .select()
    .from(creditCards)
    .where(eq(creditCards.householdId, householdId))
    .all();
  const cardMap = new Map(allCards.map((c) => [c.id, c]));

  const allMembers = db
    .select()
    .from(householdMembers)
    .where(eq(householdMembers.householdId, householdId))
    .all();
  const memberMap = new Map(allMembers.map((m) => [m.userId, m]));

  return recurringTxRows.map((transaction) => ({
    transaction,
    rule: transaction.recurringRuleId
      ? ruleMap.get(transaction.recurringRuleId) ?? null
      : null,
    category: transaction.categoryId
      ? catMap.get(transaction.categoryId) ?? null
      : null,
    account: transaction.accountId
      ? accMap.get(transaction.accountId) ?? null
      : null,
    creditCard: transaction.creditCardId
      ? cardMap.get(transaction.creditCardId) ?? null
      : null,
    ownerMember: transaction.ownerUserId
      ? memberMap.get(transaction.ownerUserId) ?? null
      : null,
  }));
}
