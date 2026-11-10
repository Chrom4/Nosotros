import { eq } from 'drizzle-orm';
import {
  calculateAccountBalanceCents,
  calculateBudgetConsumedCents,
  calculateCreditCardAvailableLimitCents,
  calculateInvoiceDebtCents,
  calculateMonthlySummaryCents,
  calculateNetWorthCents,
} from '@/core';
import {
  accounts,
  closeCreditCardInvoice,
  computeCreditCardsWithLimits,
  computeInvoicesWithDetails,
  createAccount,
  createCategory,
  createCreditCard,
  createCreditCardPurchase,
  createCreditCardRefund,
  createInstallmentPurchase,
  creditCardInvoices,
  creditCards,
  editInstallmentScopeA,
  editInstallmentScopeB,
  installmentPlans,
  listAccountsWithBalances,
  listCreditCardsWithLimits,
  listInstallmentPlansWithSlices,
  mapAccountRowToLedger,
  mapCreditCardRowToLedger,
  mapInvoiceRowToLedger,
  mapTransactionRowToLedger,
  payCreditCardInvoice,
  queryTwelveMonthAggregate,
  reconcilePeerOutbox,
  reopenCreditCardInvoice,
  resetCachedDatabaseForTests,
  setActiveDatabaseForTests,
  softDeleteCreditCard,
  softDeleteInstallmentPlan,
  syncOutbox,
  transactions,
  updateCreditCard,
  upsertLocalHousehold,
  upsertLocalHouseholdMember,
} from '@/data';
import { createInMemoryTestDb, type InMemoryTestDb } from './testDbHelper';

const HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';
const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ACC_USER_A_ID = '22222222-2222-4222-8222-222222222201';
const ACC_JOINT_ID = '22222222-2222-4222-8222-222222222202';

const CAT_MARKET_ID = '33333333-3333-4333-8333-333333333301';
const CAT_APPLIANCES_ID = '33333333-3333-4333-8333-333333333302';

const CARD_A_ID = '44444444-4444-4444-8444-444444444401';

describe('Phase 7 — Credit Cards, Invoices, Installments (Scopes A/B) & Invoice Payments', () => {
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
        name: 'Lar Nosotros',
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
    }

    createAccount(deviceA.db, {
      id: ACC_USER_A_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_A_ID,
      name: 'Conta Corrente Diogo',
      type: 'CHECKING',
      initialBalanceCents: 500000, // R$ 5.000,00
      includeInNetWorth: true,
      isArchived: false,
    });

    createAccount(deviceA.db, {
      id: ACC_JOINT_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: null,
      name: 'Conta Conjunta Casa',
      type: 'CHECKING',
      initialBalanceCents: 200000, // R$ 2.000,00
      includeInNetWorth: true,
      isArchived: false,
    });

    createCategory(deviceA.db, {
      id: CAT_MARKET_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Supermercado',
      kind: 'EXPENSE',
      colorHex: '#10B981',
      iconName: 'shopping-cart',
    });

    createCategory(deviceA.db, {
      id: CAT_APPLIANCES_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Eletrodomésticos',
      kind: 'EXPENSE',
      colorHex: '#6366F1',
      iconName: 'home',
    });

    createCreditCard(deviceA.db, {
      id: CARD_A_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_A_ID,
      defaultPaymentAccountId: ACC_USER_A_ID,
      name: 'Nubank Ultravioleta',
      limitCents: 300000, // R$ 3.000,00
      closingDay: 10,
      dueDay: 17,
      isArchived: false,
    });
  });

  afterEach(() => {
    resetCachedDatabaseForTests();
    deviceA.close();
    deviceB.close();
  });

  describe('T7.1 & TEST-FIN-02 — Credit Card Purchase, Refund, Partial & Full Invoice Payment without Double Counting', () => {
    it('persists CREDIT_PURCHASE, CREDIT_REFUND, and partial/full INVOICE_PAYMENT matching core accounting invariants', () => {
      // 1. One-shot CREDIT_PURCHASE of R$ 450,00 (45000 cents) on 2026-11-05 (before closingDay 10 -> 2026-11 invoice)
      const purchaseRes = createCreditCardPurchase(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        creditCardId: CARD_A_ID,
        categoryId: CAT_MARKET_ID,
        amountCents: 45000,
        transactionDate: '2026-11-05',
        description: 'Compras do Mês',
      });

      expect(purchaseRes.invoice.competenceMonth).toBe('2026-11');
      expect(purchaseRes.invoice.status).toBe('OPEN');
      expect(purchaseRes.transaction.accountId).toBeNull();
      expect(purchaseRes.transaction.invoiceId).toBe(purchaseRes.invoice.id);

      // 2. Partial CREDIT_REFUND of R$ 50,00 (5000 cents) on 2026-11-06 -> net invoice debt becomes R$ 400,00 (40000 cents)
      const refundRes = createCreditCardRefund(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        creditCardId: CARD_A_ID,
        categoryId: CAT_MARKET_ID,
        amountCents: 5000,
        transactionDate: '2026-11-06',
        description: 'Estorno Item em Falta',
        refundedTransactionId: purchaseRes.transaction.id,
      });
      expect(refundRes.invoice.id).toBe(purchaseRes.invoice.id);

      const getLedgerState = () => {
        const accRows = deviceA.db.select().from(accounts).all();
        const cardRows = deviceA.db.select().from(creditCards).all();
        const invRows = deviceA.db.select().from(creditCardInvoices).all();
        const txRows = deviceA.db.select().from(transactions).all();
        return {
          accounts: accRows.map(mapAccountRowToLedger),
          cards: cardRows.map(mapCreditCardRowToLedger),
          invoices: invRows.map(mapInvoiceRowToLedger),
          txs: txRows.map(mapTransactionRowToLedger),
          rawInvoices: invRows,
          rawCards: cardRows,
          rawTxs: txRows,
        };
      };

      let state = getLedgerState();
      // Bank account balance is completely untouched (500000)
      expect(
        calculateAccountBalanceCents(ACC_USER_A_ID, 500000, state.txs),
      ).toBe(500000);
      // Net invoice debt is 45000 - 5000 = 40000
      expect(calculateInvoiceDebtCents(purchaseRes.invoice.id, state.txs)).toBe(
        40000,
      );
      // Available limit is 300000 - 40000 = 260000
      expect(
        calculateCreditCardAvailableLimitCents(
          state.cards[0],
          state.txs,
          state.invoices,
        ),
      ).toBe(260000);
      // Monthly summary in 2026-11: expense = 40000, income = 0
      expect(calculateMonthlySummaryCents('2026-11', state.txs)).toEqual({
        incomeCents: 0,
        expenseCents: 40000,
        netSavingsCents: -40000,
      });
      // Budget consumed in CAT_MARKET_ID for 2026-11 is 40000
      expect(
        calculateBudgetConsumedCents(CAT_MARKET_ID, '2026-11', state.txs),
      ).toBe(40000);
      // Net Worth: (500000 + 200000) - 40000 = 660000
      expect(
        calculateNetWorthCents(state.accounts, state.invoices, state.txs),
      ).toBe(660000);

      // 3. Close the November invoice
      const closedInv = closeCreditCardInvoice(
        deviceA.db,
        purchaseRes.invoice.id,
      );
      expect(closedInv.status).toBe('CLOSED');

      // Cannot add new purchases to a CLOSED invoice
      expect(() =>
        createCreditCardPurchase(deviceA.db, {
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: USER_A_ID,
          creditCardId: CARD_A_ID,
          categoryId: CAT_MARKET_ID,
          amountCents: 1000,
          transactionDate: '2026-11-07',
          description: 'Compra Bloqueada em Fatura Fechada',
        }),
      ).toThrow(/CLOSED invoice/);

      // 4. Partial invoice payment of R$ 150,00 (15000 cents) on 2026-12-01
      const partialPay = payCreditCardInvoice(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        invoiceId: purchaseRes.invoice.id,
        amountCents: 15000,
        paymentDate: '2026-12-01',
      });

      expect(partialPay.isFullPayment).toBe(false);
      expect(partialPay.remainingDebtCents).toBe(25000);
      expect(partialPay.invoice.status).toBe('CLOSED'); // Remains CLOSED until remaining debt is 0
      expect(partialPay.paymentTransaction.type).toBe('INVOICE_PAYMENT');
      expect(partialPay.paymentTransaction.categoryId).toBeNull();
      expect(partialPay.paymentTransaction.accountId).toBe(ACC_USER_A_ID);

      state = getLedgerState();
      // Bank balance reduced by 15000 -> 485000
      expect(
        calculateAccountBalanceCents(ACC_USER_A_ID, 500000, state.txs),
      ).toBe(485000);
      // Remaining invoice debt is 25000
      expect(calculateInvoiceDebtCents(purchaseRes.invoice.id, state.txs)).toBe(
        25000,
      );
      // Available card limit restored by 15000 -> 275000
      expect(
        calculateCreditCardAvailableLimitCents(
          state.cards[0],
          state.txs,
          state.invoices,
        ),
      ).toBe(275000);
      // Net worth remains strictly neutral at 660000!
      expect(
        calculateNetWorthCents(state.accounts, state.invoices, state.txs),
      ).toBe(660000);

      // 5. Final full payment of the remaining R$ 250,00 (25000 cents) on 2026-12-05
      const finalPay = payCreditCardInvoice(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        invoiceId: purchaseRes.invoice.id,
        paymentDate: '2026-12-05', // Omitting amountCents pays the exact remaining 25000 debt
      });

      expect(finalPay.isFullPayment).toBe(true);
      expect(finalPay.paidAmountCents).toBe(25000);
      expect(finalPay.remainingDebtCents).toBe(0);
      expect(finalPay.invoice.status).toBe('PAID');

      state = getLedgerState();
      expect(
        calculateAccountBalanceCents(ACC_USER_A_ID, 500000, state.txs),
      ).toBe(460000);
      expect(calculateInvoiceDebtCents(purchaseRes.invoice.id, state.txs)).toBe(
        0,
      );
      expect(
        calculateCreditCardAvailableLimitCents(
          state.cards[0],
          state.txs,
          state.invoices,
        ),
      ).toBe(300000);
      expect(
        calculateNetWorthCents(state.accounts, state.invoices, state.txs),
      ).toBe(660000);

      // CRITICAL GATE (TEST-FIN-02): Payment month (2026-12) has ZERO new expenses!
      expect(calculateMonthlySummaryCents('2026-12', state.txs)).toEqual({
        incomeCents: 0,
        expenseCents: 0,
        netSavingsCents: 0,
      });

      const sqlAgg = queryTwelveMonthAggregate(
        deviceA.db,
        HOUSEHOLD_ID,
        '2026-11',
        '2026-12',
      );
      const novAgg = sqlAgg.find((r) => r.competenceMonth === '2026-11');
      const decAgg = sqlAgg.find((r) => r.competenceMonth === '2026-12');
      expect(novAgg?.expenseCents).toBe(40000);
      expect(decAgg?.expenseCents ?? 0).toBe(0);

      // Rejects paying an already-paid invoice with 0 debt
      expect(() =>
        payCreditCardInvoice(deviceA.db, {
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          invoiceId: purchaseRes.invoice.id,
          paymentDate: '2026-12-06',
        }),
      ).toThrow(/no remaining unpaid debt/);
    });
  });

  describe('TEST-FIN-05 — Closing-Day Allocation & Historical Invoice Immutability', () => {
    it('allocates purchases before vs on/after closing_day and preserves historical invoice dates when card closing_day changes', () => {
      // Card has closingDay = 10, dueDay = 17
      // 1. Purchase on 2026-11-09 (< 10) -> allocated to 2026-11
      const pNov9 = createCreditCardPurchase(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        creditCardId: CARD_A_ID,
        categoryId: CAT_MARKET_ID,
        amountCents: 12000,
        transactionDate: '2026-11-09',
        description: 'Compra antes do fechamento',
      });
      expect(pNov9.invoice.competenceMonth).toBe('2026-11');
      expect(pNov9.invoice.closingDate).toBe('2026-11-10');
      expect(pNov9.invoice.dueDate).toBe('2026-11-17');

      // 2. Purchase on 2026-11-10 (>= 10) -> allocated to 2026-12
      const pNov10 = createCreditCardPurchase(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        creditCardId: CARD_A_ID,
        categoryId: CAT_MARKET_ID,
        amountCents: 18000,
        transactionDate: '2026-11-10',
        description: 'Compra no dia do fechamento',
      });
      expect(pNov10.invoice.competenceMonth).toBe('2026-12');
      expect(pNov10.invoice.closingDate).toBe('2026-12-10');
      expect(pNov10.invoice.dueDate).toBe('2026-12-17');

      // 3. Close November invoice and then change card closingDay to 20 and dueDay to 28
      closeCreditCardInvoice(deviceA.db, pNov9.invoice.id);
      const updatedCard = updateCreditCard(deviceA.db, CARD_A_ID, {
        closingDay: 20,
        dueDay: 28,
      });
      expect(updatedCard.closingDay).toBe(20);
      expect(updatedCard.dueDay).toBe(28);

      // 4. Purchase on 2026-12-15 (< new closingDay 20) -> allocated to 2026-12
      const pDec15 = createCreditCardPurchase(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        creditCardId: CARD_A_ID,
        categoryId: CAT_MARKET_ID,
        amountCents: 9000,
        transactionDate: '2026-12-15',
        description: 'Compra Dezembro antes do novo dia 20',
      });
      expect(pDec15.invoice.competenceMonth).toBe('2026-12');

      // 5. Purchase on 2026-12-20 (>= new closingDay 20) -> allocated to 2027-01 with new cycle dates
      const pDec20 = createCreditCardPurchase(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        creditCardId: CARD_A_ID,
        categoryId: CAT_MARKET_ID,
        amountCents: 22000,
        transactionDate: '2026-12-20',
        description: 'Compra Dezembro no novo fechamento dia 20',
      });
      expect(pDec20.invoice.competenceMonth).toBe('2027-01');
      expect(pDec20.invoice.closingDate).toBe('2027-01-20');
      expect(pDec20.invoice.dueDate).toBe('2027-01-28');

      // Verify historical November invoice remained 100% immutable
      const persistedNovInv = deviceA.db
        .select()
        .from(creditCardInvoices)
        .where(eq(creditCardInvoices.id, pNov9.invoice.id))
        .get()!;
      expect(persistedNovInv.closingDate).toBe('2026-11-10');
      expect(persistedNovInv.dueDate).toBe('2026-11-17');
      expect(persistedNovInv.status).toBe('CLOSED');
    });
  });

  describe('T7.1 & T7.2 — Installment Creation (Remainder on 1st Slice) & Edit Scopes A and B', () => {
    it('creates 3x installment plan sharing one batchId, enforces Scope A & Scope B edits, protects CLOSED/PAID invoices, and recalculates plan total', () => {
      const planId = '77777777-7777-4777-8777-777777777701';

      // Create R$ 100,00 (10000 cents) in 3x on 2026-11-05 (shared domestic purchase on User A's card -> DEC-02)
      const created = createInstallmentPurchase(deviceA.db, {
        plan: {
          id: planId,
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: null, // Domestic/Shared
          creditCardId: CARD_A_ID,
          accountId: null,
          categoryId: CAT_APPLIANCES_ID,
          description: 'Lava-louças',
          totalAmountCents: 10000,
          totalInstallments: 3,
          purchaseDate: '2026-11-05',
        },
      });

      expect(created.installments.map((t) => t.amountCents)).toEqual([
        3334, 3333, 3333,
      ]);
      expect(created.installments.map((t) => t.competenceMonth)).toEqual([
        '2026-11',
        '2026-12',
        '2027-01',
      ]);
      // DEC-02: Shared expense on individual card -> isHouseholdContribution = true
      expect(
        created.installments.every((t) => t.isHouseholdContribution === true),
      ).toBe(true);

      // Verify all outbox entries from this composite write share the exact same batchId
      const batchRows = deviceA.db
        .select()
        .from(syncOutbox)
        .where(eq(syncOutbox.batchId, created.batchId))
        .all();
      // 1 installment_plans + 3 credit_card_invoices + 3 transactions = 7 outbox records in 1 batchId
      expect(batchRows).toHaveLength(7);

      // Available limit on card immediately reflects all 3 unpaid installments: 300000 - 10000 = 290000
      const cardsSummary = listCreditCardsWithLimits(deviceA.db, HOUSEHOLD_ID);
      expect(cardsSummary[0].availableLimitCents).toBe(290000);
      expect(cardsSummary[0].usedLimitCents).toBe(10000);

      // Close and pay the 1st invoice (2026-11)
      const invNovId = created.installments[0].invoiceId!;
      closeCreditCardInvoice(deviceA.db, invNovId);
      payCreditCardInvoice(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        invoiceId: invNovId,
        paymentDate: '2026-11-17',
      });

      // Scope A edit on slice 1 (PAID invoice) must be rejected
      expect(() =>
        editInstallmentScopeA(deviceA.db, {
          transactionId: created.installments[0].id,
          changes: { amountCents: 4000 },
        }),
      ).toThrow(/PAID invoice/);

      // Scope A edit on slice 2 (OPEN invoice 2026-12) updates only slice 2 and recalculates plan total
      const scopeARes = editInstallmentScopeA(deviceA.db, {
        transactionId: created.installments[1].id,
        changes: {
          amountCents: 4500,
          description: 'Lava-louças (2/3) Ajuste Frete',
        },
      });
      // 3334 + 4500 + 3333 = 11167
      expect(scopeARes.newTotalAmountCents).toBe(11167);
      expect(scopeARes.plan.totalAmountCents).toBe(11167);

      // Scope B edit starting from installment 1 (`fromInstallmentNumber: 1`) with amountCents = 4000:
      // Slice 1 is in a PAID invoice -> untouched (3334).
      // Slices 2 & 3 are in OPEN invoices -> both updated to 4000.
      // New plan total = 3334 + 4000 + 4000 = 11334.
      const scopeBRes = editInstallmentScopeB(deviceA.db, {
        installmentPlanId: planId,
        fromInstallmentNumber: 1,
        changes: {
          amountCents: 4000,
          description: 'Lava-louças Inox',
        },
      });

      expect(scopeBRes.skippedLockedCount).toBe(1);
      expect(scopeBRes.updatedTransactions).toHaveLength(2);
      expect(scopeBRes.newTotalAmountCents).toBe(11334);
      expect(scopeBRes.plan.totalAmountCents).toBe(11334);

      const plansAfter = listInstallmentPlansWithSlices(
        deviceA.db,
        HOUSEHOLD_ID,
      );
      expect(plansAfter).toHaveLength(1);
      expect(
        plansAfter[0].slices.map((s) => s.transaction.amountCents),
      ).toEqual([3334, 4000, 4000]);
      expect(plansAfter[0].canCancelAll).toBe(false);

      // Cannot hard-cancel whole plan because slice 1 is in a PAID invoice
      expect(() => softDeleteInstallmentPlan(deviceA.db, planId)).toThrow(
        /CLOSED or PAID/,
      );
    });
  });

  describe('T7.3 — Offline Peer Sync A↔B for Credit Cards, Invoices, Installments & Payments', () => {
    it('reconciles cards, invoices, installment plans, and invoice payments from Device A to Device B in topological order', () => {
      const planId = '77777777-7777-4777-8777-777777777799';
      const created = createInstallmentPurchase(deviceA.db, {
        plan: {
          id: planId,
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: USER_A_ID,
          creditCardId: CARD_A_ID,
          accountId: null,
          categoryId: CAT_APPLIANCES_ID,
          description: 'Notebook Trabalho',
          totalAmountCents: 30000,
          totalInstallments: 2,
          purchaseDate: '2026-11-05',
        },
      });

      // Pay the 1st installment invoice (2026-11, 15000 cents) on Device A
      const invNovId = created.installments[0].invoiceId!;
      payCreditCardInvoice(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        invoiceId: invNovId,
        paymentDate: '2026-11-17',
      });

      // Reconcile Device A -> Device B
      const syncSummary = reconcilePeerOutbox(deviceA.db, deviceB.db);
      expect(syncSummary.pushedCount).toBeGreaterThan(0);

      // Verify Device B has identical card available limit, invoice statuses, and account balance
      const cardsA = listCreditCardsWithLimits(deviceA.db, HOUSEHOLD_ID);
      const cardsB = listCreditCardsWithLimits(deviceB.db, HOUSEHOLD_ID);
      expect(cardsB).toHaveLength(1);
      expect(cardsB[0].availableLimitCents).toBe(cardsA[0].availableLimitCents);
      expect(cardsB[0].availableLimitCents).toBe(285000); // 300000 - 15000 (Dec slice)

      const accBalancesB = listAccountsWithBalances(deviceB.db, HOUSEHOLD_ID);
      const accABalanceOnB = accBalancesB.find(
        (a) => a.account.id === ACC_USER_A_ID,
      )?.balanceCents;
      expect(accABalanceOnB).toBe(500000 - 15000);

      // Verify reopen & soft-delete card helpers work cleanly
      const invDecId = created.installments[1].invoiceId!;
      closeCreditCardInvoice(deviceB.db, invDecId);
      const reopened = reopenCreditCardInvoice(deviceB.db, invDecId);
      expect(reopened.status).toBe('OPEN');

      const detailsB = computeInvoicesWithDetails(
        deviceB.db.select().from(creditCardInvoices).all(),
        deviceB.db.select().from(creditCards).all(),
        deviceB.db.select().from(transactions).all(),
        { creditCardId: CARD_A_ID, statusFilter: 'OPEN' },
      );
      expect(detailsB).toHaveLength(1);
      expect(detailsB[0].debtCents).toBe(15000);

      const deletedCard = softDeleteCreditCard(deviceB.db, CARD_A_ID);
      expect(deletedCard.deletedAt).not.toBeNull();
      expect(
        computeCreditCardsWithLimits(
          deviceB.db.select().from(creditCards).all(),
          deviceB.db.select().from(creditCardInvoices).all(),
          deviceB.db.select().from(transactions).all(),
        ),
      ).toHaveLength(0);

      const rawPlanOnB = deviceB.db
        .select()
        .from(installmentPlans)
        .where(eq(installmentPlans.id, planId))
        .get();
      expect(rawPlanOnB?.totalAmountCents).toBe(30000);
    });
  });
});
