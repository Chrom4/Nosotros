import {
  addMonthsToCompetence,
  applyInstallmentScopeBEdit,
  assertTransactionInvariants,
  assertValidCents,
  calculateAccountBalanceCents,
  calculateBudgetConsumedCents,
  calculateCreditCardAvailableLimitCents,
  calculateHouseholdContributions,
  calculateInvoiceDebtCents,
  calculateMonthlySummaryCents,
  calculateNetWorthCents,
  canHardCancelInstallmentPlan,
  computeInvoiceCycleDates,
  recalculateInstallmentPlanTotalCents,
  resolveInvoiceCompetenceMonth,
  splitInstallments,
  type LedgerAccount,
  type LedgerCreditCard,
  type LedgerInvoice,
  type LedgerTransaction,
} from '@/core/accounting';

describe('Phase 1 — Pure Accounting Core (/src/core/accounting.ts)', () => {
  describe('TEST-FIN-01: Installment splitting with repeating decimal remainder on 1st slice', () => {
    it('splits R$ 100.00 (10000 cents) in 3x into [3334, 3333, 3333] across 2026-11, 2026-12, 2027-01', () => {
      const slices = splitInstallments(10000, 3, '2026-11');

      expect(slices).toHaveLength(3);
      expect(slices.map((s) => s.amountCents)).toEqual([3334, 3333, 3333]);
      expect(slices.map((s) => s.competenceMonth)).toEqual([
        '2026-11',
        '2026-12',
        '2027-01',
      ]);
      expect(slices.map((s) => s.installmentNumber)).toEqual([1, 2, 3]);
      expect(slices.every((s) => s.totalInstallments === 3)).toBe(true);

      const sumCents = slices.reduce((acc, s) => acc + s.amountCents, 0);
      expect(sumCents).toBe(10000);
    });

    it('rejects non-integer, negative, or out-of-range installment inputs', () => {
      expect(() => assertValidCents(0)).toThrow();
      expect(() => assertValidCents(-100)).toThrow();
      expect(() => assertValidCents(19.99)).toThrow();
      expect(() => splitInstallments(10000, 1, '2026-11')).toThrow();
      expect(() => splitInstallments(10000, 241, '2026-11')).toThrow();
    });
  });

  describe('TEST-FIN-02: Full credit card purchase and invoice payment cycle without double counting', () => {
    const accountA: LedgerAccount = {
      id: 'acc-a',
      ownerUserId: 'user-a',
      initialBalanceCents: 500000, // R$ 5,000.00
      includeInNetWorth: true,
      deletedAt: null,
    };

    const cardA: LedgerCreditCard = {
      id: 'card-a',
      ownerUserId: 'user-a',
      limitCents: 300000, // R$ 3,000.00
      closingDay: 10,
      dueDay: 17,
      deletedAt: null,
    };

    const invNov: LedgerInvoice = {
      id: 'inv-2026-11',
      creditCardId: 'card-a',
      competenceMonth: '2026-11',
      closingDate: '2026-11-10',
      dueDate: '2026-11-17',
      status: 'OPEN',
      deletedAt: null,
    };

    const purchaseTx: LedgerTransaction = {
      id: 'tx-purchase-1',
      type: 'CREDIT_PURCHASE',
      status: 'CLEARED',
      amountCents: 40000, // R$ 400.00
      transactionDate: '2026-11-05',
      competenceMonth: '2026-11',
      accountId: null,
      transferAccountId: null,
      creditCardId: 'card-a',
      invoiceId: 'inv-2026-11',
      categoryId: 'cat-supermarket',
      ownerUserId: 'user-a',
      isHouseholdContribution: false,
      deletedAt: null,
    };

    it('keeps bank account untouched on CREDIT_PURCHASE, increases invoice debt, and reduces card limit & net worth', () => {
      const txs = [purchaseTx];

      expect(calculateAccountBalanceCents(accountA.id, accountA.initialBalanceCents, txs)).toBe(
        500000,
      );
      expect(calculateInvoiceDebtCents(invNov.id, txs)).toBe(40000);
      expect(calculateCreditCardAvailableLimitCents(cardA, txs, [invNov])).toBe(260000);

      const novSummary = calculateMonthlySummaryCents('2026-11', txs);
      expect(novSummary.expenseCents).toBe(40000);
      expect(novSummary.incomeCents).toBe(0);

      expect(calculateNetWorthCents([accountA], [invNov], txs)).toBe(460000);
    });

    it('settles invoice on INVOICE_PAYMENT: reduces bank balance, zeroes invoice debt, restores card limit, keeps net worth neutral, and adds 0 to expenses', () => {
      const paymentTx: LedgerTransaction = {
        id: 'tx-payment-1',
        type: 'INVOICE_PAYMENT',
        status: 'CLEARED',
        amountCents: 40000,
        transactionDate: '2026-12-05',
        competenceMonth: '2026-12',
        accountId: 'acc-a',
        transferAccountId: null,
        creditCardId: 'card-a',
        invoiceId: 'inv-2026-11',
        categoryId: null,
        ownerUserId: 'user-a',
        isHouseholdContribution: false,
        deletedAt: null,
      };

      const txs = [purchaseTx, paymentTx];
      const paidInvoice: LedgerInvoice = { ...invNov, status: 'PAID' };

      expect(calculateAccountBalanceCents(accountA.id, accountA.initialBalanceCents, txs)).toBe(
        460000,
      );
      expect(calculateInvoiceDebtCents(invNov.id, txs)).toBe(0);
      expect(calculateCreditCardAvailableLimitCents(cardA, txs, [paidInvoice])).toBe(300000);

      const decSummary = calculateMonthlySummaryCents('2026-12', txs);
      expect(decSummary.expenseCents).toBe(0);
      expect(decSummary.incomeCents).toBe(0);

      expect(calculateNetWorthCents([accountA], [paidInvoice], txs)).toBe(460000);
    });
  });

  describe('TEST-FIN-03: Internal transfer, couple household contributions, and DEC-02', () => {
    const accountA: LedgerAccount = {
      id: 'acc-a',
      ownerUserId: 'user-a',
      initialBalanceCents: 600000, // R$ 6,000.00
      includeInNetWorth: true,
      deletedAt: null,
    };
    const accountB: LedgerAccount = {
      id: 'acc-b',
      ownerUserId: 'user-b',
      initialBalanceCents: 400000, // R$ 4,000.00
      includeInNetWorth: true,
      deletedAt: null,
    };
    const jointAccount: LedgerAccount = {
      id: 'acc-joint',
      ownerUserId: null,
      initialBalanceCents: 0,
      includeInNetWorth: true,
      deletedAt: null,
    };
    const cardB: LedgerCreditCard = {
      id: 'card-b',
      ownerUserId: 'user-b',
      limitCents: 200000,
      closingDay: 10,
      dueDay: 17,
      deletedAt: null,
    };

    const transferA: LedgerTransaction = {
      id: 'tx-transfer-a',
      type: 'TRANSFER',
      status: 'CLEARED',
      amountCents: 180000, // R$ 1,800.00
      transactionDate: '2026-11-05',
      competenceMonth: '2026-11',
      accountId: 'acc-a',
      transferAccountId: 'acc-joint',
      creditCardId: null,
      invoiceId: null,
      categoryId: null,
      ownerUserId: 'user-a',
      isHouseholdContribution: true,
      deletedAt: null,
    };

    const transferB: LedgerTransaction = {
      id: 'tx-transfer-b',
      type: 'TRANSFER',
      status: 'CLEARED',
      amountCents: 120000, // R$ 1,200.00
      transactionDate: '2026-11-05',
      competenceMonth: '2026-11',
      accountId: 'acc-b',
      transferAccountId: 'acc-joint',
      creditCardId: null,
      invoiceId: null,
      categoryId: null,
      ownerUserId: 'user-b',
      isHouseholdContribution: true,
      deletedAt: null,
    };

    it('updates origin and destination balances while keeping Net Worth, Income, and Expense untouched', () => {
      const accounts = [accountA, accountB, jointAccount];
      const txs = [transferA, transferB];

      expect(calculateAccountBalanceCents('acc-a', accountA.initialBalanceCents, txs)).toBe(
        420000,
      );
      expect(calculateAccountBalanceCents('acc-b', accountB.initialBalanceCents, txs)).toBe(
        280000,
      );
      expect(calculateAccountBalanceCents('acc-joint', jointAccount.initialBalanceCents, txs)).toBe(
        300000,
      );

      expect(calculateNetWorthCents(accounts, [], txs)).toBe(1000000);

      const summary = calculateMonthlySummaryCents('2026-11', txs);
      expect(summary.incomeCents).toBe(0);
      expect(summary.expenseCents).toBe(0);

      const contrib = calculateHouseholdContributions(
        '2026-11',
        ['user-a', 'user-b'],
        accounts,
        [cardB],
        txs,
      );
      expect(contrib.totalContributionCents).toBe(300000);
      expect(contrib.members[0].totalContributionCents).toBe(180000);
      expect(contrib.members[0].sharePercentage).toBe(60);
      expect(contrib.members[1].totalContributionCents).toBe(120000);
      expect(contrib.members[1].sharePercentage).toBe(40);
    });

    it('honors DEC-02: shared expenses (ownerUserId = null) paid via individual account or card count automatically as contributions', () => {
      const directSharedExpenseByB: LedgerTransaction = {
        id: 'tx-shared-direct-b',
        type: 'CREDIT_PURCHASE',
        status: 'CLEARED',
        amountCents: 60000, // R$ 600.00 paid on User B individual card for the house
        transactionDate: '2026-11-12',
        competenceMonth: '2026-11',
        accountId: null,
        transferAccountId: null,
        creditCardId: 'card-b',
        invoiceId: 'inv-b-nov',
        categoryId: 'cat-utilities',
        ownerUserId: null, // Shared/Domestic
        isHouseholdContribution: false,
        deletedAt: null,
      };

      const contrib = calculateHouseholdContributions(
        '2026-11',
        ['user-a', 'user-b'],
        [accountA, accountB, jointAccount],
        [cardB],
        [transferA, transferB, directSharedExpenseByB],
      );

      expect(contrib.members[0].totalContributionCents).toBe(180000); // 50%
      expect(contrib.members[1].explicitTransferCents).toBe(120000);
      expect(contrib.members[1].directDomesticExpenseCents).toBe(60000);
      expect(contrib.members[1].totalContributionCents).toBe(180000); // 50%
      expect(contrib.members[0].sharePercentage).toBe(50);
      expect(contrib.members[1].sharePercentage).toBe(50);
    });
  });

  describe('TEST-FIN-04: Expense refund (CREDIT_REFUND / DEBIT_REFUND) and DEC-01 budget consumption', () => {
    it('offsets category budget consumption to 0 and keeps monthly income at 0 when a 30000 expense is refunded', () => {
      const expenseTx: LedgerTransaction = {
        id: 'tx-lazer-1',
        type: 'EXPENSE',
        status: 'CLEARED',
        amountCents: 30000,
        transactionDate: '2026-11-10',
        competenceMonth: '2026-11',
        accountId: 'acc-b',
        transferAccountId: null,
        creditCardId: null,
        invoiceId: null,
        categoryId: 'cat-lazer',
        ownerUserId: 'user-b',
        isHouseholdContribution: false,
        deletedAt: null,
      };

      const refundTx: LedgerTransaction = {
        id: 'tx-lazer-refund-1',
        type: 'DEBIT_REFUND',
        status: 'CLEARED',
        amountCents: 30000,
        transactionDate: '2026-11-12',
        competenceMonth: '2026-11',
        accountId: 'acc-b',
        transferAccountId: null,
        creditCardId: null,
        invoiceId: null,
        categoryId: 'cat-lazer',
        ownerUserId: 'user-b',
        refundedTransactionId: 'tx-lazer-1',
        isHouseholdContribution: false,
        deletedAt: null,
      };

      const txs = [expenseTx, refundTx];

      expect(calculateBudgetConsumedCents('cat-lazer', '2026-11', txs)).toBe(0);

      const summary = calculateMonthlySummaryCents('2026-11', txs);
      expect(summary.incomeCents).toBe(0);
      expect(summary.expenseCents).toBe(0);
    });

    it('also offsets CREDIT_PURCHASE with CREDIT_REFUND and supports DEC-01 invoice payment cash gating', () => {
      const ccPurchase: LedgerTransaction = {
        id: 'tx-cc-1',
        type: 'CREDIT_PURCHASE',
        status: 'CLEARED',
        amountCents: 30000,
        transactionDate: '2026-11-15',
        competenceMonth: '2026-12', // After closing day 10 -> Dec invoice
        accountId: null,
        transferAccountId: null,
        creditCardId: 'card-a',
        invoiceId: 'inv-dec',
        categoryId: 'cat-lazer',
        ownerUserId: 'user-a',
        isHouseholdContribution: false,
        deletedAt: null,
      };

      const ccRefund: LedgerTransaction = {
        id: 'tx-cc-refund-1',
        type: 'CREDIT_REFUND',
        status: 'CLEARED',
        amountCents: 30000,
        transactionDate: '2026-11-16',
        competenceMonth: '2026-12',
        accountId: null,
        transferAccountId: null,
        creditCardId: 'card-a',
        invoiceId: 'inv-dec',
        categoryId: 'cat-lazer',
        ownerUserId: 'user-a',
        refundedTransactionId: 'tx-cc-1',
        isHouseholdContribution: false,
        deletedAt: null,
      };

      expect(
        calculateBudgetConsumedCents('cat-lazer', '2026-12', [ccPurchase, ccRefund]),
      ).toBe(0);

      // When requireInvoicePaymentCleared is true, unpaid invoice does not consume budget yet
      expect(
        calculateBudgetConsumedCents('cat-lazer', '2026-12', [ccPurchase], {
          requireInvoicePaymentCleared: true,
        }),
      ).toBe(0);

      const invoicePayment: LedgerTransaction = {
        id: 'tx-inv-pay',
        type: 'INVOICE_PAYMENT',
        status: 'CLEARED',
        amountCents: 30000,
        transactionDate: '2026-12-17',
        competenceMonth: '2026-12',
        accountId: 'acc-a',
        transferAccountId: null,
        creditCardId: 'card-a',
        invoiceId: 'inv-dec',
        categoryId: null,
        ownerUserId: 'user-a',
        isHouseholdContribution: false,
        deletedAt: null,
      };

      expect(
        calculateBudgetConsumedCents(
          'cat-lazer',
          '2026-12',
          [ccPurchase, invoicePayment],
          { requireInvoicePaymentCleared: true },
        ),
      ).toBe(30000);
    });
  });

  describe('TEST-FIN-05: Invoice closing_day cutoff rule and historical immutability', () => {
    it('allocates 2026-11-09 to 2026-11 and 2026-11-10 to 2026-12 for closing_day = 10, preserving past invoices when closing_day changes', () => {
      const closingDayNov = 10;

      expect(resolveInvoiceCompetenceMonth('2026-11-09', closingDayNov)).toBe('2026-11');
      expect(resolveInvoiceCompetenceMonth('2026-11-10', closingDayNov)).toBe('2026-12');

      const novDates = computeInvoiceCycleDates('2026-11', closingDayNov, 17);
      const historicalNovInvoice: LedgerInvoice = {
        id: 'inv-2026-11',
        creditCardId: 'card-a',
        competenceMonth: '2026-11',
        closingDate: novDates.closingDate,
        dueDate: novDates.dueDate,
        status: 'CLOSED',
        deletedAt: null,
      };

      // User changes card closing_day to 20 in December
      const updatedCard: LedgerCreditCard = {
        id: 'card-a',
        ownerUserId: 'user-a',
        limitCents: 300000,
        closingDay: 20,
        dueDay: 28,
        deletedAt: null,
      };

      // New purchases use closingDay = 20, while historicalNovInvoice keeps its original id and closingDate
      expect(resolveInvoiceCompetenceMonth('2026-12-15', updatedCard.closingDay)).toBe(
        '2026-12',
      );
      expect(resolveInvoiceCompetenceMonth('2026-12-20', updatedCard.closingDay)).toBe(
        '2027-01',
      );
      expect(historicalNovInvoice.id).toBe('inv-2026-11');
      expect(historicalNovInvoice.closingDate).toBe('2026-11-10');
    });
  });

  describe('Installment Scope A / Scope B edits and transaction pointer invariants', () => {
    it('protects CLOSED/PAID invoices during Scope B edit and recalculates plan total', () => {
      const invoices: LedgerInvoice[] = [
        {
          id: 'inv-1',
          creditCardId: 'card-a',
          competenceMonth: '2026-11',
          closingDate: '2026-11-10',
          dueDate: '2026-11-17',
          status: 'PAID',
          deletedAt: null,
        },
        {
          id: 'inv-2',
          creditCardId: 'card-a',
          competenceMonth: '2026-12',
          closingDate: '2026-12-10',
          dueDate: '2026-12-17',
          status: 'OPEN',
          deletedAt: null,
        },
        {
          id: 'inv-3',
          creditCardId: 'card-a',
          competenceMonth: '2027-01',
          closingDate: '2027-01-10',
          dueDate: '2027-01-17',
          status: 'OPEN',
          deletedAt: null,
        },
      ];

      const slices: LedgerTransaction[] = [
        {
          id: 'tx-1',
          type: 'CREDIT_PURCHASE',
          status: 'CLEARED',
          amountCents: 3334,
          transactionDate: '2026-11-05',
          competenceMonth: '2026-11',
          accountId: null,
          transferAccountId: null,
          creditCardId: 'card-a',
          invoiceId: 'inv-1',
          categoryId: 'cat-1',
          ownerUserId: 'user-a',
          installmentPlanId: 'plan-1',
          installmentNumber: 1,
          totalInstallments: 3,
          isHouseholdContribution: false,
          deletedAt: null,
        },
        {
          id: 'tx-2',
          type: 'CREDIT_PURCHASE',
          status: 'CLEARED',
          amountCents: 3333,
          transactionDate: '2026-11-05',
          competenceMonth: '2026-12',
          accountId: null,
          transferAccountId: null,
          creditCardId: 'card-a',
          invoiceId: 'inv-2',
          categoryId: 'cat-1',
          ownerUserId: 'user-a',
          installmentPlanId: 'plan-1',
          installmentNumber: 2,
          totalInstallments: 3,
          isHouseholdContribution: false,
          deletedAt: null,
        },
        {
          id: 'tx-3',
          type: 'CREDIT_PURCHASE',
          status: 'CLEARED',
          amountCents: 3333,
          transactionDate: '2026-11-05',
          competenceMonth: '2027-01',
          accountId: null,
          transferAccountId: null,
          creditCardId: 'card-a',
          invoiceId: 'inv-3',
          categoryId: 'cat-1',
          ownerUserId: 'user-a',
          installmentPlanId: 'plan-1',
          installmentNumber: 3,
          totalInstallments: 3,
          isHouseholdContribution: false,
          deletedAt: null,
        },
      ];

      expect(canHardCancelInstallmentPlan('plan-1', slices, invoices)).toBe(false);

      const { updatedTransactions, newTotalAmountCents } = applyInstallmentScopeBEdit(
        'plan-1',
        1,
        { amountCents: 4000 },
        slices,
        invoices,
      );

      // Slice 1 is in a PAID invoice -> untouched (3334). Slices 2 & 3 are OPEN -> updated to 4000.
      expect(updatedTransactions.map((t) => t.amountCents)).toEqual([3334, 4000, 4000]);
      expect(newTotalAmountCents).toBe(11334);
      expect(recalculateInstallmentPlanTotalCents('plan-1', updatedTransactions)).toBe(11334);
    });

    it('enforces assertTransactionInvariants and addMonthsToCompetence negative offsets', () => {
      expect(addMonthsToCompetence('2026-01', -1)).toBe('2025-12');
      expect(() =>
        assertTransactionInvariants({
          type: 'CREDIT_PURCHASE',
          amountCents: 1000,
          accountId: 'acc-1', // Forbidden on CREDIT_PURCHASE
          transferAccountId: null,
          creditCardId: 'card-1',
          invoiceId: 'inv-1',
          categoryId: 'cat-1',
        }),
      ).toThrow(/chk_accounting_invariants/);

      expect(() =>
        assertTransactionInvariants({
          type: 'TRANSFER',
          amountCents: 1000,
          accountId: 'acc-1',
          transferAccountId: 'acc-1', // Same account forbidden
          creditCardId: null,
          invoiceId: null,
          categoryId: null,
        }),
      ).toThrow(/chk_accounting_invariants/);
    });
  });
});
