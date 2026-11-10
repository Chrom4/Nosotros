import { and, between, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  assertTransactionInvariants,
  matchesOwnershipFilter,
  type OwnershipFilter,
  type TransactionInput,
  TransactionInputSchema,
  type TransactionStatus,
} from '@/core';
import type { AppDatabase, DbExecutor } from '../db';
import {
  accounts,
  categories,
  type TransactionRow,
  transactions,
} from '../schema';
import {
  advanceTransactionHlc,
  buildFieldHlcMap,
  enqueueOrCoalesceOutbox,
  generateUuidV4,
  type MutationContextOptions,
} from './outbox';

const TRANSACTION_MUTABLE_COLUMNS = [
  'owner_user_id',
  'type',
  'status',
  'amount_cents',
  'transaction_date',
  'competence_month',
  'description',
  'notes',
  'account_id',
  'transfer_account_id',
  'credit_card_id',
  'invoice_id',
  'category_id',
  'installment_plan_id',
  'installment_number',
  'total_installments',
  'recurring_rule_id',
  'refunded_transaction_id',
  'is_household_contribution',
  'calendar_event_id',
] as const;

export interface UpdateTransactionPatch {
  ownerUserId?: string | null;
  status?: TransactionStatus;
  amountCents?: number;
  transactionDate?: string;
  competenceMonth?: string;
  description?: string;
  notes?: string | null;
  accountId?: string | null;
  transferAccountId?: string | null;
  creditCardId?: string | null;
  invoiceId?: string | null;
  categoryId?: string | null;
  isHouseholdContribution?: boolean;
  calendarEventId?: string | null;
}

export function serializeTransactionPayload(
  row: TransactionRow,
): Record<string, unknown> {
  return {
    id: row.id,
    household_id: row.householdId,
    created_by_user_id: row.createdByUserId,
    owner_user_id: row.ownerUserId,
    type: row.type,
    status: row.status,
    amount_cents: row.amountCents,
    transaction_date: row.transactionDate,
    competence_month: row.competenceMonth,
    description: row.description,
    notes: row.notes,
    account_id: row.accountId,
    transfer_account_id: row.transferAccountId,
    credit_card_id: row.creditCardId,
    invoice_id: row.invoiceId,
    category_id: row.categoryId,
    installment_plan_id: row.installmentPlanId,
    installment_number: row.installmentNumber,
    total_installments: row.totalInstallments,
    recurring_rule_id: row.recurringRuleId,
    refunded_transaction_id: row.refundedTransactionId,
    is_household_contribution: row.isHouseholdContribution,
    calendar_event_id: row.calendarEventId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
    hlc_timestamp: row.hlcTimestamp,
  };
}

export function insertTransactionInTx(
  tx: DbExecutor,
  rawInput: TransactionInput,
  options: MutationContextOptions = {},
): TransactionRow {
  const input = TransactionInputSchema.parse(rawInput);
  assertTransactionInvariants(input);

  const meta = advanceTransactionHlc(tx, options);
  const fieldHlc = buildFieldHlcMap(TRANSACTION_MUTABLE_COLUMNS, meta.hlc);

  tx.insert(transactions)
    .values({
      id: input.id,
      householdId: input.householdId,
      createdByUserId: input.createdByUserId,
      ownerUserId: input.ownerUserId,
      type: input.type,
      status: input.status,
      amountCents: input.amountCents,
      transactionDate: input.transactionDate,
      competenceMonth: input.competenceMonth,
      description: input.description,
      notes: input.notes,
      accountId: input.accountId,
      transferAccountId: input.transferAccountId,
      creditCardId: input.creditCardId,
      invoiceId: input.invoiceId,
      categoryId: input.categoryId,
      installmentPlanId: input.installmentPlanId,
      installmentNumber: input.installmentNumber,
      totalInstallments: input.totalInstallments,
      recurringRuleId: input.recurringRuleId,
      refundedTransactionId: input.refundedTransactionId,
      isHouseholdContribution: input.isHouseholdContribution,
      calendarEventId: input.calendarEventId,
      createdAt: meta.isoNow,
      updatedAt: meta.isoNow,
      deletedAt: null,
      hlcTimestamp: meta.hlc,
      fieldHlc,
      serverSeq: 0,
    })
    .run();

  const row = tx
    .select()
    .from(transactions)
    .where(eq(transactions.id, input.id))
    .get()!;

  enqueueOrCoalesceOutbox(tx, {
    mutationId: options.mutationId,
    batchId: meta.batchId,
    tableName: 'transactions',
    recordId: row.id,
    operation: 'UPSERT',
    payload: serializeTransactionPayload(row),
    fieldHlc,
    hlcTimestamp: meta.hlc,
    createdAt: meta.isoNow,
  });

  return row;
}

export function createTransaction(
  db: AppDatabase,
  rawInput: TransactionInput,
  options: MutationContextOptions = {},
): TransactionRow {
  return db.transaction((tx) => insertTransactionInTx(tx, rawInput, options));
}

export function updateTransactionInTx(
  tx: DbExecutor,
  transactionId: string,
  patch: UpdateTransactionPatch,
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

  const candidate = TransactionInputSchema.parse({
    id: existing.id,
    householdId: existing.householdId,
    createdByUserId: existing.createdByUserId,
    ownerUserId:
      patch.ownerUserId !== undefined
        ? patch.ownerUserId
        : existing.ownerUserId,
    type: existing.type,
    status: patch.status !== undefined ? patch.status : existing.status,
    amountCents:
      patch.amountCents !== undefined
        ? patch.amountCents
        : existing.amountCents,
    transactionDate:
      patch.transactionDate !== undefined
        ? patch.transactionDate
        : existing.transactionDate,
    competenceMonth:
      patch.competenceMonth !== undefined
        ? patch.competenceMonth
        : existing.competenceMonth,
    description:
      patch.description !== undefined
        ? patch.description
        : existing.description,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    accountId:
      patch.accountId !== undefined ? patch.accountId : existing.accountId,
    transferAccountId:
      patch.transferAccountId !== undefined
        ? patch.transferAccountId
        : existing.transferAccountId,
    creditCardId:
      patch.creditCardId !== undefined
        ? patch.creditCardId
        : existing.creditCardId,
    invoiceId:
      patch.invoiceId !== undefined ? patch.invoiceId : existing.invoiceId,
    categoryId:
      patch.categoryId !== undefined ? patch.categoryId : existing.categoryId,
    installmentPlanId: existing.installmentPlanId,
    installmentNumber: existing.installmentNumber,
    totalInstallments: existing.totalInstallments,
    recurringRuleId: existing.recurringRuleId,
    refundedTransactionId: existing.refundedTransactionId,
    isHouseholdContribution:
      patch.isHouseholdContribution !== undefined
        ? patch.isHouseholdContribution
        : existing.isHouseholdContribution,
    calendarEventId:
      patch.calendarEventId !== undefined
        ? patch.calendarEventId
        : existing.calendarEventId,
  });

  assertTransactionInvariants(candidate);

  const changedColumns: string[] = [];
  if (patch.ownerUserId !== undefined) changedColumns.push('owner_user_id');
  if (patch.status !== undefined) changedColumns.push('status');
  if (patch.amountCents !== undefined) changedColumns.push('amount_cents');
  if (patch.transactionDate !== undefined)
    changedColumns.push('transaction_date');
  if (patch.competenceMonth !== undefined)
    changedColumns.push('competence_month');
  if (patch.description !== undefined) changedColumns.push('description');
  if (patch.notes !== undefined) changedColumns.push('notes');
  if (patch.accountId !== undefined) changedColumns.push('account_id');
  if (patch.transferAccountId !== undefined)
    changedColumns.push('transfer_account_id');
  if (patch.creditCardId !== undefined) changedColumns.push('credit_card_id');
  if (patch.invoiceId !== undefined) changedColumns.push('invoice_id');
  if (patch.categoryId !== undefined) changedColumns.push('category_id');
  if (patch.isHouseholdContribution !== undefined)
    changedColumns.push('is_household_contribution');
  if (patch.calendarEventId !== undefined)
    changedColumns.push('calendar_event_id');

  const meta = advanceTransactionHlc(tx, options);
  const nextFieldHlc = buildFieldHlcMap(
    changedColumns,
    meta.hlc,
    existing.fieldHlc,
  );

  tx.update(transactions)
    .set({
      ownerUserId: candidate.ownerUserId,
      status: candidate.status,
      amountCents: candidate.amountCents,
      transactionDate: candidate.transactionDate,
      competenceMonth: candidate.competenceMonth,
      description: candidate.description,
      notes: candidate.notes,
      accountId: candidate.accountId,
      transferAccountId: candidate.transferAccountId,
      creditCardId: candidate.creditCardId,
      invoiceId: candidate.invoiceId,
      categoryId: candidate.categoryId,
      isHouseholdContribution: candidate.isHouseholdContribution,
      calendarEventId: candidate.calendarEventId,
      updatedAt: meta.isoNow,
      hlcTimestamp: meta.hlc,
      fieldHlc: nextFieldHlc,
    })
    .where(eq(transactions.id, transactionId))
    .run();

  const updated = tx
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .get()!;

  enqueueOrCoalesceOutbox(tx, {
    mutationId: options.mutationId,
    batchId: meta.batchId,
    tableName: 'transactions',
    recordId: updated.id,
    operation: 'UPSERT',
    payload: serializeTransactionPayload(updated),
    fieldHlc: buildFieldHlcMap(changedColumns, meta.hlc),
    hlcTimestamp: meta.hlc,
    createdAt: meta.isoNow,
  });

  return updated;
}

export function updateTransaction(
  db: AppDatabase,
  transactionId: string,
  patch: UpdateTransactionPatch,
  options: MutationContextOptions = {},
): TransactionRow {
  return db.transaction((tx) =>
    updateTransactionInTx(tx, transactionId, patch, options),
  );
}

/**
 * Soft-deletes a transaction (`deleted_at = hlc`) and enqueues `SOFT_DELETE` in `sync_outbox`.
 * Physical DELETE on synced domain tables is strictly prohibited.
 */
export function softDeleteTransaction(
  db: AppDatabase,
  transactionId: string,
  options: MutationContextOptions = {},
): TransactionRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .get();

    if (!existing) {
      throw new Error(`Transaction not found: ${transactionId}`);
    }

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      ['deleted_at'],
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(transactions)
      .set({
        deletedAt: meta.hlc,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(transactions.id, transactionId))
      .run();

    const deleted = tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'transactions',
      recordId: deleted.id,
      operation: 'SOFT_DELETE',
      payload: serializeTransactionPayload(deleted),
      fieldHlc: { deleted_at: meta.hlc },
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return deleted;
  });
}

/**
 * Restores a previously soft-deleted transaction (`deleted_at = null`) and enqueues `RESTORE`.
 */
export function restoreTransaction(
  db: AppDatabase,
  transactionId: string,
  options: MutationContextOptions = {},
): TransactionRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .get();

    if (!existing) {
      throw new Error(`Transaction not found: ${transactionId}`);
    }

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      ['deleted_at'],
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(transactions)
      .set({
        deletedAt: null,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(transactions.id, transactionId))
      .run();

    const restored = tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'transactions',
      recordId: restored.id,
      operation: 'RESTORE',
      payload: serializeTransactionPayload(restored),
      fieldHlc: { deleted_at: meta.hlc },
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return restored;
  });
}

export interface MonthlyAggregateRow {
  competenceMonth: string;
  incomeCents: number;
  expenseCents: number;
  netSavingsCents: number;
}

/**
 * Executes an indexed 12-month SQLite aggregation over active transactions (`deleted_at IS NULL`)
 * using `idx_transactions_competence_active`.
 * Honors accounting rules:
 * - `INCOME` adds to `incomeCents`.
 * - `EXPENSE` and `CREDIT_PURCHASE` add to `expenseCents`.
 * - `DEBIT_REFUND` and `CREDIT_REFUND` subtract from `expenseCents`.
 * - `TRANSFER` and `INVOICE_PAYMENT` are excluded from both income and expenses.
 */
export function queryTwelveMonthAggregate(
  db: AppDatabase,
  householdId: string,
  startMonth: string,
  endMonth: string,
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): MonthlyAggregateRow[] {
  const conditions = [
    eq(transactions.householdId, householdId),
    between(transactions.competenceMonth, startMonth, endMonth),
    isNull(transactions.deletedAt),
  ];

  if (ownerFilter.mode === 'DOMESTIC') {
    conditions.push(isNull(transactions.ownerUserId));
  } else if (ownerFilter.mode === 'USER') {
    conditions.push(eq(transactions.ownerUserId, ownerFilter.userId));
  }

  const rows = db
    .select({
      competenceMonth: transactions.competenceMonth,
      incomeCents: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.type} = 'INCOME' THEN ${transactions.amountCents} ELSE 0 END), 0)`,
      expenseCents: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.type} IN ('EXPENSE', 'CREDIT_PURCHASE') THEN ${transactions.amountCents} WHEN ${transactions.type} IN ('DEBIT_REFUND', 'CREDIT_REFUND') THEN -${transactions.amountCents} ELSE 0 END), 0)`,
    })
    .from(transactions)
    .where(and(...conditions))
    .groupBy(transactions.competenceMonth)
    .orderBy(transactions.competenceMonth)
    .all();

  return rows.map((row) => ({
    competenceMonth: row.competenceMonth,
    incomeCents: Number(row.incomeCents),
    expenseCents: Number(row.expenseCents),
    netSavingsCents: Number(row.incomeCents) - Number(row.expenseCents),
  }));
}

export const BASE_TRANSACTION_TYPES = [
  'INCOME',
  'EXPENSE',
  'DEBIT_REFUND',
  'TRANSFER',
] as const;

export type BaseTransactionType = (typeof BASE_TRANSACTION_TYPES)[number];

export interface ResolveBaseContributionParams {
  type: BaseTransactionType;
  ownerUserId: string | null;
  originAccountOwnerUserId: string | null;
  destAccountOwnerUserId?: string | null;
  requestedContributionFlag?: boolean;
}

/**
 * Resolves `isHouseholdContribution` for base ledger transactions according to DEC-02:
 * - If a shared expense or shared debit refund (`ownerUserId === null`) is paid from an
 *   individual account (`originAccountOwnerUserId !== null`), it is automatically a household contribution (`true`).
 * - If a `TRANSFER` originates from an individual account (`originAccountOwnerUserId !== null`)
 *   to a shared domestic account (`destAccountOwnerUserId === null`), honors `requestedContributionFlag`
 *   (defaulting to `true`).
 * - Otherwise returns `false`.
 */
export function resolveBaseTransactionContributionFlag(
  params: ResolveBaseContributionParams,
): boolean {
  if (params.type === 'EXPENSE' || params.type === 'DEBIT_REFUND') {
    if (
      params.ownerUserId === null &&
      params.originAccountOwnerUserId !== null
    ) {
      return true;
    }
    return Boolean(params.requestedContributionFlag ?? false);
  }

  if (params.type === 'TRANSFER') {
    if (
      params.originAccountOwnerUserId !== null &&
      params.destAccountOwnerUserId === null
    ) {
      return params.requestedContributionFlag ?? true;
    }
    return false;
  }

  return false;
}

export interface CreateBaseTransactionParams {
  id?: string;
  householdId: string;
  createdByUserId: string;
  ownerUserId: string | null;
  type: BaseTransactionType;
  status?: TransactionStatus;
  amountCents: number;
  transactionDate: string; // YYYY-MM-DD
  competenceMonth?: string; // YYYY-MM (defaults to transactionDate.slice(0, 7))
  description: string;
  notes?: string | null;
  accountId: string | null;
  transferAccountId?: string | null;
  categoryId?: string | null;
  refundedTransactionId?: string | null;
  isHouseholdContribution?: boolean;
}

/**
 * Captures a base ledger transaction (`INCOME`, `EXPENSE`, `DEBIT_REFUND`, `TRANSFER`),
 * enforcing pointer invariants before and at persistence, verifying active account/category references,
 * and applying DEC-02 contribution rules atomically with `sync_outbox`.
 */
export function createBaseTransaction(
  db: AppDatabase,
  params: CreateBaseTransactionParams,
  options: MutationContextOptions = {},
): TransactionRow {
  if (
    !BASE_TRANSACTION_TYPES.includes(
      params.type as (typeof BASE_TRANSACTION_TYPES)[number],
    )
  ) {
    throw new Error(
      `Unsupported base transaction type in Phase 6 modal: ${String(params.type)}`,
    );
  }

  const txId = params.id ?? generateUuidV4();
  const competenceMonth =
    params.competenceMonth ?? params.transactionDate.slice(0, 7);

  // Pre-validate pointer invariants via core before opening DB transaction
  assertTransactionInvariants({
    type: params.type,
    amountCents: params.amountCents,
    accountId: params.accountId ?? null,
    transferAccountId: params.transferAccountId ?? null,
    creditCardId: null,
    invoiceId: null,
    categoryId: params.categoryId ?? null,
  });

  return db.transaction((tx) => {
    const originAccount = tx
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.id, params.accountId!),
          eq(accounts.householdId, params.householdId),
          isNull(accounts.deletedAt),
        ),
      )
      .get();

    if (!originAccount) {
      throw new Error(
        `Origin account not found or inactive: ${String(params.accountId)}`,
      );
    }

    let destAccountOwnerUserId: string | null = null;
    if (params.type === 'TRANSFER') {
      const destAccount = tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, params.transferAccountId!),
            eq(accounts.householdId, params.householdId),
            isNull(accounts.deletedAt),
          ),
        )
        .get();

      if (!destAccount) {
        throw new Error(
          `Destination transfer account not found or inactive: ${String(params.transferAccountId)}`,
        );
      }
      destAccountOwnerUserId = destAccount.ownerUserId;
    } else {
      const cat = tx
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.id, params.categoryId!),
            eq(categories.householdId, params.householdId),
            isNull(categories.deletedAt),
          ),
        )
        .get();

      if (!cat) {
        throw new Error(
          `Category not found or inactive: ${String(params.categoryId)}`,
        );
      }

      const expectedKind = params.type === 'INCOME' ? 'INCOME' : 'EXPENSE';
      if (cat.kind !== expectedKind) {
        throw new Error(
          `Category kind mismatch: ${params.type} requires ${expectedKind} category, got ${cat.kind}`,
        );
      }
    }

    const effectiveContribution = resolveBaseTransactionContributionFlag({
      type: params.type,
      ownerUserId: params.ownerUserId,
      originAccountOwnerUserId: originAccount.ownerUserId,
      destAccountOwnerUserId,
      requestedContributionFlag: params.isHouseholdContribution,
    });

    return insertTransactionInTx(
      tx,
      {
        id: txId,
        householdId: params.householdId,
        createdByUserId: params.createdByUserId,
        ownerUserId: params.ownerUserId,
        type: params.type,
        status: params.status ?? 'CLEARED',
        amountCents: params.amountCents,
        transactionDate: params.transactionDate,
        competenceMonth,
        description: params.description,
        notes: params.notes ?? null,
        accountId: params.accountId,
        transferAccountId: params.transferAccountId ?? null,
        creditCardId: null,
        invoiceId: null,
        categoryId: params.categoryId ?? null,
        installmentPlanId: null,
        installmentNumber: null,
        totalInstallments: null,
        recurringRuleId: null,
        refundedTransactionId: params.refundedTransactionId ?? null,
        isHouseholdContribution: effectiveContribution,
        calendarEventId: null,
      },
      options,
    );
  });
}

export function listTransactionsByCompetenceMonth(
  db: AppDatabase,
  householdId: string,
  competenceMonth: string,
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): TransactionRow[] {
  const rows = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        eq(transactions.competenceMonth, competenceMonth),
        isNull(transactions.deletedAt),
      ),
    )
    .orderBy(
      desc(transactions.transactionDate),
      desc(transactions.hlcTimestamp),
    )
    .all();

  return rows.filter((r) => matchesOwnershipFilter(r.ownerUserId, ownerFilter));
}
