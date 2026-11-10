import { and, eq, isNull } from 'drizzle-orm';
import { type BudgetInput, BudgetInputSchema } from '@/core';
import type { AppDatabase } from '../db';
import { type BudgetRow, budgets } from '../schema';
import {
  advanceTransactionHlc,
  buildFieldHlcMap,
  enqueueOrCoalesceOutbox,
  type MutationContextOptions,
} from './outbox';

const BUDGET_MUTABLE_COLUMNS = [
  'owner_user_id',
  'category_id',
  'competence_month',
  'limit_cents',
] as const;

export interface UpdateBudgetPatch {
  ownerUserId?: string | null;
  limitCents?: number;
}

function serializeBudgetPayload(row: BudgetRow): Record<string, unknown> {
  return {
    id: row.id,
    household_id: row.householdId,
    owner_user_id: row.ownerUserId,
    category_id: row.categoryId,
    competence_month: row.competenceMonth,
    limit_cents: row.limitCents,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
    hlc_timestamp: row.hlcTimestamp,
  };
}

export function createBudget(
  db: AppDatabase,
  rawInput: BudgetInput,
  options: MutationContextOptions = {},
): BudgetRow {
  const input = BudgetInputSchema.parse(rawInput);

  return db.transaction((tx) => {
    const meta = advanceTransactionHlc(tx, options);
    const fieldHlc = buildFieldHlcMap(BUDGET_MUTABLE_COLUMNS, meta.hlc);

    tx.insert(budgets)
      .values({
        id: input.id,
        householdId: input.householdId,
        ownerUserId: input.ownerUserId,
        categoryId: input.categoryId,
        competenceMonth: input.competenceMonth,
        limitCents: input.limitCents,
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
      .from(budgets)
      .where(eq(budgets.id, input.id))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'budgets',
      recordId: row.id,
      operation: 'UPSERT',
      payload: serializeBudgetPayload(row),
      fieldHlc,
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return row;
  });
}

export function updateBudget(
  db: AppDatabase,
  budgetId: string,
  patch: UpdateBudgetPatch,
  options: MutationContextOptions = {},
): BudgetRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(budgets)
      .where(eq(budgets.id, budgetId))
      .get();

    if (!existing || existing.deletedAt !== null) {
      throw new Error(`Active budget not found: ${budgetId}`);
    }

    const candidate = BudgetInputSchema.parse({
      id: existing.id,
      householdId: existing.householdId,
      ownerUserId:
        patch.ownerUserId !== undefined
          ? patch.ownerUserId
          : existing.ownerUserId,
      categoryId: existing.categoryId,
      competenceMonth: existing.competenceMonth,
      limitCents:
        patch.limitCents !== undefined ? patch.limitCents : existing.limitCents,
    });

    const changedColumns: string[] = [];
    if (patch.ownerUserId !== undefined) changedColumns.push('owner_user_id');
    if (patch.limitCents !== undefined) changedColumns.push('limit_cents');

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      changedColumns,
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(budgets)
      .set({
        ownerUserId: candidate.ownerUserId,
        limitCents: candidate.limitCents,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(budgets.id, budgetId))
      .run();

    const updated = tx
      .select()
      .from(budgets)
      .where(eq(budgets.id, budgetId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'budgets',
      recordId: updated.id,
      operation: 'UPSERT',
      payload: serializeBudgetPayload(updated),
      fieldHlc: buildFieldHlcMap(changedColumns, meta.hlc),
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return updated;
  });
}

export function softDeleteBudget(
  db: AppDatabase,
  budgetId: string,
  options: MutationContextOptions = {},
): BudgetRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(budgets)
      .where(eq(budgets.id, budgetId))
      .get();

    if (!existing) {
      throw new Error(`Budget not found: ${budgetId}`);
    }

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      ['deleted_at'],
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(budgets)
      .set({
        deletedAt: meta.hlc,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(budgets.id, budgetId))
      .run();

    const deleted = tx
      .select()
      .from(budgets)
      .where(eq(budgets.id, budgetId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'budgets',
      recordId: deleted.id,
      operation: 'SOFT_DELETE',
      payload: serializeBudgetPayload(deleted),
      fieldHlc: { deleted_at: meta.hlc },
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return deleted;
  });
}

export function listActiveBudgets(
  db: AppDatabase,
  householdId: string,
  competenceMonth: string,
): BudgetRow[] {
  return db
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
}
