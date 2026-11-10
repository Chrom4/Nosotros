import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import {
  assertTransactionInvariants,
  assertValidCents,
  calculateCreditCardAvailableLimitCents,
  calculateInvoiceDebtCents,
  computeInvoiceCycleDates,
  type CreditCardInput,
  CreditCardInputSchema,
  type CreditCardInvoiceInput,
  CreditCardInvoiceInputSchema,
  generateInvoiceId,
  type InvoiceStatus,
  type LedgerCreditCard,
  type LedgerInvoice,
  type LedgerTransaction,
  matchesOwnershipFilter,
  type OwnershipFilter,
  resolveInvoiceCompetenceMonth,
} from '@/core';
import type { AppDatabase, DbExecutor } from '../db';
import {
  accounts,
  categories,
  type CreditCardInvoiceRow,
  creditCardInvoices,
  type CreditCardRow,
  creditCards,
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
import { insertTransactionInTx } from './transactionRepository';

const CREDIT_CARD_MUTABLE_COLUMNS = [
  'owner_user_id',
  'default_payment_account_id',
  'name',
  'limit_cents',
  'closing_day',
  'due_day',
  'is_archived',
] as const;

const INVOICE_MUTABLE_COLUMNS = [
  'credit_card_id',
  'competence_month',
  'closing_date',
  'due_date',
  'status',
] as const;

export interface UpdateCreditCardPatch {
  ownerUserId?: string | null;
  defaultPaymentAccountId?: string;
  name?: string;
  limitCents?: number;
  closingDay?: number;
  dueDay?: number;
  isArchived?: boolean;
}

export function serializeCreditCardPayload(
  row: CreditCardRow,
): Record<string, unknown> {
  return {
    id: row.id,
    household_id: row.householdId,
    owner_user_id: row.ownerUserId,
    default_payment_account_id: row.defaultPaymentAccountId,
    name: row.name,
    limit_cents: row.limitCents,
    closing_day: row.closingDay,
    due_day: row.dueDay,
    is_archived: row.isArchived,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
    hlc_timestamp: row.hlcTimestamp,
  };
}

export function serializeInvoicePayload(
  row: CreditCardInvoiceRow,
): Record<string, unknown> {
  return {
    id: row.id,
    household_id: row.householdId,
    credit_card_id: row.creditCardId,
    competence_month: row.competenceMonth,
    closing_date: row.closingDate,
    due_date: row.dueDate,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
    hlc_timestamp: row.hlcTimestamp,
  };
}

export function mapTransactionRowToLedger(
  row: TransactionRow,
): LedgerTransaction {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    amountCents: row.amountCents,
    transactionDate: row.transactionDate,
    competenceMonth: row.competenceMonth,
    description: row.description,
    accountId: row.accountId,
    transferAccountId: row.transferAccountId,
    creditCardId: row.creditCardId,
    invoiceId: row.invoiceId,
    categoryId: row.categoryId,
    ownerUserId: row.ownerUserId,
    installmentPlanId: row.installmentPlanId,
    installmentNumber: row.installmentNumber,
    totalInstallments: row.totalInstallments,
    recurringRuleId: row.recurringRuleId,
    refundedTransactionId: row.refundedTransactionId,
    isHouseholdContribution: row.isHouseholdContribution,
    deletedAt: row.deletedAt,
  };
}

export function mapInvoiceRowToLedger(
  row: CreditCardInvoiceRow,
): LedgerInvoice {
  return {
    id: row.id,
    creditCardId: row.creditCardId,
    competenceMonth: row.competenceMonth,
    closingDate: row.closingDate,
    dueDate: row.dueDate,
    status: row.status,
    deletedAt: row.deletedAt,
  };
}

export function mapCreditCardRowToLedger(row: CreditCardRow): LedgerCreditCard {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    limitCents: row.limitCents,
    closingDay: row.closingDay,
    dueDay: row.dueDay,
    deletedAt: row.deletedAt,
  };
}

export function createCreditCard(
  db: AppDatabase,
  rawInput: CreditCardInput,
  options: MutationContextOptions = {},
): CreditCardRow {
  const input = CreditCardInputSchema.parse(rawInput);

  return db.transaction((tx) => {
    const meta = advanceTransactionHlc(tx, options);
    const fieldHlc = buildFieldHlcMap(CREDIT_CARD_MUTABLE_COLUMNS, meta.hlc);

    tx.insert(creditCards)
      .values({
        id: input.id,
        householdId: input.householdId,
        ownerUserId: input.ownerUserId,
        defaultPaymentAccountId: input.defaultPaymentAccountId,
        name: input.name,
        limitCents: input.limitCents,
        closingDay: input.closingDay,
        dueDay: input.dueDay,
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
      .from(creditCards)
      .where(eq(creditCards.id, input.id))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'credit_cards',
      recordId: row.id,
      operation: 'UPSERT',
      payload: serializeCreditCardPayload(row),
      fieldHlc,
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return row;
  });
}

/**
 * Updates a credit card's configuration (`name`, `limitCents`, `closingDay`, `dueDay`, `defaultPaymentAccountId`, `ownerUserId`).
 * Note (TEST-FIN-05): Updating `closingDay` or `dueDay` on `credit_cards` never mutates already-persisted
 * rows in `credit_card_invoices`; historical invoices preserve their original `closingDate` and `dueDate`.
 */
export function updateCreditCard(
  db: AppDatabase,
  creditCardId: string,
  patch: UpdateCreditCardPatch,
  options: MutationContextOptions = {},
): CreditCardRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(creditCards)
      .where(eq(creditCards.id, creditCardId))
      .get();

    if (!existing || existing.deletedAt !== null) {
      throw new Error(`Active credit card not found: ${creditCardId}`);
    }

    const updatedCandidate = CreditCardInputSchema.parse({
      id: existing.id,
      householdId: existing.householdId,
      ownerUserId:
        patch.ownerUserId !== undefined
          ? patch.ownerUserId
          : existing.ownerUserId,
      defaultPaymentAccountId:
        patch.defaultPaymentAccountId !== undefined
          ? patch.defaultPaymentAccountId
          : existing.defaultPaymentAccountId,
      name: patch.name !== undefined ? patch.name : existing.name,
      limitCents:
        patch.limitCents !== undefined ? patch.limitCents : existing.limitCents,
      closingDay:
        patch.closingDay !== undefined ? patch.closingDay : existing.closingDay,
      dueDay: patch.dueDay !== undefined ? patch.dueDay : existing.dueDay,
      isArchived:
        patch.isArchived !== undefined ? patch.isArchived : existing.isArchived,
    });

    const changedColumns: string[] = [];
    if (patch.ownerUserId !== undefined) changedColumns.push('owner_user_id');
    if (patch.defaultPaymentAccountId !== undefined)
      changedColumns.push('default_payment_account_id');
    if (patch.name !== undefined) changedColumns.push('name');
    if (patch.limitCents !== undefined) changedColumns.push('limit_cents');
    if (patch.closingDay !== undefined) changedColumns.push('closing_day');
    if (patch.dueDay !== undefined) changedColumns.push('due_day');
    if (patch.isArchived !== undefined) changedColumns.push('is_archived');

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      changedColumns,
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(creditCards)
      .set({
        ownerUserId: updatedCandidate.ownerUserId,
        defaultPaymentAccountId: updatedCandidate.defaultPaymentAccountId,
        name: updatedCandidate.name,
        limitCents: updatedCandidate.limitCents,
        closingDay: updatedCandidate.closingDay,
        dueDay: updatedCandidate.dueDay,
        isArchived: updatedCandidate.isArchived,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(creditCards.id, creditCardId))
      .run();

    const updated = tx
      .select()
      .from(creditCards)
      .where(eq(creditCards.id, creditCardId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'credit_cards',
      recordId: updated.id,
      operation: 'UPSERT',
      payload: serializeCreditCardPayload(updated),
      fieldHlc: buildFieldHlcMap(changedColumns, meta.hlc),
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return updated;
  });
}

export function softDeleteCreditCard(
  db: AppDatabase,
  creditCardId: string,
  options: MutationContextOptions = {},
): CreditCardRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(creditCards)
      .where(eq(creditCards.id, creditCardId))
      .get();

    if (!existing) {
      throw new Error(`Credit card not found: ${creditCardId}`);
    }

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      ['deleted_at'],
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(creditCards)
      .set({
        deletedAt: meta.hlc,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(creditCards.id, creditCardId))
      .run();

    const deleted = tx
      .select()
      .from(creditCards)
      .where(eq(creditCards.id, creditCardId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'credit_cards',
      recordId: deleted.id,
      operation: 'SOFT_DELETE',
      payload: serializeCreditCardPayload(deleted),
      fieldHlc: { deleted_at: meta.hlc },
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return deleted;
  });
}

export function upsertInvoiceInTx(
  tx: DbExecutor,
  rawInput: CreditCardInvoiceInput,
  options: MutationContextOptions = {},
): CreditCardInvoiceRow {
  const input = CreditCardInvoiceInputSchema.parse(rawInput);

  // Check by (creditCardId, competenceMonth) first, then by id, to preserve historical cycle dates (TEST-FIN-05)
  const existingByCompetence = tx
    .select()
    .from(creditCardInvoices)
    .where(
      and(
        eq(creditCardInvoices.creditCardId, input.creditCardId),
        eq(creditCardInvoices.competenceMonth, input.competenceMonth),
      ),
    )
    .get();

  if (existingByCompetence && existingByCompetence.deletedAt === null) {
    return existingByCompetence;
  }

  const existingById = tx
    .select()
    .from(creditCardInvoices)
    .where(eq(creditCardInvoices.id, input.id))
    .get();

  if (existingById && existingById.deletedAt === null) {
    return existingById;
  }

  const targetId = existingByCompetence?.id ?? existingById?.id ?? input.id;
  const meta = advanceTransactionHlc(tx, options);
  const fieldHlc = buildFieldHlcMap(INVOICE_MUTABLE_COLUMNS, meta.hlc);

  tx.insert(creditCardInvoices)
    .values({
      id: targetId,
      householdId: input.householdId,
      creditCardId: input.creditCardId,
      competenceMonth: input.competenceMonth,
      closingDate: input.closingDate,
      dueDate: input.dueDate,
      status: input.status,
      createdAt: meta.isoNow,
      updatedAt: meta.isoNow,
      deletedAt: null,
      hlcTimestamp: meta.hlc,
      fieldHlc,
      serverSeq: 0,
    })
    .onConflictDoUpdate({
      target: creditCardInvoices.id,
      set: {
        status: input.status,
        deletedAt: null,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc,
      },
    })
    .run();

  const row = tx
    .select()
    .from(creditCardInvoices)
    .where(eq(creditCardInvoices.id, targetId))
    .get()!;

  enqueueOrCoalesceOutbox(tx, {
    mutationId: options.mutationId,
    batchId: meta.batchId,
    tableName: 'credit_card_invoices',
    recordId: row.id,
    operation: 'UPSERT',
    payload: serializeInvoicePayload(row),
    fieldHlc,
    hlcTimestamp: meta.hlc,
    createdAt: meta.isoNow,
  });

  return row;
}

export function createCreditCardInvoice(
  db: AppDatabase,
  rawInput: CreditCardInvoiceInput,
  options: MutationContextOptions = {},
): CreditCardInvoiceRow {
  return db.transaction((tx) => upsertInvoiceInTx(tx, rawInput, options));
}

/**
 * Ensures an invoice exists for `(creditCardId, competenceMonth)` inside an active transaction.
 * If an active invoice already exists, returns it untouched so its historical `closingDate` and `dueDate`
 * remain immutable even if the card's `closingDay` or `dueDay` changed later (TEST-FIN-05).
 */
export function ensureCardInvoiceForCompetenceInTx(
  tx: DbExecutor,
  params: {
    householdId: string;
    creditCardId: string;
    competenceMonth: string;
    invoiceId?: string;
  },
  options: MutationContextOptions = {},
): CreditCardInvoiceRow {
  const existing = tx
    .select()
    .from(creditCardInvoices)
    .where(
      and(
        eq(creditCardInvoices.householdId, params.householdId),
        eq(creditCardInvoices.creditCardId, params.creditCardId),
        eq(creditCardInvoices.competenceMonth, params.competenceMonth),
        isNull(creditCardInvoices.deletedAt),
      ),
    )
    .get();

  if (existing) {
    return existing;
  }

  const card = tx
    .select()
    .from(creditCards)
    .where(
      and(
        eq(creditCards.id, params.creditCardId),
        eq(creditCards.householdId, params.householdId),
        isNull(creditCards.deletedAt),
      ),
    )
    .get();

  if (!card) {
    throw new Error(`Active credit card not found: ${params.creditCardId}`);
  }

  const { closingDate, dueDate } = computeInvoiceCycleDates(
    params.competenceMonth,
    card.closingDay,
    card.dueDay,
  );
  const deterministicId =
    params.invoiceId ??
    generateInvoiceId(params.creditCardId, params.competenceMonth);

  return upsertInvoiceInTx(
    tx,
    {
      id: deterministicId,
      householdId: params.householdId,
      creditCardId: params.creditCardId,
      competenceMonth: params.competenceMonth,
      closingDate,
      dueDate,
      status: 'OPEN',
    },
    options,
  );
}

export function ensureCardInvoiceForCompetence(
  db: AppDatabase,
  params: {
    householdId: string;
    creditCardId: string;
    competenceMonth: string;
    invoiceId?: string;
  },
  options: MutationContextOptions = {},
): CreditCardInvoiceRow {
  return db.transaction((tx) =>
    ensureCardInvoiceForCompetenceInTx(tx, params, options),
  );
}

export function updateCreditCardInvoiceStatusInTx(
  tx: DbExecutor,
  invoiceId: string,
  status: InvoiceStatus,
  options: MutationContextOptions = {},
): CreditCardInvoiceRow {
  const existing = tx
    .select()
    .from(creditCardInvoices)
    .where(eq(creditCardInvoices.id, invoiceId))
    .get();

  if (!existing || existing.deletedAt !== null) {
    throw new Error(`Active credit card invoice not found: ${invoiceId}`);
  }

  const meta = advanceTransactionHlc(tx, options);
  const nextFieldHlc = buildFieldHlcMap(
    ['status'],
    meta.hlc,
    existing.fieldHlc,
  );

  tx.update(creditCardInvoices)
    .set({
      status,
      updatedAt: meta.isoNow,
      hlcTimestamp: meta.hlc,
      fieldHlc: nextFieldHlc,
    })
    .where(eq(creditCardInvoices.id, invoiceId))
    .run();

  const updated = tx
    .select()
    .from(creditCardInvoices)
    .where(eq(creditCardInvoices.id, invoiceId))
    .get()!;

  enqueueOrCoalesceOutbox(tx, {
    mutationId: options.mutationId,
    batchId: meta.batchId,
    tableName: 'credit_card_invoices',
    recordId: updated.id,
    operation: 'UPSERT',
    payload: serializeInvoicePayload(updated),
    fieldHlc: { status: meta.hlc },
    hlcTimestamp: meta.hlc,
    createdAt: meta.isoNow,
  });

  return updated;
}

export function updateCreditCardInvoiceStatus(
  db: AppDatabase,
  invoiceId: string,
  status: InvoiceStatus,
  options: MutationContextOptions = {},
): CreditCardInvoiceRow {
  return db.transaction((tx) =>
    updateCreditCardInvoiceStatusInTx(tx, invoiceId, status, options),
  );
}

export function closeCreditCardInvoice(
  db: AppDatabase,
  invoiceId: string,
  options: MutationContextOptions = {},
): CreditCardInvoiceRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(creditCardInvoices)
      .where(eq(creditCardInvoices.id, invoiceId))
      .get();

    if (!existing || existing.deletedAt !== null) {
      throw new Error(`Active credit card invoice not found: ${invoiceId}`);
    }
    if (existing.status === 'PAID') {
      throw new Error('Cannot close an invoice that is already PAID');
    }

    return updateCreditCardInvoiceStatusInTx(tx, invoiceId, 'CLOSED', options);
  });
}

export function reopenCreditCardInvoice(
  db: AppDatabase,
  invoiceId: string,
  options: MutationContextOptions = {},
): CreditCardInvoiceRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(creditCardInvoices)
      .where(eq(creditCardInvoices.id, invoiceId))
      .get();

    if (!existing || existing.deletedAt !== null) {
      throw new Error(`Active credit card invoice not found: ${invoiceId}`);
    }

    return updateCreditCardInvoiceStatusInTx(tx, invoiceId, 'OPEN', options);
  });
}

export interface CreateCreditCardPurchaseParams {
  id?: string;
  householdId: string;
  createdByUserId: string;
  ownerUserId: string | null;
  creditCardId: string;
  categoryId: string;
  amountCents: number;
  transactionDate: string; // YYYY-MM-DD
  competenceMonth?: string; // Optional override; defaults to resolveInvoiceCompetenceMonth(transactionDate, card.closingDay)
  invoiceId?: string;
  description: string;
  notes?: string | null;
  isHouseholdContribution?: boolean;
}

export interface CreateCreditCardPurchaseResult {
  transaction: TransactionRow;
  invoice: CreditCardInvoiceRow;
  batchId: string;
}

/**
 * Creates a one-shot `CREDIT_PURCHASE` on a credit card, automatically resolving the invoice competence
 * month from `transactionDate` and `card.closingDay` (TEST-FIN-05), ensuring the `credit_card_invoices`
 * row exists in the same atomic transaction (`batchId`), and never touching bank account balances (TEST-FIN-02).
 */
export function createCreditCardPurchase(
  db: AppDatabase,
  params: CreateCreditCardPurchaseParams,
  options: MutationContextOptions = {},
): CreateCreditCardPurchaseResult {
  assertValidCents(params.amountCents, 'amountCents');
  const sharedBatchId = options.batchId ?? generateUuidV4();
  const txId = params.id ?? generateUuidV4();

  return db.transaction((tx) => {
    const card = tx
      .select()
      .from(creditCards)
      .where(
        and(
          eq(creditCards.id, params.creditCardId),
          eq(creditCards.householdId, params.householdId),
          isNull(creditCards.deletedAt),
        ),
      )
      .get();

    if (!card) {
      throw new Error(`Active credit card not found: ${params.creditCardId}`);
    }

    const cat = tx
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.id, params.categoryId),
          eq(categories.householdId, params.householdId),
          isNull(categories.deletedAt),
        ),
      )
      .get();

    if (!cat) {
      throw new Error(`Active category not found: ${params.categoryId}`);
    }
    if (cat.kind !== 'EXPENSE') {
      throw new Error(
        `CREDIT_PURCHASE requires an EXPENSE category, got ${cat.kind}`,
      );
    }

    const competenceMonth =
      params.competenceMonth ??
      resolveInvoiceCompetenceMonth(params.transactionDate, card.closingDay);

    const invoice = ensureCardInvoiceForCompetenceInTx(
      tx,
      {
        householdId: params.householdId,
        creditCardId: card.id,
        competenceMonth,
        invoiceId: params.invoiceId,
      },
      {
        ...options,
        batchId: sharedBatchId,
        mutationId: undefined,
      },
    );

    if (invoice.status === 'CLOSED' || invoice.status === 'PAID') {
      throw new Error(
        `Cannot record new credit card purchase on ${invoice.status} invoice (${invoice.competenceMonth})`,
      );
    }

    // DEC-02: Shared expense (ownerUserId === null) paid on an individual card (card.ownerUserId !== null)
    const effectiveContribution =
      params.ownerUserId === null && card.ownerUserId !== null
        ? true
        : Boolean(params.isHouseholdContribution ?? false);

    const txRow = insertTransactionInTx(
      tx,
      {
        id: txId,
        householdId: params.householdId,
        createdByUserId: params.createdByUserId,
        ownerUserId: params.ownerUserId,
        type: 'CREDIT_PURCHASE',
        status: 'CLEARED',
        amountCents: params.amountCents,
        transactionDate: params.transactionDate,
        competenceMonth: invoice.competenceMonth,
        description: params.description,
        notes: params.notes ?? null,
        accountId: null,
        transferAccountId: null,
        creditCardId: card.id,
        invoiceId: invoice.id,
        categoryId: cat.id,
        installmentPlanId: null,
        installmentNumber: null,
        totalInstallments: null,
        recurringRuleId: null,
        refundedTransactionId: null,
        isHouseholdContribution: effectiveContribution,
        calendarEventId: null,
      },
      {
        ...options,
        batchId: sharedBatchId,
        mutationId: undefined,
      },
    );

    return {
      transaction: txRow,
      invoice,
      batchId: sharedBatchId,
    };
  });
}

export interface CreateCreditCardRefundParams {
  id?: string;
  householdId: string;
  createdByUserId: string;
  ownerUserId: string | null;
  creditCardId: string;
  categoryId: string;
  amountCents: number;
  transactionDate: string; // YYYY-MM-DD
  competenceMonth?: string;
  invoiceId?: string;
  description: string;
  notes?: string | null;
  refundedTransactionId?: string | null;
  isHouseholdContribution?: boolean;
}

/**
 * Records a `CREDIT_REFUND` (estorno na fatura) against an open invoice without touching bank balance
 * or inflating `INCOME` (TEST-FIN-04).
 */
export function createCreditCardRefund(
  db: AppDatabase,
  params: CreateCreditCardRefundParams,
  options: MutationContextOptions = {},
): CreateCreditCardPurchaseResult {
  assertValidCents(params.amountCents, 'amountCents');
  const sharedBatchId = options.batchId ?? generateUuidV4();
  const txId = params.id ?? generateUuidV4();

  return db.transaction((tx) => {
    const card = tx
      .select()
      .from(creditCards)
      .where(
        and(
          eq(creditCards.id, params.creditCardId),
          eq(creditCards.householdId, params.householdId),
          isNull(creditCards.deletedAt),
        ),
      )
      .get();

    if (!card) {
      throw new Error(`Active credit card not found: ${params.creditCardId}`);
    }

    const cat = tx
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.id, params.categoryId),
          eq(categories.householdId, params.householdId),
          isNull(categories.deletedAt),
        ),
      )
      .get();

    if (!cat) {
      throw new Error(`Active category not found: ${params.categoryId}`);
    }
    if (cat.kind !== 'EXPENSE') {
      throw new Error(
        `CREDIT_REFUND requires an EXPENSE category, got ${cat.kind}`,
      );
    }

    const competenceMonth =
      params.competenceMonth ??
      resolveInvoiceCompetenceMonth(params.transactionDate, card.closingDay);

    const invoice = ensureCardInvoiceForCompetenceInTx(
      tx,
      {
        householdId: params.householdId,
        creditCardId: card.id,
        competenceMonth,
        invoiceId: params.invoiceId,
      },
      {
        ...options,
        batchId: sharedBatchId,
        mutationId: undefined,
      },
    );

    if (invoice.status === 'PAID') {
      throw new Error(
        `Cannot record credit refund on an already PAID invoice (${invoice.competenceMonth})`,
      );
    }

    const effectiveContribution =
      params.ownerUserId === null && card.ownerUserId !== null
        ? true
        : Boolean(params.isHouseholdContribution ?? false);

    const txRow = insertTransactionInTx(
      tx,
      {
        id: txId,
        householdId: params.householdId,
        createdByUserId: params.createdByUserId,
        ownerUserId: params.ownerUserId,
        type: 'CREDIT_REFUND',
        status: 'CLEARED',
        amountCents: params.amountCents,
        transactionDate: params.transactionDate,
        competenceMonth: invoice.competenceMonth,
        description: params.description,
        notes: params.notes ?? null,
        accountId: null,
        transferAccountId: null,
        creditCardId: card.id,
        invoiceId: invoice.id,
        categoryId: cat.id,
        installmentPlanId: null,
        installmentNumber: null,
        totalInstallments: null,
        recurringRuleId: null,
        refundedTransactionId: params.refundedTransactionId ?? null,
        isHouseholdContribution: effectiveContribution,
        calendarEventId: null,
      },
      {
        ...options,
        batchId: sharedBatchId,
        mutationId: undefined,
      },
    );

    return {
      transaction: txRow,
      invoice,
      batchId: sharedBatchId,
    };
  });
}

export interface PayCreditCardInvoiceParams {
  id?: string;
  householdId: string;
  createdByUserId: string;
  invoiceId: string;
  /**
   * Bank account used to pay the invoice. Defaults to `card.defaultPaymentAccountId`.
   */
  accountId?: string;
  /**
   * Amount to pay in cents (`> 0`). When omitted, pays the full remaining debt of the invoice.
   */
  amountCents?: number;
  paymentDate: string; // YYYY-MM-DD
  competenceMonth?: string; // Defaults to paymentDate.slice(0, 7)
  description?: string;
  notes?: string | null;
  ownerUserId?: string | null;
}

export interface PayCreditCardInvoiceResult {
  paymentTransaction: TransactionRow;
  invoice: CreditCardInvoiceRow;
  paidAmountCents: number;
  remainingDebtCents: number;
  isFullPayment: boolean;
  batchId: string;
}

/**
 * Executes a partial or full credit card invoice payment (`INVOICE_PAYMENT`):
 * - Requires `accountId NOT NULL`, `creditCardId NOT NULL`, `invoiceId NOT NULL`, `categoryId NULL`.
 * - Reduces bank account balance and reduces invoice debt without adding to monthly expenses (TEST-FIN-02).
 * - Automatically marks the invoice `'PAID'` when `remainingDebtCents === 0`, sharing a single outbox `batchId`.
 */
export function payCreditCardInvoice(
  db: AppDatabase,
  params: PayCreditCardInvoiceParams,
  options: MutationContextOptions = {},
): PayCreditCardInvoiceResult {
  const sharedBatchId = options.batchId ?? generateUuidV4();
  const txId = params.id ?? generateUuidV4();

  return db.transaction((tx) => {
    const invoice = tx
      .select()
      .from(creditCardInvoices)
      .where(
        and(
          eq(creditCardInvoices.id, params.invoiceId),
          eq(creditCardInvoices.householdId, params.householdId),
          isNull(creditCardInvoices.deletedAt),
        ),
      )
      .get();

    if (!invoice) {
      throw new Error(
        `Active credit card invoice not found: ${params.invoiceId}`,
      );
    }

    const card = tx
      .select()
      .from(creditCards)
      .where(
        and(
          eq(creditCards.id, invoice.creditCardId),
          eq(creditCards.householdId, params.householdId),
          isNull(creditCards.deletedAt),
        ),
      )
      .get();

    if (!card) {
      throw new Error(`Active credit card not found: ${invoice.creditCardId}`);
    }

    const targetAccountId = params.accountId ?? card.defaultPaymentAccountId;
    const account = tx
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.id, targetAccountId),
          eq(accounts.householdId, params.householdId),
          isNull(accounts.deletedAt),
        ),
      )
      .get();

    if (!account) {
      throw new Error(`Active payment account not found: ${targetAccountId}`);
    }

    const invoiceTxRows = tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, params.householdId),
          eq(transactions.invoiceId, invoice.id),
          isNull(transactions.deletedAt),
        ),
      )
      .all();

    const currentDebtCents = calculateInvoiceDebtCents(
      invoice.id,
      invoiceTxRows.map(mapTransactionRowToLedger),
    );

    if (currentDebtCents <= 0) {
      throw new Error(
        `Invoice ${invoice.competenceMonth} has no remaining unpaid debt to settle`,
      );
    }

    const paymentAmountCents = params.amountCents ?? currentDebtCents;
    assertValidCents(paymentAmountCents, 'paymentAmountCents');

    if (paymentAmountCents > currentDebtCents) {
      throw new Error(
        `Payment amount (${paymentAmountCents}) cannot exceed remaining invoice debt (${currentDebtCents})`,
      );
    }

    const competenceMonth =
      params.competenceMonth ?? params.paymentDate.slice(0, 7);
    const ownerUserId =
      params.ownerUserId !== undefined ? params.ownerUserId : card.ownerUserId;
    const description =
      params.description?.trim() ||
      (paymentAmountCents === currentDebtCents
        ? `Pagamento Fatura ${card.name} (${invoice.competenceMonth})`
        : `Pagamento Parcial Fatura ${card.name} (${invoice.competenceMonth})`);

    // Validate pointer invariants before insert (accountId != null, creditCardId != null, invoiceId != null, categoryId == null)
    assertTransactionInvariants({
      type: 'INVOICE_PAYMENT',
      amountCents: paymentAmountCents,
      accountId: account.id,
      transferAccountId: null,
      creditCardId: card.id,
      invoiceId: invoice.id,
      categoryId: null,
    });

    const paymentTx = insertTransactionInTx(
      tx,
      {
        id: txId,
        householdId: params.householdId,
        createdByUserId: params.createdByUserId,
        ownerUserId,
        type: 'INVOICE_PAYMENT',
        status: 'CLEARED',
        amountCents: paymentAmountCents,
        transactionDate: params.paymentDate,
        competenceMonth,
        description,
        notes: params.notes ?? null,
        accountId: account.id,
        transferAccountId: null,
        creditCardId: card.id,
        invoiceId: invoice.id,
        categoryId: null,
        installmentPlanId: null,
        installmentNumber: null,
        totalInstallments: null,
        recurringRuleId: null,
        refundedTransactionId: null,
        isHouseholdContribution: false,
        calendarEventId: null,
      },
      {
        ...options,
        batchId: sharedBatchId,
        mutationId: undefined,
      },
    );

    const remainingDebtCents = currentDebtCents - paymentAmountCents;
    const isFullPayment = remainingDebtCents === 0;

    let updatedInvoice = invoice;
    if (isFullPayment && invoice.status !== 'PAID') {
      updatedInvoice = updateCreditCardInvoiceStatusInTx(
        tx,
        invoice.id,
        'PAID',
        {
          ...options,
          batchId: sharedBatchId,
          mutationId: undefined,
        },
      );
    }

    return {
      paymentTransaction: paymentTx,
      invoice: updatedInvoice,
      paidAmountCents: paymentAmountCents,
      remainingDebtCents,
      isFullPayment,
      batchId: sharedBatchId,
    };
  });
}

export function listActiveCreditCards(
  db: AppDatabase,
  householdId: string,
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): CreditCardRow[] {
  const rows = db
    .select()
    .from(creditCards)
    .where(
      and(
        eq(creditCards.householdId, householdId),
        isNull(creditCards.deletedAt),
        eq(creditCards.isArchived, false),
      ),
    )
    .orderBy(asc(creditCards.name))
    .all();

  return rows.filter((r) => matchesOwnershipFilter(r.ownerUserId, ownerFilter));
}

export interface CreditCardWithLimitSummary {
  card: CreditCardRow;
  availableLimitCents: number;
  usedLimitCents: number;
  openInvoicesCount: number;
}

export function computeCreditCardsWithLimits(
  cardRows: readonly CreditCardRow[],
  invoiceRows: readonly CreditCardInvoiceRow[],
  txRows: readonly TransactionRow[],
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): CreditCardWithLimitSummary[] {
  const ledgerInvoices = invoiceRows.map(mapInvoiceRowToLedger);
  const ledgerTxs = txRows.map(mapTransactionRowToLedger);

  return cardRows
    .filter(
      (c) =>
        c.deletedAt === null &&
        !c.isArchived &&
        matchesOwnershipFilter(c.ownerUserId, ownerFilter),
    )
    .map((card) => {
      const availableLimitCents = calculateCreditCardAvailableLimitCents(
        { id: card.id, limitCents: card.limitCents },
        ledgerTxs,
        ledgerInvoices,
      );
      const usedLimitCents = card.limitCents - availableLimitCents;
      const openInvoicesCount = invoiceRows.filter(
        (inv) =>
          inv.deletedAt === null &&
          inv.creditCardId === card.id &&
          inv.status !== 'PAID',
      ).length;

      return {
        card,
        availableLimitCents,
        usedLimitCents,
        openInvoicesCount,
      };
    });
}

export function listCreditCardsWithLimits(
  db: AppDatabase,
  householdId: string,
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): CreditCardWithLimitSummary[] {
  const cardRows = db
    .select()
    .from(creditCards)
    .where(
      and(
        eq(creditCards.householdId, householdId),
        isNull(creditCards.deletedAt),
      ),
    )
    .orderBy(asc(creditCards.name))
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

  return computeCreditCardsWithLimits(
    cardRows,
    invoiceRows,
    txRows,
    ownerFilter,
  );
}

export interface InvoiceWithSummary {
  invoice: CreditCardInvoiceRow;
  card: CreditCardRow | null;
  debtCents: number;
  chargesCents: number;
  refundsCents: number;
  paidCents: number;
  transactions: TransactionRow[];
}

export function computeInvoicesWithDetails(
  invoiceRows: readonly CreditCardInvoiceRow[],
  cardRows: readonly CreditCardRow[],
  txRows: readonly TransactionRow[],
  options: {
    creditCardId?: string | null;
    statusFilter?: InvoiceStatus | 'ALL';
    competenceMonth?: string | null;
    ownerFilter?: OwnershipFilter;
  } = {},
): InvoiceWithSummary[] {
  const cardById = new Map<string, CreditCardRow>();
  for (const c of cardRows) {
    if (c.deletedAt === null) {
      cardById.set(c.id, c);
    }
  }

  const ledgerTxs = txRows.map(mapTransactionRowToLedger);
  const ownerFilter = options.ownerFilter ?? { mode: 'CONSOLIDATED' };

  return invoiceRows
    .filter((inv) => {
      if (inv.deletedAt !== null) return false;
      if (options.creditCardId && inv.creditCardId !== options.creditCardId) {
        return false;
      }
      if (
        options.statusFilter &&
        options.statusFilter !== 'ALL' &&
        inv.status !== options.statusFilter
      ) {
        return false;
      }
      if (
        options.competenceMonth &&
        inv.competenceMonth !== options.competenceMonth
      ) {
        return false;
      }
      const card = cardById.get(inv.creditCardId) ?? null;
      if (card && !matchesOwnershipFilter(card.ownerUserId, ownerFilter)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => b.competenceMonth.localeCompare(a.competenceMonth))
    .map((inv) => {
      const card = cardById.get(inv.creditCardId) ?? null;
      const invTxs = txRows
        .filter((t) => t.deletedAt === null && t.invoiceId === inv.id)
        .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));

      let chargesCents = 0;
      let refundsCents = 0;
      let paidCents = 0;
      for (const t of invTxs) {
        if (t.type === 'CREDIT_PURCHASE') {
          chargesCents += t.amountCents;
        } else if (t.type === 'CREDIT_REFUND') {
          refundsCents += t.amountCents;
        } else if (t.type === 'INVOICE_PAYMENT' && t.status === 'CLEARED') {
          paidCents += t.amountCents;
        }
      }

      const debtCents = calculateInvoiceDebtCents(inv.id, ledgerTxs);

      return {
        invoice: inv,
        card,
        debtCents,
        chargesCents,
        refundsCents,
        paidCents,
        transactions: invTxs,
      };
    });
}

export function listInvoicesByCard(
  db: AppDatabase,
  householdId: string,
  creditCardId?: string,
): CreditCardInvoiceRow[] {
  const conditions = [
    eq(creditCardInvoices.householdId, householdId),
    isNull(creditCardInvoices.deletedAt),
  ];
  if (creditCardId) {
    conditions.push(eq(creditCardInvoices.creditCardId, creditCardId));
  }

  return db
    .select()
    .from(creditCardInvoices)
    .where(and(...conditions))
    .orderBy(desc(creditCardInvoices.competenceMonth))
    .all();
}
