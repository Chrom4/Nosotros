import { and, eq, isNull } from 'drizzle-orm';
import {
  generateRecurringTransactionId,
  NAMESPACE_RECURRING,
  uuidv5,
} from '@/core';
import {
  calculateRecurringProjectionSummary,
  confirmPendingTransaction,
  createAccount,
  createCategory,
  createCreditCard,
  createRecurringRule,
  creditCardInvoices,
  listActiveRecurringRules,
  listRecurringOccurrencesForMonth,
  listRecurringRulesWithDetails,
  materializeMonth,
  reconcilePeerOutbox,
  recurringRules,
  resetCachedDatabaseForTests,
  setActiveDatabaseForTests,
  softDeleteRecurringRule,
  syncOutbox,
  transactions,
  updateRecurringRule,
  updateRecurringRuleWithOccurrences,
  upsertLocalHousehold,
  upsertLocalHouseholdMember,
} from '@/data';
import {
  createInMemoryTestDb,
  type InMemoryTestDb,
} from '../data/testDbHelper';

const HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';
const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ACC_CHECKING_ID = '22222222-2222-4222-8222-222222222201';
const CARD_ID = '44444444-4444-4444-8444-444444444401';
const CAT_SALARY_ID = '33333333-3333-4333-8333-333333333301';
const CAT_BILLS_ID = '33333333-3333-4333-8333-333333333302';
const CAT_STREAMING_ID = '33333333-3333-4333-8333-333333333303';

describe('Phase 8 — Recurring Rules, Deterministic Materialization & Monthly Projections', () => {
  let deviceA: InMemoryTestDb;
  let deviceB: InMemoryTestDb;

  beforeEach(() => {
    resetCachedDatabaseForTests();

    deviceA = createInMemoryTestDb();
    deviceB = createInMemoryTestDb();
    setActiveDatabaseForTests(deviceA.db);

    for (const peer of [deviceA.db, deviceB.db]) {
      upsertLocalHousehold(peer, {
        id: HOUSEHOLD_ID,
        name: 'Casa Nós',
      });
      upsertLocalHouseholdMember(peer, {
        id: '10000000-0000-4000-8000-000000000001',
        householdId: HOUSEHOLD_ID,
        userId: USER_A_ID,
        displayName: 'Diogo',
        role: 'FOUNDER',
        colorHex: '#4F46E5',
      });
      upsertLocalHouseholdMember(peer, {
        id: '10000000-0000-4000-8000-000000000002',
        householdId: HOUSEHOLD_ID,
        userId: USER_B_ID,
        displayName: 'Ana',
        role: 'PARTNER',
        colorHex: '#EC4899',
      });

      createAccount(peer, {
        id: ACC_CHECKING_ID,
        householdId: HOUSEHOLD_ID,
        ownerUserId: null,
        name: 'Conta Corrente Conjunta',
        type: 'CHECKING',
        initialBalanceCents: 500000,
        includeInNetWorth: true,
        isArchived: false,
      });

      createCreditCard(peer, {
        id: CARD_ID,
        householdId: HOUSEHOLD_ID,
        ownerUserId: null,
        defaultPaymentAccountId: ACC_CHECKING_ID,
        name: 'Cartão Black',
        limitCents: 1500000,
        closingDay: 20,
        dueDay: 28,
        isArchived: false,
      });

      createCategory(peer, {
        id: CAT_SALARY_ID,
        householdId: HOUSEHOLD_ID,
        parentId: null,
        name: 'Salário',
        kind: 'INCOME',
        colorHex: '#10B981',
        iconName: 'briefcase',
      });

      createCategory(peer, {
        id: CAT_BILLS_ID,
        householdId: HOUSEHOLD_ID,
        parentId: null,
        name: 'Contas Fixas',
        kind: 'EXPENSE',
        colorHex: '#EF4444',
        iconName: 'home',
      });

      createCategory(peer, {
        id: CAT_STREAMING_ID,
        householdId: HOUSEHOLD_ID,
        parentId: null,
        name: 'Assinaturas',
        kind: 'EXPENSE',
        colorHex: '#8B5CF6',
        iconName: 'tv',
      });
    }
  });

  afterEach(() => {
    resetCachedDatabaseForTests();
    deviceA.close();
    deviceB.close();
  });

  describe('T8.1 — Recurring Rules CRUD & Invariants', () => {
    it('creates recurring rules with valid invariants and enqueues outbox mutation', () => {
      const salaryRule = createRecurringRule(deviceA.db, {
        id: '55555555-5555-4555-8555-555555555501',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        type: 'INCOME',
        accountId: ACC_CHECKING_ID,
        creditCardId: null,
        categoryId: CAT_SALARY_ID,
        description: 'Salário Diogo',
        amountCents: 900000,
        frequency: 'MONTHLY',
        dayOfMonth: 5,
        startMonth: '2026-01',
        endMonth: null,
        isActive: true,
      });

      expect(salaryRule.description).toBe('Salário Diogo');
      expect(salaryRule.amountCents).toBe(900000);
      expect(salaryRule.type).toBe('INCOME');
      expect(salaryRule.deletedAt).toBeNull();

      const outbox = deviceA.db.select().from(syncOutbox).all();
      const ruleOutbox = outbox.find(
        (o) => o.tableName === 'recurring_rules' && o.recordId === salaryRule.id,
      );
      expect(ruleOutbox).toBeDefined();
      expect(ruleOutbox?.operation).toBe('UPSERT');
    });

    it('enforces invariants: CREDIT_PURCHASE requires creditCardId, INCOME/EXPENSE requires accountId', () => {
      expect(() =>
        createRecurringRule(deviceA.db, {
          id: '55555555-5555-4555-8555-555555555502',
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: null,
          type: 'CREDIT_PURCHASE',
          accountId: ACC_CHECKING_ID, // Invalid: credit purchase must not have accountId
          creditCardId: null,
          categoryId: CAT_STREAMING_ID,
          description: 'Streaming Inválido',
          amountCents: 3990,
          frequency: 'MONTHLY',
          dayOfMonth: 10,
          startMonth: '2026-01',
          endMonth: null,
          isActive: true,
        }),
      ).toThrow();

      expect(() =>
        createRecurringRule(deviceA.db, {
          id: '55555555-5555-4555-8555-555555555503',
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: null,
          type: 'EXPENSE',
          accountId: null, // Invalid: expense must have accountId
          creditCardId: null,
          categoryId: CAT_BILLS_ID,
          description: 'Luz Inválida',
          amountCents: 15000,
          frequency: 'MONTHLY',
          dayOfMonth: 12,
          startMonth: '2026-01',
          endMonth: null,
          isActive: true,
        }),
      ).toThrow();
    });

    it('soft deletes a recurring rule without physical DELETE', () => {
      const fiberRule = createRecurringRule(deviceA.db, {
        id: '55555555-5555-4555-8555-555555555504',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        type: 'EXPENSE',
        accountId: ACC_CHECKING_ID,
        creditCardId: null,
        categoryId: CAT_BILLS_ID,
        description: 'Internet Fibra',
        amountCents: 14990,
        frequency: 'MONTHLY',
        dayOfMonth: 15,
        startMonth: '2026-01',
        endMonth: null,
        isActive: true,
      });

      softDeleteRecurringRule(deviceA.db, fiberRule.id);

      const activeRules = listActiveRecurringRules(deviceA.db, HOUSEHOLD_ID);
      expect(activeRules.some((r) => r.id === fiberRule.id)).toBe(false);

      const rawRow = deviceA.db
        .select()
        .from(recurringRules)
        .where(eq(recurringRules.id, fiberRule.id))
        .get();
      expect(rawRow).toBeDefined();
      expect(rawRow?.deletedAt).not.toBeNull();
    });

    it('updates a recurring rule and propagates changes to pending occurrences when requested', () => {
      const fiberRule = createRecurringRule(deviceA.db, {
        id: '55555555-5555-4555-8555-555555555505',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        type: 'EXPENSE',
        accountId: ACC_CHECKING_ID,
        creditCardId: null,
        categoryId: CAT_BILLS_ID,
        description: 'Internet Fibra 300M',
        amountCents: 14990,
        frequency: 'MONTHLY',
        dayOfMonth: 15,
        startMonth: '2026-01',
        endMonth: null,
        isActive: true,
      });

      // Materialize 2026-11
      const [novTx] = materializeMonth(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        competenceMonth: '2026-11',
      });
      // Confirm 2026-11
      confirmPendingTransaction(deviceA.db, novTx.id);

      // Materialize 2026-12
      const [decTx] = materializeMonth(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        competenceMonth: '2026-12',
      });
      expect(decTx.status).toBe('PENDING');

      // Update rule with price change: 16990
      updateRecurringRuleWithOccurrences(
        deviceA.db,
        fiberRule.id,
        {
          amountCents: 16990,
          description: 'Internet Fibra 600M',
        },
        '2026-12',
      );

      // 2026-11 (CLEARED) is untouched
      const reloadedNov = deviceA.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, novTx.id))
        .get();
      expect(reloadedNov?.amountCents).toBe(14990);
      expect(reloadedNov?.description).toBe('Internet Fibra 300M');

      // 2026-12 (PENDING) is updated
      const reloadedDec = deviceA.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, decTx.id))
        .get();
      expect(reloadedDec?.amountCents).toBe(16990);
      expect(reloadedDec?.description).toBe('Internet Fibra 600M');
    });
  });

  describe('T8.1 & T8.2 — Month Materialization, Deterministic UUIDv5 & One-Tap Confirm', () => {
    it('materializes PENDING occurrences with RFC 4122 UUIDv5 and handles idempotency', () => {
      const streamingRule = createRecurringRule(deviceA.db, {
        id: '55555555-5555-4555-8555-555555555506',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        type: 'CREDIT_PURCHASE',
        accountId: null,
        creditCardId: CARD_ID,
        categoryId: CAT_STREAMING_ID,
        description: 'Netflix Premium',
        amountCents: 5990,
        frequency: 'MONTHLY',
        dayOfMonth: 18,
        startMonth: '2026-01',
        endMonth: null,
        isActive: true,
      });

      const materialized = materializeMonth(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        competenceMonth: '2026-11',
      });

      expect(materialized).toHaveLength(1);
      const expectedId = uuidv5(
        NAMESPACE_RECURRING,
        `${streamingRule.id}:2026-11`,
      );
      expect(materialized[0].id).toBe(expectedId);
      expect(materialized[0].status).toBe('PENDING');
      expect(materialized[0].amountCents).toBe(5990);
      expect(materialized[0].transactionDate).toBe('2026-11-18');
      expect(materialized[0].creditCardId).toBe(CARD_ID);
      expect(materialized[0].invoiceId).not.toBeNull();

      // Ensure corresponding invoice was created deterministically
      const invoice = deviceA.db
        .select()
        .from(creditCardInvoices)
        .where(eq(creditCardInvoices.id, materialized[0].invoiceId!))
        .get();
      expect(invoice).toBeDefined();
      expect(invoice?.competenceMonth).toBe('2026-11');

      // Idempotency: calling materializeMonth again returns empty and does not duplicate
      const secondCall = materializeMonth(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        competenceMonth: '2026-11',
      });
      expect(secondCall).toHaveLength(0);

      const allTxs = deviceA.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.householdId, HOUSEHOLD_ID),
            eq(transactions.competenceMonth, '2026-11'),
          ),
        )
        .all();
      expect(allTxs).toHaveLength(1);
    });

    it('performs one-tap confirmation from PENDING to CLEARED', () => {
      const salaryRule = createRecurringRule(deviceA.db, {
        id: '55555555-5555-4555-8555-555555555507',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        type: 'INCOME',
        accountId: ACC_CHECKING_ID,
        creditCardId: null,
        categoryId: CAT_SALARY_ID,
        description: 'Salário Mensal',
        amountCents: 850000,
        frequency: 'MONTHLY',
        dayOfMonth: 5,
        startMonth: '2026-01',
        endMonth: null,
        isActive: true,
      });

      const [pendingTx] = materializeMonth(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        competenceMonth: '2026-11',
      });
      expect(pendingTx.status).toBe('PENDING');

      const confirmedTx = confirmPendingTransaction(deviceA.db, pendingTx.id);
      expect(confirmedTx.status).toBe('CLEARED');

      const reloaded = deviceA.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, pendingTx.id))
        .get();
      expect(reloaded?.status).toBe('CLEARED');

      // Calling confirm again is idempotent
      const confirmedAgain = confirmPendingTransaction(
        deviceA.db,
        pendingTx.id,
      );
      expect(confirmedAgain.status).toBe('CLEARED');
    });

    it('clamps days for shorter months and respects yearly frequency', () => {
      // Rule on day 31
      createRecurringRule(deviceA.db, {
        id: '55555555-5555-4555-8555-555555555508',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        type: 'EXPENSE',
        accountId: ACC_CHECKING_ID,
        creditCardId: null,
        categoryId: CAT_BILLS_ID,
        description: 'Fim do Mês',
        amountCents: 10000,
        frequency: 'MONTHLY',
        dayOfMonth: 31,
        startMonth: '2026-01',
        endMonth: null,
        isActive: true,
      });

      // Yearly rule in February only
      createRecurringRule(deviceA.db, {
        id: '55555555-5555-4555-8555-555555555509',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        type: 'EXPENSE',
        accountId: ACC_CHECKING_ID,
        creditCardId: null,
        categoryId: CAT_BILLS_ID,
        description: 'Anuidade Seguro',
        amountCents: 120000,
        frequency: 'YEARLY',
        dayOfMonth: 10,
        startMonth: '2026-02',
        endMonth: null,
        isActive: true,
      });

      // Materialize February 2026 (non-leap year: 28 days)
      const febMaterialized = materializeMonth(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        competenceMonth: '2026-02',
      });
      expect(febMaterialized).toHaveLength(2);

      const endOfMonthTx = febMaterialized.find((t) =>
        t.description.includes('Fim do Mês'),
      );
      expect(endOfMonthTx?.transactionDate).toBe('2026-02-28');

      // Materialize March 2026: yearly insurance rule should NOT materialize
      const marMaterialized = materializeMonth(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        competenceMonth: '2026-03',
      });
      expect(marMaterialized).toHaveLength(1);
      expect(marMaterialized[0].description).toBe('Fim do Mês');
      expect(marMaterialized[0].transactionDate).toBe('2026-03-31');
    });

    it('computes monthly projection summary and filters occurrences by ownership', () => {
      createRecurringRule(deviceA.db, {
        id: '55555555-5555-4555-8555-555555555510',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        type: 'INCOME',
        accountId: ACC_CHECKING_ID,
        creditCardId: null,
        categoryId: CAT_SALARY_ID,
        description: 'Salário Diogo',
        amountCents: 1000000,
        frequency: 'MONTHLY',
        dayOfMonth: 5,
        startMonth: '2026-01',
        endMonth: null,
        isActive: true,
      });

      createRecurringRule(deviceA.db, {
        id: '55555555-5555-4555-8555-555555555511',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_B_ID,
        type: 'INCOME',
        accountId: ACC_CHECKING_ID,
        creditCardId: null,
        categoryId: CAT_SALARY_ID,
        description: 'Salário Ana',
        amountCents: 800000,
        frequency: 'MONTHLY',
        dayOfMonth: 5,
        startMonth: '2026-01',
        endMonth: null,
        isActive: true,
      });

      createRecurringRule(deviceA.db, {
        id: '55555555-5555-4555-8555-555555555512',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        type: 'EXPENSE',
        accountId: ACC_CHECKING_ID,
        creditCardId: null,
        categoryId: CAT_BILLS_ID,
        description: 'Aluguel Casa',
        amountCents: 450000,
        frequency: 'MONTHLY',
        dayOfMonth: 10,
        startMonth: '2026-01',
        endMonth: null,
        isActive: true,
      });

      materializeMonth(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        competenceMonth: '2026-11',
      });

      const txList = deviceA.db
        .select()
        .from(transactions)
        .where(eq(transactions.competenceMonth, '2026-11'))
        .all();

      const summary = calculateRecurringProjectionSummary(txList);
      expect(summary.projectedIncomeCents).toBe(1800000);
      expect(summary.projectedExpenseCents).toBe(450000);
      expect(summary.projectedNetBalanceCents).toBe(1350000);
      expect(summary.pendingCount).toBe(3);
      expect(summary.clearedCount).toBe(0);

      // Ownership filter test
      const consolidated = listRecurringOccurrencesForMonth(
        deviceA.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'CONSOLIDATED' },
      );
      expect(consolidated).toHaveLength(3);

      const userAOnly = listRecurringOccurrencesForMonth(
        deviceA.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'USER', userId: USER_A_ID },
      );
      expect(userAOnly).toHaveLength(1); // Salário Diogo

      const userBOnly = listRecurringOccurrencesForMonth(
        deviceA.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'USER', userId: USER_B_ID },
      );
      expect(userBOnly).toHaveLength(1); // Salário Ana

      const domesticOnly = listRecurringOccurrencesForMonth(
        deviceA.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'DOMESTIC' },
      );
      expect(domesticOnly).toHaveLength(1); // Aluguel Casa (joint / null)

      // Details listing
      const rulesWithDetails = listRecurringRulesWithDetails(
        deviceA.db,
        HOUSEHOLD_ID,
      );
      expect(rulesWithDetails).toHaveLength(3);
      expect(rulesWithDetails[0].category).toBeDefined();
    });
  });

  describe('T8.3 — Acceptance Gate: Dual-Client Offline Materialization (TEST-FIN-06)', () => {
    it('converges to a single row without duplicates when two offline clients materialize the same month', () => {
      // 1. Create recurring rule on Device A
      const fiberRule = createRecurringRule(
        deviceA.db,
        {
          id: '55555555-5555-4555-8555-555555555520',
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: null,
          type: 'EXPENSE',
          accountId: ACC_CHECKING_ID,
          creditCardId: null,
          categoryId: CAT_BILLS_ID,
          description: 'Internet Fibra Nós',
          amountCents: 15990,
          frequency: 'MONTHLY',
          dayOfMonth: 15,
          startMonth: '2026-01',
          endMonth: null,
          isActive: true,
        },
        { nowMs: 1762700000000, nodeId: 'deviceaaaaaa' },
      );

      // Sync rule to Device B before going offline
      const syncRule = reconcilePeerOutbox(deviceA.db, deviceB.db, {
        nowMs: 1762700001000,
      });
      expect(syncRule.pushedCount).toBeGreaterThan(0);

      const deviceBRule = deviceB.db
        .select()
        .from(recurringRules)
        .where(eq(recurringRules.id, fiberRule.id))
        .get();
      expect(deviceBRule).toBeDefined();
      expect(deviceBRule?.amountCents).toBe(15990);

      // 2. Both devices go OFFLINE and independently open month 2026-12
      const [deviceATx] = materializeMonth(
        deviceA.db,
        {
          householdId: HOUSEHOLD_ID,
          competenceMonth: '2026-12',
        },
        { nowMs: 1762700010000, nodeId: 'deviceaaaaaa' },
      );

      const [deviceBTx] = materializeMonth(
        deviceB.db,
        {
          householdId: HOUSEHOLD_ID,
          competenceMonth: '2026-12',
        },
        { nowMs: 1762700020000, nodeId: 'devicebbbbbb' },
      );

      // Both must generate the EXACT same deterministic UUIDv5 primary key
      const expectedTxId = generateRecurringTransactionId(
        fiberRule.id,
        '2026-12',
      );
      expect(deviceATx.id).toBe(expectedTxId);
      expect(deviceBTx.id).toBe(expectedTxId);
      expect(deviceATx.id).toBe(deviceBTx.id);
      expect(deviceATx.status).toBe('PENDING');
      expect(deviceBTx.status).toBe('PENDING');

      // 3. Reconnect & Sync: Device A pushes outbox to Device B
      const syncAtoB = reconcilePeerOutbox(deviceA.db, deviceB.db, {
        nowMs: 1762700030000,
      });
      expect(syncAtoB.pushedCount).toBeGreaterThan(0);

      // Device B must still have EXACTLY 1 row for 2026-12 (No duplication!)
      const bTxs = deviceB.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.recurringRuleId, fiberRule.id),
            eq(transactions.competenceMonth, '2026-12'),
            isNull(transactions.deletedAt),
          ),
        )
        .all();
      expect(bTxs).toHaveLength(1);
      expect(bTxs[0].id).toBe(expectedTxId);

      // 4. Device B confirms the bill (PENDING -> CLEARED) offline
      const clearedBTx = confirmPendingTransaction(
        deviceB.db,
        expectedTxId,
        { nowMs: 1762700040000, nodeId: 'devicebbbbbb' },
      );
      expect(clearedBTx.status).toBe('CLEARED');

      // 5. Device B syncs to Device A
      const syncBtoA = reconcilePeerOutbox(deviceB.db, deviceA.db, {
        nowMs: 1762700050000,
      });
      expect(syncBtoA.pushedCount).toBeGreaterThan(0);

      // Device A now converges to CLEARED, with zero duplicate rows
      const aTxs = deviceA.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.recurringRuleId, fiberRule.id),
            eq(transactions.competenceMonth, '2026-12'),
            isNull(transactions.deletedAt),
          ),
        )
        .all();
      expect(aTxs).toHaveLength(1);
      expect(aTxs[0].id).toBe(expectedTxId);
      expect(aTxs[0].status).toBe('CLEARED');

      // 6. Device A re-runs materialization locally for 2026-12:
      // It must NOT reset or overwrite the CLEARED status back to PENDING
      const reMaterialize = materializeMonth(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        competenceMonth: '2026-12',
      });
      expect(reMaterialize).toHaveLength(0);

      const finalCheck = deviceA.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, expectedTxId))
        .get();
      expect(finalCheck?.status).toBe('CLEARED');
    });
  });
});
