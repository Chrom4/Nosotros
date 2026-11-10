import { and, eq, isNull } from 'drizzle-orm';
import {
  type AccountInput,
  AccountInputSchema,
  type AccountType,
  calculateAccountBalanceCents,
  type LedgerAccount,
  type LedgerTransaction,
  matchesOwnershipFilter,
  type OwnershipFilter,
} from '@/core';
import type { AppDatabase } from '../db';
import {
  type AccountRow,
  accounts,
  type TransactionRow,
  transactions,
} from '../schema';
import {
  advanceTransactionHlc,
  buildFieldHlcMap,
  enqueueOrCoalesceOutbox,
  type MutationContextOptions,
} from './outbox';

const ACCOUNT_MUTABLE_COLUMNS = [
  'owner_user_id',
  'name',
  'type',
  'initial_balance_cents',
  'include_in_net_worth',
  'is_archived',
] as const;

export interface UpdateAccountPatch {
  ownerUserId?: string | null;
  name?: string;
  type?: AccountType;
  initialBalanceCents?: number;
  includeInNetWorth?: boolean;
  isArchived?: boolean;
}

function serializeAccountPayload(row: AccountRow): Record<string, unknown> {
  return {
    id: row.id,
    household_id: row.householdId,
    owner_user_id: row.ownerUserId,
    name: row.name,
    type: row.type,
    initial_balance_cents: row.initialBalanceCents,
    include_in_net_worth: row.includeInNetWorth,
    is_archived: row.isArchived,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
    hlc_timestamp: row.hlcTimestamp,
  };
}

export function createAccount(
  db: AppDatabase,
  rawInput: AccountInput,
  options: MutationContextOptions = {},
): AccountRow {
  const input = AccountInputSchema.parse(rawInput);

  return db.transaction((tx) => {
    const meta = advanceTransactionHlc(tx, options);
    const fieldHlc = buildFieldHlcMap(ACCOUNT_MUTABLE_COLUMNS, meta.hlc);

    tx.insert(accounts)
      .values({
        id: input.id,
        householdId: input.householdId,
        ownerUserId: input.ownerUserId,
        name: input.name,
        type: input.type,
        initialBalanceCents: input.initialBalanceCents,
        includeInNetWorth: input.includeInNetWorth,
        isArchived: input.isArchived,
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
      .from(accounts)
      .where(eq(accounts.id, input.id))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'accounts',
      recordId: row.id,
      operation: 'UPSERT',
      payload: serializeAccountPayload(row),
      fieldHlc,
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return row;
  });
}

export function updateAccount(
  db: AppDatabase,
  accountId: string,
  patch: UpdateAccountPatch,
  options: MutationContextOptions = {},
): AccountRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();

    if (!existing || existing.deletedAt !== null) {
      throw new Error(`Active account not found: ${accountId}`);
    }

    const updatedCandidate = AccountInputSchema.parse({
      id: existing.id,
      householdId: existing.householdId,
      ownerUserId:
        patch.ownerUserId !== undefined
          ? patch.ownerUserId
          : existing.ownerUserId,
      name: patch.name !== undefined ? patch.name : existing.name,
      type: patch.type !== undefined ? patch.type : existing.type,
      initialBalanceCents:
        patch.initialBalanceCents !== undefined
          ? patch.initialBalanceCents
          : existing.initialBalanceCents,
      includeInNetWorth:
        patch.includeInNetWorth !== undefined
          ? patch.includeInNetWorth
          : existing.includeInNetWorth,
      isArchived:
        patch.isArchived !== undefined ? patch.isArchived : existing.isArchived,
    });

    const changedColumns: string[] = [];
    if (patch.ownerUserId !== undefined) changedColumns.push('owner_user_id');
    if (patch.name !== undefined) changedColumns.push('name');
    if (patch.type !== undefined) changedColumns.push('type');
    if (patch.initialBalanceCents !== undefined)
      changedColumns.push('initial_balance_cents');
    if (patch.includeInNetWorth !== undefined)
      changedColumns.push('include_in_net_worth');
    if (patch.isArchived !== undefined) changedColumns.push('is_archived');

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      changedColumns,
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(accounts)
      .set({
        ownerUserId: updatedCandidate.ownerUserId,
        name: updatedCandidate.name,
        type: updatedCandidate.type,
        initialBalanceCents: updatedCandidate.initialBalanceCents,
        includeInNetWorth: updatedCandidate.includeInNetWorth,
        isArchived: updatedCandidate.isArchived,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(accounts.id, accountId))
      .run();

    const updated = tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'accounts',
      recordId: updated.id,
      operation: 'UPSERT',
      payload: serializeAccountPayload(updated),
      fieldHlc: buildFieldHlcMap(changedColumns, meta.hlc),
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return updated;
  });
}

/**
 * Soft-deletes an account (`deleted_at = hlc`) and enqueues `SOFT_DELETE` in `sync_outbox`.
 * Physical DELETE on synced domain tables is strictly prohibited.
 */
export function softDeleteAccount(
  db: AppDatabase,
  accountId: string,
  options: MutationContextOptions = {},
): AccountRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();

    if (!existing) {
      throw new Error(`Account not found: ${accountId}`);
    }

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      ['deleted_at'],
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(accounts)
      .set({
        deletedAt: meta.hlc,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(accounts.id, accountId))
      .run();

    const deleted = tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'accounts',
      recordId: deleted.id,
      operation: 'SOFT_DELETE',
      payload: serializeAccountPayload(deleted),
      fieldHlc: { deleted_at: meta.hlc },
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return deleted;
  });
}

export function listActiveAccounts(
  db: AppDatabase,
  householdId: string,
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): AccountRow[] {
  const rows = db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.householdId, householdId),
        isNull(accounts.deletedAt),
        eq(accounts.isArchived, false),
      ),
    )
    .all();

  return rows.filter((r) => matchesOwnershipFilter(r.ownerUserId, ownerFilter));
}

export interface AccountWithBalance {
  account: AccountRow;
  balanceCents: number;
}

export function mapAccountRowToLedger(row: AccountRow): LedgerAccount {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    initialBalanceCents: row.initialBalanceCents,
    includeInNetWorth: row.includeInNetWorth,
    deletedAt: row.deletedAt,
  };
}

/**
 * Pure helper that pairs active accounts with their reconstructed balance (`calculateAccountBalanceCents`)
 * from a list of `TransactionRow`s, filtered by `ownerFilter`.
 */
export function computeAccountsWithBalances(
  accountRows: readonly AccountRow[],
  transactionRows: readonly TransactionRow[],
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): AccountWithBalance[] {
  const ledgerTxs: LedgerTransaction[] = transactionRows.map((t) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    amountCents: t.amountCents,
    transactionDate: t.transactionDate,
    competenceMonth: t.competenceMonth,
    description: t.description,
    accountId: t.accountId,
    transferAccountId: t.transferAccountId,
    creditCardId: t.creditCardId,
    invoiceId: t.invoiceId,
    categoryId: t.categoryId,
    ownerUserId: t.ownerUserId,
    installmentPlanId: t.installmentPlanId,
    installmentNumber: t.installmentNumber,
    totalInstallments: t.totalInstallments,
    recurringRuleId: t.recurringRuleId,
    refundedTransactionId: t.refundedTransactionId,
    isHouseholdContribution: t.isHouseholdContribution,
    deletedAt: t.deletedAt,
  }));

  return accountRows
    .filter(
      (acc) =>
        acc.deletedAt === null &&
        !acc.isArchived &&
        matchesOwnershipFilter(acc.ownerUserId, ownerFilter),
    )
    .map((acc) => ({
      account: acc,
      balanceCents: calculateAccountBalanceCents(
        acc.id,
        acc.initialBalanceCents,
        ledgerTxs,
      ),
    }));
}

export function listAccountsWithBalances(
  db: AppDatabase,
  householdId: string,
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): AccountWithBalance[] {
  const accountRows = listActiveAccounts(db, householdId, {
    mode: 'CONSOLIDATED',
  });
  const txRows = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        isNull(transactions.deletedAt),
      ),
    )
    .all();

  return computeAccountsWithBalances(accountRows, txRows, ownerFilter);
}
