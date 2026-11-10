import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import {
  applyInstallmentScopeBEdit,
  assertTransactionInvariants,
  assertValidCents,
  canHardCancelInstallmentPlan,
  type InstallmentPlanInput,
  InstallmentPlanInputSchema,
  type InvoiceStatus,
  matchesOwnershipFilter,
  type OwnershipFilter,
  recalculateInstallmentPlanTotalCents,
  resolveInvoiceCompetenceMonth,
  splitInstallments,
} from '@/core';
import type { AppDatabase } from '../db';
import {
  accounts,
  categories,
  type CreditCardInvoiceRow,
  creditCardInvoices,
  type CreditCardRow,
  creditCards,
  type InstallmentPlanRow,
  installmentPlans,
  type TransactionRow,
  transactions,
} from '../schema';
import {
  ensureCardInvoiceForCompetenceInTx,
  mapInvoiceRowToLedger,
  mapTransactionRowToLedger,
} from './creditCards';
import {
  advanceTransactionHlc,
  buildFieldHlcMap,
  enqueueOrCoalesceOutbox,
  generateUuidV4,
  type MutationContextOptions,
} from './outbox';
import {
  insertTransactionInTx,
  serializeTransactionPayload,
} from './transactionRepository';

const INSTALLMENT_PLAN_MUTABLE_COLUMNS = [
  'owner_user_id',
  'credit_card_id',
  'account_id',
  'category_id',
  'description',
  'total_amount_cents',
  'total_installments',
  'purchase_date',
] as const;

export function serializeInstallmentPlanPayload(
  row: InstallmentPlanRow,
): Record<string, unknown> {
  return {
    id: row.id,
    household_id: row.householdId,
    created_by_user_id: row.createdByUserId,
    owner_user_id: row.ownerUserId,
    credit_card_id: row.creditCardId,
    account_id: row.accountId,
    category_id: row.categoryId,
    description: row.description,
    total_amount_cents: row.totalAmountCents,
    total_installments: row.totalInstallments,
    purchase_date: row.purchaseDate,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
    hlc_timestamp: row.hlcTimestamp,
  };
}

export interface CreateInstallmentPurchaseParams {
  plan: InstallmentPlanInput;
  /**
   * Optional competence month of the 1st installment (`YYYY-MM`).
   * For credit card purchases, if omitted, automatically resolved via `resolveInvoiceCompetenceMonth(plan.purchaseDate, card.closingDay)`.
   * For account purchases, if omitted, defaults to `plan.purchaseDate.slice(0, 7)`.
   */
  firstCompetenceMonth?: string;
  /**
   * Optional map of each installment's `competenceMonth` (`YYYY-MM`) to its target `invoiceId`.
   * When omitted on a credit card purchase, invoices are automatically resolved or created via `ensureCardInvoiceForCompetenceInTx`
   * within the same atomic SQLite transaction and `batchId`.
   */
  invoiceIdByCompetenceMonth?: Record<string, string>;
  /**
   * Optional deterministic transaction IDs for each installment (1..N).
   */
  installmentTransactionIds?: readonly string[];
  /**
   * When true, automatically ensures/creates missing invoices even if `invoiceIdByCompetenceMonth` is omitted.
   * Defaults to true when `invoiceIdByCompetenceMonth` is not provided.
   */
  autoEnsureInvoices?: boolean;
}

export interface CreateInstallmentPurchaseResult {
  plan: InstallmentPlanRow;
  installments: TransactionRow[];
  invoices: CreditCardInvoiceRow[];
  batchId: string;
}

/**
 * Atomically creates an `installment_plans` header and all N installment `transactions`
 * in a single SQLite transaction sharing a single `batchId` in `sync_outbox`.
 * Remainder cents (`total % N`) are allocated to the 1st installment via `splitInstallments`.
 */
export function createInstallmentPurchase(
  db: AppDatabase,
  params: CreateInstallmentPurchaseParams,
  options: MutationContextOptions = {},
): CreateInstallmentPurchaseResult {
  const validatedPlan = InstallmentPlanInputSchema.parse(params.plan);
  const sharedBatchId = options.batchId ?? generateUuidV4();

  return db.transaction((tx) => {
    const isCardPurchase = validatedPlan.creditCardId !== null;
    let cardRow: CreditCardRow | undefined;
    let accountOwnerUserId: string | null = null;

    if (isCardPurchase) {
      cardRow = tx
        .select()
        .from(creditCards)
        .where(
          and(
            eq(creditCards.id, validatedPlan.creditCardId!),
            eq(creditCards.householdId, validatedPlan.householdId),
            isNull(creditCards.deletedAt),
          ),
        )
        .get();

      if (!cardRow) {
        throw new Error(
          `Active credit card not found: ${validatedPlan.creditCardId}`,
        );
      }
    } else if (validatedPlan.accountId) {
      const accRow = tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, validatedPlan.accountId),
            eq(accounts.householdId, validatedPlan.householdId),
            isNull(accounts.deletedAt),
          ),
        )
        .get();
      if (accRow) {
        accountOwnerUserId = accRow.ownerUserId;
      }
    }

    const firstCompetenceMonth =
      params.firstCompetenceMonth ??
      (isCardPurchase && cardRow
        ? resolveInvoiceCompetenceMonth(
            validatedPlan.purchaseDate,
            cardRow.closingDay,
          )
        : validatedPlan.purchaseDate.slice(0, 7));

    const slices = splitInstallments(
      validatedPlan.totalAmountCents,
      validatedPlan.totalInstallments,
      firstCompetenceMonth,
    );

    const planMeta = advanceTransactionHlc(tx, {
      ...options,
      batchId: sharedBatchId,
    });
    const planFieldHlc = buildFieldHlcMap(
      INSTALLMENT_PLAN_MUTABLE_COLUMNS,
      planMeta.hlc,
    );

    tx.insert(installmentPlans)
      .values({
        id: validatedPlan.id,
        householdId: validatedPlan.householdId,
        createdByUserId: validatedPlan.createdByUserId,
        ownerUserId: validatedPlan.ownerUserId,
        creditCardId: validatedPlan.creditCardId,
        accountId: validatedPlan.accountId,
        categoryId: validatedPlan.categoryId,
        description: validatedPlan.description,
        totalAmountCents: validatedPlan.totalAmountCents,
        totalInstallments: validatedPlan.totalInstallments,
        purchaseDate: validatedPlan.purchaseDate,
        createdAt: planMeta.isoNow,
        updatedAt: planMeta.isoNow,
        deletedAt: null,
        hlcTimestamp: planMeta.hlc,
        fieldHlc: planFieldHlc,
        serverSeq: 0,
      })
      .run();

    const planRow = tx
      .select()
      .from(installmentPlans)
      .where(eq(installmentPlans.id, validatedPlan.id))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      batchId: sharedBatchId,
      tableName: 'installment_plans',
      recordId: planRow.id,
      operation: 'UPSERT',
      payload: serializeInstallmentPlanPayload(planRow),
      fieldHlc: planFieldHlc,
      hlcTimestamp: planMeta.hlc,
      createdAt: planMeta.isoNow,
    });

    // DEC-02: Shared expense (ownerUserId === null) paid on an individual card or account
    const instrumentOwnerId = isCardPurchase
      ? (cardRow?.ownerUserId ?? null)
      : accountOwnerUserId;
    const isHouseholdContribution =
      validatedPlan.ownerUserId === null && instrumentOwnerId !== null;

    const createdInstallments: TransactionRow[] = [];
    const touchedInvoices: CreditCardInvoiceRow[] = [];
    const shouldAutoEnsure =
      params.autoEnsureInvoices ?? params.invoiceIdByCompetenceMonth === undefined;

    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      const txId =
        params.installmentTransactionIds?.[i] ?? generateUuidV4();

      let invoiceId: string | null = null;
      if (isCardPurchase) {
        const mappedInvoiceId =
          params.invoiceIdByCompetenceMonth?.[slice.competenceMonth] ?? null;

        if (mappedInvoiceId) {
          invoiceId = mappedInvoiceId;
          const existingInv = tx
            .select()
            .from(creditCardInvoices)
            .where(eq(creditCardInvoices.id, mappedInvoiceId))
            .get();
          if (existingInv) {
            if (
              existingInv.status === 'CLOSED' ||
              existingInv.status === 'PAID'
            ) {
              throw new Error(
                `Cannot allocate installment ${slice.installmentNumber}/${slice.totalInstallments} to ${existingInv.status} invoice (${slice.competenceMonth})`,
              );
            }
            touchedInvoices.push(existingInv);
          }
        } else if (shouldAutoEnsure) {
          const ensuredInvoice = ensureCardInvoiceForCompetenceInTx(
            tx,
            {
              householdId: validatedPlan.householdId,
              creditCardId: validatedPlan.creditCardId!,
              competenceMonth: slice.competenceMonth,
            },
            {
              ...options,
              batchId: sharedBatchId,
              mutationId: undefined,
            },
          );
          if (
            ensuredInvoice.status === 'CLOSED' ||
            ensuredInvoice.status === 'PAID'
          ) {
            throw new Error(
              `Cannot allocate installment ${slice.installmentNumber}/${slice.totalInstallments} to ${ensuredInvoice.status} invoice (${slice.competenceMonth})`,
            );
          }
          invoiceId = ensuredInvoice.id;
          touchedInvoices.push(ensuredInvoice);
        } else {
          throw new Error(
            `Missing invoiceId for installment competence month ${slice.competenceMonth}`,
          );
        }
      }

      const txRow = insertTransactionInTx(
        tx,
        {
          id: txId,
          householdId: validatedPlan.householdId,
          createdByUserId: validatedPlan.createdByUserId,
          ownerUserId: validatedPlan.ownerUserId,
          type: isCardPurchase ? 'CREDIT_PURCHASE' : 'EXPENSE',
          status: isCardPurchase ? 'CLEARED' : i === 0 ? 'CLEARED' : 'PENDING',
          amountCents: slice.amountCents,
          transactionDate: validatedPlan.purchaseDate,
          competenceMonth: slice.competenceMonth,
          description: `${validatedPlan.description} (${slice.installmentNumber}/${slice.totalInstallments})`,
          notes: null,
          accountId: validatedPlan.accountId,
          transferAccountId: null,
          creditCardId: validatedPlan.creditCardId,
          invoiceId,
          categoryId: validatedPlan.categoryId,
          installmentPlanId: validatedPlan.id,
          installmentNumber: slice.installmentNumber,
          totalInstallments: slice.totalInstallments,
          recurringRuleId: null,
          refundedTransactionId: null,
          isHouseholdContribution,
          calendarEventId: null,
        },
        {
          ...options,
          batchId: sharedBatchId,
          mutationId: undefined,
        },
      );

      createdInstallments.push(txRow);
    }

    return {
      plan: planRow,
      installments: createdInstallments,
      invoices: touchedInvoices,
      batchId: sharedBatchId,
    };
  });
}

export interface EditInstallmentScopeAParams {
  transactionId: string;
  changes: {
    amountCents?: number;
    categoryId?: string;
    description?: string;
    ownerUserId?: string | null;
    notes?: string | null;
  };
}

export interface EditInstallmentScopeAResult {
  updatedTransaction: TransactionRow;
  plan: InstallmentPlanRow;
  newTotalAmountCents: number;
  batchId: string;
}

/**
 * Applies a Scope A edit ("Only this installment") to a single installment transaction:
 * - Rejects edits if the installment belongs to a `CLOSED` or `PAID` invoice.
 * - Updates the installment transaction and recalculates `installment_plans.total_amount_cents`
 *   using `recalculateInstallmentPlanTotalCents` in the same SQLite transaction and `batchId`.
 */
export function editInstallmentScopeA(
  db: AppDatabase,
  params: EditInstallmentScopeAParams,
  options: MutationContextOptions = {},
): EditInstallmentScopeAResult {
  if (params.changes.amountCents !== undefined) {
    assertValidCents(params.changes.amountCents, 'changes.amountCents');
  }

  const sharedBatchId = options.batchId ?? generateUuidV4();

  return db.transaction((tx) => {
    const existingTx = tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, params.transactionId))
      .get();

    if (!existingTx || existingTx.deletedAt !== null) {
      throw new Error(
        `Active installment transaction not found: ${params.transactionId}`,
      );
    }

    if (!existingTx.installmentPlanId) {
      throw new Error(
        `Transaction ${params.transactionId} does not belong to an installment plan`,
      );
    }

    const plan = tx
      .select()
      .from(installmentPlans)
      .where(eq(installmentPlans.id, existingTx.installmentPlanId))
      .get();

    if (!plan || plan.deletedAt !== null) {
      throw new Error(
        `Active installment plan not found: ${existingTx.installmentPlanId}`,
      );
    }

    if (existingTx.invoiceId) {
      const inv = tx
        .select()
        .from(creditCardInvoices)
        .where(eq(creditCardInvoices.id, existingTx.invoiceId))
        .get();

      if (
        inv &&
        inv.deletedAt === null &&
        (inv.status === 'CLOSED' || inv.status === 'PAID')
      ) {
        throw new Error(
          `Cannot edit installment in ${inv.status} invoice (${inv.competenceMonth})`,
        );
      }
    }

    if (params.changes.categoryId !== undefined) {
      const cat = tx
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.id, params.changes.categoryId),
            eq(categories.householdId, plan.householdId),
            isNull(categories.deletedAt),
          ),
        )
        .get();
      if (!cat || cat.kind !== 'EXPENSE') {
        throw new Error(
          `Valid active EXPENSE category required: ${params.changes.categoryId}`,
        );
      }
    }

    const nextAmountCents =
      params.changes.amountCents ?? existingTx.amountCents;
    const nextCategoryId =
      params.changes.categoryId ?? existingTx.categoryId;
    const nextDescription =
      params.changes.description?.trim() || existingTx.description;
    const nextOwnerUserId =
      params.changes.ownerUserId !== undefined
        ? params.changes.ownerUserId
        : existingTx.ownerUserId;
    const nextNotes =
      params.changes.notes !== undefined
        ? params.changes.notes
        : existingTx.notes;

    let instrumentOwnerId: string | null = null;
    if (existingTx.creditCardId) {
      const card = tx
        .select()
        .from(creditCards)
        .where(eq(creditCards.id, existingTx.creditCardId))
        .get();
      instrumentOwnerId = card?.ownerUserId ?? null;
    } else if (existingTx.accountId) {
      const acc = tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, existingTx.accountId))
        .get();
      instrumentOwnerId = acc?.ownerUserId ?? null;
    }

    const nextContribution =
      nextOwnerUserId === null && instrumentOwnerId !== null;

    assertTransactionInvariants({
      type: existingTx.type,
      amountCents: nextAmountCents,
      accountId: existingTx.accountId,
      transferAccountId: existingTx.transferAccountId,
      creditCardId: existingTx.creditCardId,
      invoiceId: existingTx.invoiceId,
      categoryId: nextCategoryId,
    });

    const changedCols: string[] = [];
    if (params.changes.amountCents !== undefined)
      changedCols.push('amount_cents');
    if (params.changes.categoryId !== undefined)
      changedCols.push('category_id');
    if (params.changes.description !== undefined)
      changedCols.push('description');
    if (params.changes.ownerUserId !== undefined) {
      changedCols.push('owner_user_id');
      changedCols.push('is_household_contribution');
    }
    if (params.changes.notes !== undefined) changedCols.push('notes');

    const txMeta = advanceTransactionHlc(tx, {
      ...options,
      batchId: sharedBatchId,
    });
    const nextTxFieldHlc = buildFieldHlcMap(
      changedCols,
      txMeta.hlc,
      existingTx.fieldHlc,
    );

    tx.update(transactions)
      .set({
        amountCents: nextAmountCents,
        categoryId: nextCategoryId,
        description: nextDescription,
        ownerUserId: nextOwnerUserId,
        notes: nextNotes,
        isHouseholdContribution: nextContribution,
        updatedAt: txMeta.isoNow,
        hlcTimestamp: txMeta.hlc,
        fieldHlc: nextTxFieldHlc,
      })
      .where(eq(transactions.id, existingTx.id))
      .run();

    const updatedTxRow = tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, existingTx.id))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      batchId: sharedBatchId,
      tableName: 'transactions',
      recordId: updatedTxRow.id,
      operation: 'UPSERT',
      payload: serializeTransactionPayload(updatedTxRow),
      fieldHlc: buildFieldHlcMap(changedCols, txMeta.hlc),
      hlcTimestamp: txMeta.hlc,
      createdAt: txMeta.isoNow,
    });

    // Recalculate installment_plans.total_amount_cents from all active child transactions
    const allPlanTxRows = tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, plan.householdId),
          eq(transactions.installmentPlanId, plan.id),
          isNull(transactions.deletedAt),
        ),
      )
      .all();

    const newTotalAmountCents = recalculateInstallmentPlanTotalCents(
      plan.id,
      allPlanTxRows.map(mapTransactionRowToLedger),
    );

    const planMeta = advanceTransactionHlc(tx, {
      ...options,
      batchId: sharedBatchId,
    });
    const nextPlanFieldHlc = buildFieldHlcMap(
      ['total_amount_cents'],
      planMeta.hlc,
      plan.fieldHlc,
    );

    tx.update(installmentPlans)
      .set({
        totalAmountCents: newTotalAmountCents,
        updatedAt: planMeta.isoNow,
        hlcTimestamp: planMeta.hlc,
        fieldHlc: nextPlanFieldHlc,
      })
      .where(eq(installmentPlans.id, plan.id))
      .run();

    const updatedPlanRow = tx
      .select()
      .from(installmentPlans)
      .where(eq(installmentPlans.id, plan.id))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      batchId: sharedBatchId,
      tableName: 'installment_plans',
      recordId: updatedPlanRow.id,
      operation: 'UPSERT',
      payload: serializeInstallmentPlanPayload(updatedPlanRow),
      fieldHlc: { total_amount_cents: planMeta.hlc },
      hlcTimestamp: planMeta.hlc,
      createdAt: planMeta.isoNow,
    });

    return {
      updatedTransaction: updatedTxRow,
      plan: updatedPlanRow,
      newTotalAmountCents,
      batchId: sharedBatchId,
    };
  });
}

export interface EditInstallmentScopeBParams {
  installmentPlanId: string;
  fromInstallmentNumber: number;
  changes: {
    amountCents?: number;
    categoryId?: string;
    description?: string;
    ownerUserId?: string | null;
  };
}

export interface EditInstallmentScopeBResult {
  plan: InstallmentPlanRow;
  updatedTransactions: TransactionRow[];
  skippedLockedCount: number;
  newTotalAmountCents: number;
  batchId: string;
}

/**
 * Applies a Scope B edit ("This and all following installments") to an installment plan
 * using core `applyInstallmentScopeBEdit`:
 * - Updates only installments with `installmentNumber >= fromInstallmentNumber` whose associated
 *   invoice is `'OPEN'` (or not attached to a `'CLOSED'`/`'PAID'` invoice).
 * - Installments in `'CLOSED'` or `'PAID'` invoices remain strictly immutable.
 * - Updates `installment_plans.total_amount_cents` to the exact sum of active installments,
 *   enqueuing all mutations under a single shared `batchId` in `sync_outbox`.
 */
export function editInstallmentScopeB(
  db: AppDatabase,
  params: EditInstallmentScopeBParams,
  options: MutationContextOptions = {},
): EditInstallmentScopeBResult {
  if (params.changes.amountCents !== undefined) {
    assertValidCents(params.changes.amountCents, 'changes.amountCents');
  }

  const sharedBatchId = options.batchId ?? generateUuidV4();

  return db.transaction((tx) => {
    const plan = tx
      .select()
      .from(installmentPlans)
      .where(eq(installmentPlans.id, params.installmentPlanId))
      .get();

    if (!plan || plan.deletedAt !== null) {
      throw new Error(
        `Active installment plan not found: ${params.installmentPlanId}`,
      );
    }

    if (params.changes.categoryId !== undefined) {
      const cat = tx
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.id, params.changes.categoryId),
            eq(categories.householdId, plan.householdId),
            isNull(categories.deletedAt),
          ),
        )
        .get();
      if (!cat || cat.kind !== 'EXPENSE') {
        throw new Error(
          `Valid active EXPENSE category required: ${params.changes.categoryId}`,
        );
      }
    }

    const childRows = tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, plan.householdId),
          eq(transactions.installmentPlanId, plan.id),
          isNull(transactions.deletedAt),
        ),
      )
      .orderBy(asc(transactions.installmentNumber))
      .all();

    const invoiceRows = tx
      .select()
      .from(creditCardInvoices)
      .where(
        and(
          eq(creditCardInvoices.householdId, plan.householdId),
          isNull(creditCardInvoices.deletedAt),
        ),
      )
      .all();

    const ledgerTransactions = childRows.map(mapTransactionRowToLedger);
    const ledgerInvoices = invoiceRows.map(mapInvoiceRowToLedger);

    const { updatedTransactions: computedLedgerTxs, newTotalAmountCents } =
      applyInstallmentScopeBEdit(
        plan.id,
        params.fromInstallmentNumber,
        params.changes,
        ledgerTransactions,
        ledgerInvoices,
      );

    let instrumentOwnerId: string | null = null;
    if (plan.creditCardId) {
      const card = tx
        .select()
        .from(creditCards)
        .where(eq(creditCards.id, plan.creditCardId))
        .get();
      instrumentOwnerId = card?.ownerUserId ?? null;
    } else if (plan.accountId) {
      const acc = tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, plan.accountId))
        .get();
      instrumentOwnerId = acc?.ownerUserId ?? null;
    }

    const invoiceStatusById = new Map<string, InvoiceStatus>();
    for (const inv of invoiceRows) {
      invoiceStatusById.set(inv.id, inv.status);
    }

    const updatedRows: TransactionRow[] = [];
    let skippedLockedCount = 0;

    for (let i = 0; i < childRows.length; i++) {
      const orig = childRows[i];
      const next = computedLedgerTxs[i];

      const isTargetNumber =
        typeof orig.installmentNumber === 'number' &&
        orig.installmentNumber >= params.fromInstallmentNumber;

      if (!isTargetNumber) {
        continue;
      }

      if (orig.invoiceId) {
        const invStatus = invoiceStatusById.get(orig.invoiceId);
        if (invStatus === 'CLOSED' || invStatus === 'PAID') {
          skippedLockedCount += 1;
          continue;
        }
      }

      const nextDescription =
        params.changes.description !== undefined
          ? `${params.changes.description.trim()} (${orig.installmentNumber}/${orig.totalInstallments})`
          : orig.description;

      const nextContribution =
        next.ownerUserId === null && instrumentOwnerId !== null;

      const changedCols: string[] = [];
      if (params.changes.amountCents !== undefined)
        changedCols.push('amount_cents');
      if (params.changes.categoryId !== undefined)
        changedCols.push('category_id');
      if (params.changes.description !== undefined)
        changedCols.push('description');
      if (params.changes.ownerUserId !== undefined) {
        changedCols.push('owner_user_id');
        changedCols.push('is_household_contribution');
      }

      const txMeta = advanceTransactionHlc(tx, {
        ...options,
        batchId: sharedBatchId,
      });
      const nextTxFieldHlc = buildFieldHlcMap(
        changedCols,
        txMeta.hlc,
        orig.fieldHlc,
      );

      tx.update(transactions)
        .set({
          amountCents: next.amountCents,
          categoryId: next.categoryId,
          description: nextDescription,
          ownerUserId: next.ownerUserId,
          isHouseholdContribution: nextContribution,
          updatedAt: txMeta.isoNow,
          hlcTimestamp: txMeta.hlc,
          fieldHlc: nextTxFieldHlc,
        })
        .where(eq(transactions.id, orig.id))
        .run();

      const updatedRow = tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, orig.id))
        .get()!;

      enqueueOrCoalesceOutbox(tx, {
        batchId: sharedBatchId,
        tableName: 'transactions',
        recordId: updatedRow.id,
        operation: 'UPSERT',
        payload: serializeTransactionPayload(updatedRow),
        fieldHlc: buildFieldHlcMap(changedCols, txMeta.hlc),
        hlcTimestamp: txMeta.hlc,
        createdAt: txMeta.isoNow,
      });

      updatedRows.push(updatedRow);
    }

    const planChangedCols: string[] = ['total_amount_cents'];
    if (params.changes.categoryId !== undefined)
      planChangedCols.push('category_id');
    if (params.changes.description !== undefined)
      planChangedCols.push('description');
    if (params.changes.ownerUserId !== undefined)
      planChangedCols.push('owner_user_id');

    const planMeta = advanceTransactionHlc(tx, {
      ...options,
      batchId: sharedBatchId,
    });
    const nextPlanFieldHlc = buildFieldHlcMap(
      planChangedCols,
      planMeta.hlc,
      plan.fieldHlc,
    );

    tx.update(installmentPlans)
      .set({
        totalAmountCents: newTotalAmountCents,
        categoryId: params.changes.categoryId ?? plan.categoryId,
        description:
          params.changes.description !== undefined
            ? params.changes.description.trim()
            : plan.description,
        ownerUserId:
          params.changes.ownerUserId !== undefined
            ? params.changes.ownerUserId
            : plan.ownerUserId,
        updatedAt: planMeta.isoNow,
        hlcTimestamp: planMeta.hlc,
        fieldHlc: nextPlanFieldHlc,
      })
      .where(eq(installmentPlans.id, plan.id))
      .run();

    const updatedPlanRow = tx
      .select()
      .from(installmentPlans)
      .where(eq(installmentPlans.id, plan.id))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      batchId: sharedBatchId,
      tableName: 'installment_plans',
      recordId: updatedPlanRow.id,
      operation: 'UPSERT',
      payload: serializeInstallmentPlanPayload(updatedPlanRow),
      fieldHlc: buildFieldHlcMap(planChangedCols, planMeta.hlc),
      hlcTimestamp: planMeta.hlc,
      createdAt: planMeta.isoNow,
    });

    return {
      plan: updatedPlanRow,
      updatedTransactions: updatedRows,
      skippedLockedCount,
      newTotalAmountCents,
      batchId: sharedBatchId,
    };
  });
}

/**
 * Atomically soft-deletes an installment plan and all its child transactions in one `batchId`,
 * provided none of its installments belong to a `CLOSED` or `PAID` invoice.
 */
export function softDeleteInstallmentPlan(
  db: AppDatabase,
  installmentPlanId: string,
  options: MutationContextOptions = {},
): {
  plan: InstallmentPlanRow;
  deletedInstallmentCount: number;
  batchId: string;
} {
  return db.transaction((tx) => {
    const plan = tx
      .select()
      .from(installmentPlans)
      .where(eq(installmentPlans.id, installmentPlanId))
      .get();

    if (!plan) {
      throw new Error(`Installment plan not found: ${installmentPlanId}`);
    }

    const childRows = tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, plan.householdId),
          eq(transactions.installmentPlanId, installmentPlanId),
          isNull(transactions.deletedAt),
        ),
      )
      .all();

    const invoiceRows = tx
      .select()
      .from(creditCardInvoices)
      .where(
        and(
          eq(creditCardInvoices.householdId, plan.householdId),
          isNull(creditCardInvoices.deletedAt),
        ),
      )
      .all();

    const ledgerTransactions = childRows.map(mapTransactionRowToLedger);
    const ledgerInvoices = invoiceRows.map(mapInvoiceRowToLedger);

    if (
      !canHardCancelInstallmentPlan(
        installmentPlanId,
        ledgerTransactions,
        ledgerInvoices,
      )
    ) {
      throw new Error(
        'Cannot soft-delete installment plan with installments in CLOSED or PAID invoices',
      );
    }

    const sharedBatchId = options.batchId ?? generateUuidV4();
    const planMeta = advanceTransactionHlc(tx, {
      ...options,
      batchId: sharedBatchId,
    });
    const planNextFieldHlc = buildFieldHlcMap(
      ['deleted_at'],
      planMeta.hlc,
      plan.fieldHlc,
    );

    tx.update(installmentPlans)
      .set({
        deletedAt: planMeta.hlc,
        updatedAt: planMeta.isoNow,
        hlcTimestamp: planMeta.hlc,
        fieldHlc: planNextFieldHlc,
      })
      .where(eq(installmentPlans.id, installmentPlanId))
      .run();

    const deletedPlan = tx
      .select()
      .from(installmentPlans)
      .where(eq(installmentPlans.id, installmentPlanId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      batchId: sharedBatchId,
      tableName: 'installment_plans',
      recordId: deletedPlan.id,
      operation: 'SOFT_DELETE',
      payload: serializeInstallmentPlanPayload(deletedPlan),
      fieldHlc: { deleted_at: planMeta.hlc },
      hlcTimestamp: planMeta.hlc,
      createdAt: planMeta.isoNow,
    });

    for (const child of childRows) {
      const childMeta = advanceTransactionHlc(tx, {
        ...options,
        batchId: sharedBatchId,
      });
      const childFieldHlc = buildFieldHlcMap(
        ['deleted_at'],
        childMeta.hlc,
        child.fieldHlc,
      );

      tx.update(transactions)
        .set({
          deletedAt: childMeta.hlc,
          updatedAt: childMeta.isoNow,
          hlcTimestamp: childMeta.hlc,
          fieldHlc: childFieldHlc,
        })
        .where(eq(transactions.id, child.id))
        .run();

      const deletedChild = tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, child.id))
        .get()!;

      enqueueOrCoalesceOutbox(tx, {
        batchId: sharedBatchId,
        tableName: 'transactions',
        recordId: deletedChild.id,
        operation: 'SOFT_DELETE',
        payload: serializeTransactionPayload(deletedChild),
        fieldHlc: { deleted_at: childMeta.hlc },
        hlcTimestamp: childMeta.hlc,
        createdAt: childMeta.isoNow,
      });
    }

    return {
      plan: deletedPlan,
      deletedInstallmentCount: childRows.length,
      batchId: sharedBatchId,
    };
  });
}

export interface InstallmentSliceWithInvoice {
  transaction: TransactionRow;
  invoiceStatus: InvoiceStatus | null;
  isLocked: boolean;
}

export interface InstallmentPlanWithSlices {
  plan: InstallmentPlanRow;
  slices: InstallmentSliceWithInvoice[];
  canCancelAll: boolean;
}

export function computeInstallmentPlansWithSlices(
  planRows: readonly InstallmentPlanRow[],
  txRows: readonly TransactionRow[],
  invoiceRows: readonly CreditCardInvoiceRow[],
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): InstallmentPlanWithSlices[] {
  const invoiceStatusById = new Map<string, InvoiceStatus>();
  for (const inv of invoiceRows) {
    if (inv.deletedAt === null) {
      invoiceStatusById.set(inv.id, inv.status);
    }
  }

  const ledgerInvoices = invoiceRows.map(mapInvoiceRowToLedger);

  return planRows
    .filter(
      (p) =>
        p.deletedAt === null &&
        matchesOwnershipFilter(p.ownerUserId, ownerFilter),
    )
    .sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate))
    .map((plan) => {
      const childTxs = txRows
        .filter(
          (t) => t.deletedAt === null && t.installmentPlanId === plan.id,
        )
        .sort(
          (a, b) => (a.installmentNumber ?? 0) - (b.installmentNumber ?? 0),
        );

      const slices: InstallmentSliceWithInvoice[] = childTxs.map((tx) => {
        const invoiceStatus = tx.invoiceId
          ? (invoiceStatusById.get(tx.invoiceId) ?? null)
          : null;
        const isLocked =
          invoiceStatus === 'CLOSED' || invoiceStatus === 'PAID';
        return {
          transaction: tx,
          invoiceStatus,
          isLocked,
        };
      });

      const canCancelAll = canHardCancelInstallmentPlan(
        plan.id,
        childTxs.map(mapTransactionRowToLedger),
        ledgerInvoices,
      );

      return {
        plan,
        slices,
        canCancelAll,
      };
    });
}

export function listInstallmentPlansWithSlices(
  db: AppDatabase,
  householdId: string,
  ownerFilter: OwnershipFilter = { mode: 'CONSOLIDATED' },
): InstallmentPlanWithSlices[] {
  const planRows = db
    .select()
    .from(installmentPlans)
    .where(
      and(
        eq(installmentPlans.householdId, householdId),
        isNull(installmentPlans.deletedAt),
      ),
    )
    .orderBy(desc(installmentPlans.purchaseDate))
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

  return computeInstallmentPlansWithSlices(
    planRows,
    txRows,
    invoiceRows,
    ownerFilter,
  );
}
