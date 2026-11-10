import { eq } from 'drizzle-orm';
import { isValidHlc } from '@/core';
import {
  createAccount,
  createBudget,
  createCategory,
  createCreditCard,
  createCreditCardInvoice,
  createInstallmentPurchase,
  createRecurringRule,
  createTransaction,
  queryTwelveMonthAggregate,
  restoreTransaction,
  softDeleteAccount,
  softDeleteInstallmentPlan,
  softDeleteTransaction,
  updateCreditCardInvoiceStatus,
  updateTransaction,
  upsertLocalHousehold,
} from '@/data/repositories';
import { syncOutbox, transactions } from '@/data/schema';
import { createInMemoryTestDb, type InMemoryTestDb } from './testDbHelper';

const HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';
const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222221';
const CATEGORY_EXP_ID = '33333333-3333-4333-8333-333333333331';
const CATEGORY_INC_ID = '33333333-3333-4333-8333-333333333332';
const CARD_ID = '44444444-4444-4444-8444-444444444441';
const INVOICE_1_ID = '55555555-5555-4555-8555-555555555551';
const INVOICE_2_ID = '55555555-5555-4555-8555-555555555552';
const INVOICE_3_ID = '55555555-5555-4555-8555-555555555553';

describe('Phase 2 — GATE-2.2 & GATE-2.3: Atomic Outbox Writes, Soft Delete, Coalescing & <15ms Aggregates', () => {
  let harness: InMemoryTestDb;

  beforeEach(() => {
    harness = createInMemoryTestDb();
    upsertLocalHousehold(harness.db, {
      id: HOUSEHOLD_ID,
      name: 'Household Casal',
    });
  });

  afterEach(() => {
    harness.close();
  });

  it('GATE-2.3: atomically writes domain row and sync_outbox row with canonical HLC and field_hlc', () => {
    const account = createAccount(
      harness.db,
      {
        id: ACCOUNT_ID,
        householdId: HOUSEHOLD_ID,
        ownerUserId: USER_A_ID,
        name: 'Itaú Personalité',
        type: 'CHECKING',
        initialBalanceCents: 250000,
        includeInNetWorth: true,
        isArchived: false,
      },
      { nowMs: 1762454712000, nodeId: 'a1b2c3d4e5f6' },
    );

    expect(isValidHlc(account.hlcTimestamp)).toBe(true);
    expect(account.fieldHlc.name).toBe(account.hlcTimestamp);

    const outboxRows = harness.db.select().from(syncOutbox).all();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].tableName).toBe('accounts');
    expect(outboxRows[0].recordId).toBe(ACCOUNT_ID);
    expect(outboxRows[0].operation).toBe('UPSERT');
    expect(outboxRows[0].status).toBe('PENDING');
    expect(outboxRows[0].hlcTimestamp).toBe(account.hlcTimestamp);

    const payload = JSON.parse(outboxRows[0].payloadJson) as Record<
      string,
      unknown
    >;
    expect(payload.name).toBe('Itaú Personalité');
    expect(payload.initial_balance_cents).toBe(250000);
  });

  it('coalesces multiple offline updates and soft-delete on the same PENDING record in sync_outbox', () => {
    createAccount(harness.db, {
      id: ACCOUNT_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_A_ID,
      name: 'Conta Principal',
      type: 'CHECKING',
      initialBalanceCents: 100000,
      includeInNetWorth: true,
      isArchived: false,
    });
    createCategory(harness.db, {
      id: CATEGORY_EXP_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Mercado',
      kind: 'EXPENSE',
      colorHex: '#4CAF50',
      iconName: 'shopping-cart',
    });

    const txId = '66666666-6666-4666-8666-666666666661';
    const created = createTransaction(
      harness.db,
      {
        id: txId,
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        type: 'EXPENSE',
        status: 'CLEARED',
        amountCents: 10000,
        transactionDate: '2026-11-06',
        competenceMonth: '2026-11',
        description: 'Supermercado v1',
        notes: null,
        accountId: ACCOUNT_ID,
        transferAccountId: null,
        creditCardId: null,
        invoiceId: null,
        categoryId: CATEGORY_EXP_ID,
        installmentPlanId: null,
        installmentNumber: null,
        totalInstallments: null,
        recurringRuleId: null,
        refundedTransactionId: null,
        isHouseholdContribution: false,
        calendarEventId: null,
      },
      { nowMs: 1762454713000 },
    );

    // Edit 5 times while still PENDING in sync_outbox
    for (let i = 2; i <= 6; i++) {
      updateTransaction(
        harness.db,
        txId,
        {
          amountCents: 10000 + i * 500,
          description: `Supermercado v${i}`,
        },
        { nowMs: 1762454713000 + i * 100 },
      );
    }

    const txOutboxRows = harness.db
      .select()
      .from(syncOutbox)
      .where(eq(syncOutbox.recordId, txId))
      .all();

    // Must coalesce into 1 PENDING outbox entry for this transaction
    expect(txOutboxRows).toHaveLength(1);
    expect(txOutboxRows[0].operation).toBe('UPSERT');
    expect(txOutboxRows[0].hlcTimestamp > created.hlcTimestamp).toBe(true);

    const coalescedPayload = JSON.parse(
      txOutboxRows[0].payloadJson,
    ) as Record<string, unknown>;
    expect(coalescedPayload.amount_cents).toBe(13000);
    expect(coalescedPayload.description).toBe('Supermercado v6');

    // Soft-delete the transaction: row must NOT be physically deleted, outbox operation becomes SOFT_DELETE
    const deleted = softDeleteTransaction(harness.db, txId, {
      nowMs: 1762454720000,
    });
    expect(deleted.deletedAt).toBe(deleted.hlcTimestamp);

    const dbRowAfterDelete = harness.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, txId))
      .get();
    expect(dbRowAfterDelete).toBeDefined();
    expect(dbRowAfterDelete!.deletedAt).not.toBeNull();

    const outboxAfterDelete = harness.db
      .select()
      .from(syncOutbox)
      .where(eq(syncOutbox.recordId, txId))
      .all();
    expect(outboxAfterDelete).toHaveLength(1);
    expect(outboxAfterDelete[0].operation).toBe('SOFT_DELETE');

    // Restore the soft-deleted transaction
    const restored = restoreTransaction(harness.db, txId, {
      nowMs: 1762454725000,
    });
    expect(restored.deletedAt).toBeNull();

    // Soft-delete account helper also preserves row with deleted_at set
    const deletedAccount = softDeleteAccount(harness.db, ACCOUNT_ID);
    expect(deletedAccount.deletedAt).not.toBeNull();
  });

  it('creates and cancels composite installment plans atomically with a shared batchId', () => {
    createAccount(harness.db, {
      id: ACCOUNT_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_A_ID,
      name: 'Conta Corrente',
      type: 'CHECKING',
      initialBalanceCents: 100000,
      includeInNetWorth: true,
      isArchived: false,
    });
    createCategory(harness.db, {
      id: CATEGORY_EXP_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Eletrônicos',
      kind: 'EXPENSE',
      colorHex: '#2196F3',
      iconName: 'laptop',
    });
    createCreditCard(harness.db, {
      id: CARD_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_A_ID,
      defaultPaymentAccountId: ACCOUNT_ID,
      name: 'Cartão Visa',
      limitCents: 1000000,
      closingDay: 10,
      dueDay: 17,
      isArchived: false,
    });
    createCreditCardInvoice(harness.db, {
      id: INVOICE_1_ID,
      householdId: HOUSEHOLD_ID,
      creditCardId: CARD_ID,
      competenceMonth: '2026-11',
      closingDate: '2026-11-10',
      dueDate: '2026-11-17',
      status: 'OPEN',
    });
    createCreditCardInvoice(harness.db, {
      id: INVOICE_2_ID,
      householdId: HOUSEHOLD_ID,
      creditCardId: CARD_ID,
      competenceMonth: '2026-12',
      closingDate: '2026-12-10',
      dueDate: '2026-12-17',
      status: 'OPEN',
    });
    createCreditCardInvoice(harness.db, {
      id: INVOICE_3_ID,
      householdId: HOUSEHOLD_ID,
      creditCardId: CARD_ID,
      competenceMonth: '2027-01',
      closingDate: '2027-01-10',
      dueDate: '2027-01-17',
      status: 'OPEN',
    });

    const planId = '77777777-7777-4777-8777-777777777771';
    const result = createInstallmentPurchase(harness.db, {
      plan: {
        id: planId,
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        creditCardId: CARD_ID,
        accountId: null,
        categoryId: CATEGORY_EXP_ID,
        description: 'Lava-louças',
        totalAmountCents: 10000,
        totalInstallments: 3,
        purchaseDate: '2026-11-05',
      },
      firstCompetenceMonth: '2026-11',
      invoiceIdByCompetenceMonth: {
        '2026-11': INVOICE_1_ID,
        '2026-12': INVOICE_2_ID,
        '2027-01': INVOICE_3_ID,
      },
    });

    expect(result.installments.map((t) => t.amountCents)).toEqual([
      3334, 3333, 3333,
    ]);

    const batchOutboxRows = harness.db
      .select()
      .from(syncOutbox)
      .where(eq(syncOutbox.batchId, result.batchId))
      .all();
    // 1 installment_plans row + 3 transactions rows sharing the exact same batchId
    expect(batchOutboxRows).toHaveLength(4);

    // If an invoice closes, hard-cancelling the whole plan is blocked
    updateCreditCardInvoiceStatus(harness.db, INVOICE_1_ID, 'CLOSED');
    expect(() => softDeleteInstallmentPlan(harness.db, planId)).toThrow(
      /CLOSED or PAID/,
    );

    // Reopen invoice -> soft-deleting the plan soft-deletes header + all 3 installments
    updateCreditCardInvoiceStatus(harness.db, INVOICE_1_ID, 'OPEN');
    const cancelResult = softDeleteInstallmentPlan(harness.db, planId);
    expect(cancelResult.deletedInstallmentCount).toBe(3);
    expect(cancelResult.plan.deletedAt).not.toBeNull();
  });

  it('persists recurring_rules and budgets with outbox metadata', () => {
    createAccount(harness.db, {
      id: ACCOUNT_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: null,
      name: 'Conta Casa',
      type: 'CHECKING',
      initialBalanceCents: 0,
      includeInNetWorth: true,
      isArchived: false,
    });
    createCategory(harness.db, {
      id: CATEGORY_EXP_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Moradia',
      kind: 'EXPENSE',
      colorHex: '#9C27B0',
      iconName: 'home',
    });

    const rule = createRecurringRule(harness.db, {
      id: '88888888-8888-4888-8888-888888888881',
      householdId: HOUSEHOLD_ID,
      createdByUserId: USER_A_ID,
      ownerUserId: null,
      type: 'EXPENSE',
      accountId: ACCOUNT_ID,
      creditCardId: null,
      categoryId: CATEGORY_EXP_ID,
      description: 'Condomínio',
      amountCents: 120000,
      frequency: 'MONTHLY',
      dayOfMonth: 10,
      startMonth: '2026-01',
      endMonth: null,
      isActive: true,
    });
    expect(isValidHlc(rule.hlcTimestamp)).toBe(true);

    const budget = createBudget(harness.db, {
      id: '88888888-8888-4888-8888-888888888882',
      householdId: HOUSEHOLD_ID,
      ownerUserId: null,
      categoryId: CATEGORY_EXP_ID,
      competenceMonth: '2026-11',
      limitCents: 300000,
    });
    expect(isValidHlc(budget.hlcTimestamp)).toBe(true);
  });

  it('GATE-2.2: executes 12-month aggregate query in < 15ms using idx_transactions_competence_active', () => {
    createAccount(harness.db, {
      id: ACCOUNT_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_A_ID,
      name: 'Conta Principal',
      type: 'CHECKING',
      initialBalanceCents: 500000,
      includeInNetWorth: true,
      isArchived: false,
    });
    createCategory(harness.db, {
      id: CATEGORY_EXP_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Despesas Gerais',
      kind: 'EXPENSE',
      colorHex: '#E91E63',
      iconName: 'tag',
    });
    createCategory(harness.db, {
      id: CATEGORY_INC_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Salário',
      kind: 'INCOME',
      colorHex: '#4CAF50',
      iconName: 'dollar-sign',
    });

    const months = [
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ];

    const insertStmt = harness.raw.prepare(`
      INSERT INTO transactions (
        id, household_id, created_by_user_id, owner_user_id, type, status,
        amount_cents, transaction_date, competence_month, description, notes,
        account_id, transfer_account_id, credit_card_id, invoice_id, category_id,
        installment_plan_id, installment_number, total_installments, recurring_rule_id,
        refunded_transaction_id, is_household_contribution, calendar_event_id,
        created_at, updated_at, deleted_at, hlc_timestamp, field_hlc, server_seq
      ) VALUES (?, ?, ?, ?, ?, 'CLEARED', ?, ?, ?, 'Perf Seed', NULL, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?, NULL, ?, '{}', 0)
    `);

    const seedBatch = harness.raw.transaction(() => {
      let counter = 0;
      for (const month of months) {
        // 1 income + 99 expenses per month = 1,200 transactions across 12 months
        counter++;
        insertStmt.run(
          `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
          HOUSEHOLD_ID,
          USER_A_ID,
          USER_A_ID,
          'INCOME',
          1000000,
          `${month}-05`,
          month,
          ACCOUNT_ID,
          CATEGORY_INC_ID,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z-0000-010203040506',
        );

        for (let i = 0; i < 99; i++) {
          counter++;
          insertStmt.run(
            `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
            HOUSEHOLD_ID,
            USER_A_ID,
            i % 2 === 0 ? USER_A_ID : null,
            'EXPENSE',
            5000,
            `${month}-15`,
            month,
            ACCOUNT_ID,
            CATEGORY_EXP_ID,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z-0000-010203040506',
          );
        }
      }
    });
    seedBatch();

    // Verify secondary index usage via EXPLAIN QUERY PLAN
    const planRows = harness.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT competence_month, SUM(amount_cents) FROM transactions WHERE household_id = ? AND competence_month BETWEEN ? AND ? AND deleted_at IS NULL GROUP BY competence_month`,
      )
      .all(HOUSEHOLD_ID, '2026-01', '2026-12') as { detail: string }[];

    const planText = planRows.map((p) => p.detail).join(' ');
    expect(planText).toContain('idx_transactions_competence_active');

    const startNs = process.hrtime.bigint();
    const summary = queryTwelveMonthAggregate(
      harness.db,
      HOUSEHOLD_ID,
      '2026-01',
      '2026-12',
      { mode: 'CONSOLIDATED' },
    );
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;

    expect(summary).toHaveLength(12);
    expect(summary[0]).toEqual({
      competenceMonth: '2026-01',
      incomeCents: 1000000,
      expenseCents: 99 * 5000,
      netSavingsCents: 1000000 - 99 * 5000,
    });
    expect(elapsedMs).toBeLessThan(15);
  });
});
