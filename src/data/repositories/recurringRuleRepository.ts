import { and, eq, isNull } from 'drizzle-orm';
import {
  type RecurringFrequency,
  type RecurringRuleInput,
  RecurringRuleInputSchema,
} from '@/core';
import type { AppDatabase } from '../db';
import { type RecurringRuleRow, recurringRules } from '../schema';
import {
  advanceTransactionHlc,
  buildFieldHlcMap,
  enqueueOrCoalesceOutbox,
  type MutationContextOptions,
} from './outbox';

const RECURRING_RULE_MUTABLE_COLUMNS = [
  'owner_user_id',
  'type',
  'account_id',
  'credit_card_id',
  'category_id',
  'description',
  'amount_cents',
  'frequency',
  'day_of_month',
  'start_month',
  'end_month',
  'is_active',
] as const;

export interface UpdateRecurringRulePatch {
  ownerUserId?: string | null;
  accountId?: string | null;
  creditCardId?: string | null;
  categoryId?: string;
  description?: string;
  amountCents?: number;
  frequency?: RecurringFrequency;
  dayOfMonth?: number;
  endMonth?: string | null;
  isActive?: boolean;
}

export function serializeRecurringRulePayload(
  row: RecurringRuleRow,
): Record<string, unknown> {
  return {
    id: row.id,
    household_id: row.householdId,
    created_by_user_id: row.createdByUserId,
    owner_user_id: row.ownerUserId,
    type: row.type,
    account_id: row.accountId,
    credit_card_id: row.creditCardId,
    category_id: row.categoryId,
    description: row.description,
    amount_cents: row.amountCents,
    frequency: row.frequency,
    day_of_month: row.dayOfMonth,
    start_month: row.startMonth,
    end_month: row.endMonth,
    is_active: row.isActive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
    hlc_timestamp: row.hlcTimestamp,
  };
}

export function createRecurringRule(
  db: AppDatabase,
  rawInput: RecurringRuleInput,
  options: MutationContextOptions = {},
): RecurringRuleRow {
  const input = RecurringRuleInputSchema.parse(rawInput);

  return db.transaction((tx) => {
    const meta = advanceTransactionHlc(tx, options);
    const fieldHlc = buildFieldHlcMap(
      RECURRING_RULE_MUTABLE_COLUMNS,
      meta.hlc,
    );

    tx.insert(recurringRules)
      .values({
        id: input.id,
        householdId: input.householdId,
        createdByUserId: input.createdByUserId,
        ownerUserId: input.ownerUserId,
        type: input.type,
        accountId: input.accountId,
        creditCardId: input.creditCardId,
        categoryId: input.categoryId,
        description: input.description,
        amountCents: input.amountCents,
        frequency: input.frequency,
        dayOfMonth: input.dayOfMonth,
        startMonth: input.startMonth,
        endMonth: input.endMonth,
        isActive: input.isActive,
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
      .from(recurringRules)
      .where(eq(recurringRules.id, input.id))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'recurring_rules',
      recordId: row.id,
      operation: 'UPSERT',
      payload: serializeRecurringRulePayload(row),
      fieldHlc,
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return row;
  });
}

export function updateRecurringRule(
  db: AppDatabase,
  ruleId: string,
  patch: UpdateRecurringRulePatch,
  options: MutationContextOptions = {},
): RecurringRuleRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, ruleId))
      .get();

    if (!existing || existing.deletedAt !== null) {
      throw new Error(`Active recurring rule not found: ${ruleId}`);
    }

    const candidate = RecurringRuleInputSchema.parse({
      id: existing.id,
      householdId: existing.householdId,
      createdByUserId: existing.createdByUserId,
      ownerUserId:
        patch.ownerUserId !== undefined
          ? patch.ownerUserId
          : existing.ownerUserId,
      type: existing.type,
      accountId:
        patch.accountId !== undefined ? patch.accountId : existing.accountId,
      creditCardId:
        patch.creditCardId !== undefined
          ? patch.creditCardId
          : existing.creditCardId,
      categoryId:
        patch.categoryId !== undefined ? patch.categoryId : existing.categoryId,
      description:
        patch.description !== undefined
          ? patch.description
          : existing.description,
      amountCents:
        patch.amountCents !== undefined
          ? patch.amountCents
          : existing.amountCents,
      frequency:
        patch.frequency !== undefined ? patch.frequency : existing.frequency,
      dayOfMonth:
        patch.dayOfMonth !== undefined ? patch.dayOfMonth : existing.dayOfMonth,
      startMonth: existing.startMonth,
      endMonth:
        patch.endMonth !== undefined ? patch.endMonth : existing.endMonth,
      isActive:
        patch.isActive !== undefined ? patch.isActive : existing.isActive,
    });

    const changedColumns: string[] = [];
    if (patch.ownerUserId !== undefined) changedColumns.push('owner_user_id');
    if (patch.accountId !== undefined) changedColumns.push('account_id');
    if (patch.creditCardId !== undefined) changedColumns.push('credit_card_id');
    if (patch.categoryId !== undefined) changedColumns.push('category_id');
    if (patch.description !== undefined) changedColumns.push('description');
    if (patch.amountCents !== undefined) changedColumns.push('amount_cents');
    if (patch.frequency !== undefined) changedColumns.push('frequency');
    if (patch.dayOfMonth !== undefined) changedColumns.push('day_of_month');
    if (patch.endMonth !== undefined) changedColumns.push('end_month');
    if (patch.isActive !== undefined) changedColumns.push('is_active');

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      changedColumns,
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(recurringRules)
      .set({
        ownerUserId: candidate.ownerUserId,
        accountId: candidate.accountId,
        creditCardId: candidate.creditCardId,
        categoryId: candidate.categoryId,
        description: candidate.description,
        amountCents: candidate.amountCents,
        frequency: candidate.frequency,
        dayOfMonth: candidate.dayOfMonth,
        endMonth: candidate.endMonth,
        isActive: candidate.isActive,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(recurringRules.id, ruleId))
      .run();

    const updated = tx
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, ruleId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'recurring_rules',
      recordId: updated.id,
      operation: 'UPSERT',
      payload: serializeRecurringRulePayload(updated),
      fieldHlc: buildFieldHlcMap(changedColumns, meta.hlc),
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return updated;
  });
}

export function softDeleteRecurringRule(
  db: AppDatabase,
  ruleId: string,
  options: MutationContextOptions = {},
): RecurringRuleRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, ruleId))
      .get();

    if (!existing) {
      throw new Error(`Recurring rule not found: ${ruleId}`);
    }

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      ['deleted_at'],
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(recurringRules)
      .set({
        deletedAt: meta.hlc,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(recurringRules.id, ruleId))
      .run();

    const deleted = tx
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, ruleId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'recurring_rules',
      recordId: deleted.id,
      operation: 'SOFT_DELETE',
      payload: serializeRecurringRulePayload(deleted),
      fieldHlc: { deleted_at: meta.hlc },
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return deleted;
  });
}

export function listActiveRecurringRules(
  db: AppDatabase,
  householdId: string,
): RecurringRuleRow[] {
  return db
    .select()
    .from(recurringRules)
    .where(
      and(
        eq(recurringRules.householdId, householdId),
        eq(recurringRules.isActive, true),
        isNull(recurringRules.deletedAt),
      ),
    )
    .all();
}
