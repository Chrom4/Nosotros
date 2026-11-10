import {
  calculateBudgetConsumedCents,
  calculateHouseholdContributions,
  calculateMonthlySummaryCents,
  calculateNetWorthCents,
} from '@/core';
import {
  createAccount,
  createBaseTransaction,
  createBudget,
  createCategory,
  createCreditCard,
  createCreditCardInvoice,
  createCreditCardPurchase,
  getDashboardAggregates,
  resetCachedDatabaseForTests,
  setActiveDatabaseForTests,
  upsertLocalHousehold,
  upsertLocalHouseholdMember,
} from '@/data';
import {
  useFiltersStore,
  useSessionUIStore,
} from '@/store';
import {
  getContextTheme,
  resolveContextMode,
} from '@/theme';
import { createInMemoryTestDb, type InMemoryTestDb } from './testDbHelper';

const HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';
const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ACC_JOINT_ID = '22222222-2222-4222-8222-222222222201';
const ACC_USER_A_ID = '22222222-2222-4222-8222-222222222202';
const ACC_USER_B_ID = '22222222-2222-4222-8222-222222222203';

const CARD_USER_A_ID = '44444444-4444-4444-8444-444444444401';
const CARD_DOMESTIC_ID = '44444444-4444-4444-8444-444444444402';

const INV_USER_A_ID = '55555555-5555-4555-8555-555555555501';
const INV_DOM_ID = '55555555-5555-4555-8555-555555555502';

const testUuid = (n: number) =>
  `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`;

const CAT_GROCERIES_ID = '33333333-3333-4333-8333-333333333301';
const CAT_HOUSING_ID = '33333333-3333-4333-8333-333333333302';
const CAT_SALARY_ID = '33333333-3333-4333-8333-333333333303';
const CAT_PERSONAL_A_ID = '33333333-3333-4333-8333-333333333304';
const CAT_PERSONAL_B_ID = '33333333-3333-4333-8333-333333333305';

describe('Phase 9 — Contextual Dashboard, Net Worth, Budgets & Contribution Split', () => {
  let inMemoryDb: InMemoryTestDb;

  beforeEach(() => {
    resetCachedDatabaseForTests();
    useFiltersStore.getState().resetFilters();
    useSessionUIStore.getState().resetSessionUI();

    inMemoryDb = createInMemoryTestDb();
    setActiveDatabaseForTests(inMemoryDb.db);

    useSessionUIStore.getState().setSession({
      userId: USER_A_ID,
      userEmail: 'diogo@nosotros.local',
      activeHouseholdId: HOUSEHOLD_ID,
      memberRole: 'FOUNDER',
    });

    // 1. Setup Household and 2 Members
    upsertLocalHousehold(inMemoryDb.db, {
      id: HOUSEHOLD_ID,
      name: 'Casa Diogo & Marina',
    });

    upsertLocalHouseholdMember(inMemoryDb.db, {
      id: '10000000-0000-4000-8000-000000000001',
      householdId: HOUSEHOLD_ID,
      userId: USER_A_ID,
      displayName: 'Diogo',
      role: 'FOUNDER',
      colorHex: '#0EA5E9',
    });

    upsertLocalHouseholdMember(inMemoryDb.db, {
      id: '10000000-0000-4000-8000-000000000002',
      householdId: HOUSEHOLD_ID,
      userId: USER_B_ID,
      displayName: 'Marina',
      role: 'PARTNER',
      colorHex: '#10B981',
    });

    // 2. Setup Accounts
    createAccount(inMemoryDb.db, {
      id: ACC_JOINT_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: null, // Shared / Domestic
      name: 'Conta Conjunta',
      type: 'CHECKING',
      initialBalanceCents: 100000, // R$ 1.000,00
      includeInNetWorth: true,
      isArchived: false,
    });

    createAccount(inMemoryDb.db, {
      id: ACC_USER_A_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_A_ID, // Mine
      name: 'Conta Diogo',
      type: 'CHECKING',
      initialBalanceCents: 500000, // R$ 5.000,00
      includeInNetWorth: true,
      isArchived: false,
    });

    createAccount(inMemoryDb.db, {
      id: ACC_USER_B_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_B_ID, // Partner
      name: 'Conta Marina',
      type: 'CHECKING',
      initialBalanceCents: 400000, // R$ 4.000,00
      includeInNetWorth: true,
      isArchived: false,
    });

    // 3. Setup Categories
    createCategory(inMemoryDb.db, {
      id: CAT_SALARY_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Salário',
      kind: 'INCOME',
      colorHex: '#10B981',
      iconName: 'cash',
    });

    createCategory(inMemoryDb.db, {
      id: CAT_GROCERIES_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Supermercado',
      kind: 'EXPENSE',
      colorHex: '#F59E0B',
      iconName: 'cart',
    });

    createCategory(inMemoryDb.db, {
      id: CAT_HOUSING_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Moradia / Contas',
      kind: 'EXPENSE',
      colorHex: '#8B5CF6',
      iconName: 'home',
    });

    createCategory(inMemoryDb.db, {
      id: CAT_PERSONAL_A_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Lazer Diogo',
      kind: 'EXPENSE',
      colorHex: '#0EA5E9',
      iconName: 'gamepad',
    });

    createCategory(inMemoryDb.db, {
      id: CAT_PERSONAL_B_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Lazer Marina',
      kind: 'EXPENSE',
      colorHex: '#EC4899',
      iconName: 'film',
    });

    // 4. Setup Cards & Invoices
    createCreditCard(inMemoryDb.db, {
      id: CARD_USER_A_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_A_ID,
      name: 'Cartão Diogo Black',
      limitCents: 1000000, // R$ 10.000,00
      closingDay: 20,
      dueDay: 28,
      defaultPaymentAccountId: ACC_USER_A_ID,
      isArchived: false,
    });

    createCreditCard(inMemoryDb.db, {
      id: CARD_DOMESTIC_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: null,
      name: 'Cartão da Casa',
      limitCents: 500000, // R$ 5.000,00
      closingDay: 15,
      dueDay: 25,
      defaultPaymentAccountId: ACC_JOINT_ID,
      isArchived: false,
    });

    createCreditCardInvoice(inMemoryDb.db, {
      id: INV_USER_A_ID,
      householdId: HOUSEHOLD_ID,
      creditCardId: CARD_USER_A_ID,
      competenceMonth: '2026-11',
      closingDate: '2026-11-20',
      dueDate: '2026-11-28',
      status: 'OPEN',
    });

    createCreditCardInvoice(inMemoryDb.db, {
      id: INV_DOM_ID,
      householdId: HOUSEHOLD_ID,
      creditCardId: CARD_DOMESTIC_ID,
      competenceMonth: '2026-11',
      closingDate: '2026-11-15',
      dueDate: '2026-11-25',
      status: 'OPEN',
    });

    // 5. Setup Budgets
    createBudget(inMemoryDb.db, {
      id: testUuid(8),
      householdId: HOUSEHOLD_ID,
      ownerUserId: null,
      categoryId: CAT_GROCERIES_ID,
      competenceMonth: '2026-11',
      limitCents: 150000, // R$ 1.500,00
    });

    createBudget(inMemoryDb.db, {
      id: testUuid(9),
      householdId: HOUSEHOLD_ID,
      ownerUserId: null,
      categoryId: CAT_HOUSING_ID,
      competenceMonth: '2026-11',
      limitCents: 200000, // R$ 2.000,00
    });
  });

  describe('T9.1 — Theme Resolver & Context Modes', () => {
    it('resolves correct theme and tokens for all 4 context modes', () => {
      // 1. Consolidated
      const consTheme = getContextTheme({ mode: 'CONSOLIDATED' }, USER_A_ID);
      expect(consTheme.mode).toBe('CONSOLIDATED');
      expect(consTheme.primary).toBe('#6366F1');

      // 2. Mine
      const mineTheme = getContextTheme({ mode: 'USER', userId: USER_A_ID }, USER_A_ID);
      expect(mineTheme.mode).toBe('MINE');
      expect(mineTheme.primary).toBe('#0EA5E9');

      // 3. Partner
      const partnerTheme = getContextTheme({ mode: 'USER', userId: USER_B_ID }, USER_A_ID);
      expect(partnerTheme.mode).toBe('PARTNER');
      expect(partnerTheme.primary).toBe('#10B981');

      // 4. Domestic
      const domesticTheme = getContextTheme({ mode: 'DOMESTIC' }, USER_A_ID);
      expect(domesticTheme.mode).toBe('DOMESTIC');
      expect(domesticTheme.primary).toBe('#8B5CF6');
    });

    it('handles resolveContextMode gracefully when currentUserId is null', () => {
      expect(resolveContextMode({ mode: 'CONSOLIDATED' }, null)).toBe('CONSOLIDATED');
      expect(resolveContextMode({ mode: 'DOMESTIC' }, null)).toBe('DOMESTIC');
      expect(resolveContextMode({ mode: 'USER', userId: USER_A_ID }, null)).toBe('PARTNER');
    });
  });

  describe('T9.2 — Contextual Aggregate Queries & Filtering', () => {
    beforeEach(() => {
      // Inserir transações de teste para 2026-11
      // 1. Receita Diogo (Salário: R$ 8.000,00)
      createBaseTransaction(inMemoryDb.db, {
        id: testUuid(1),
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        type: 'INCOME',
        amountCents: 800000,
        transactionDate: '2026-11-05',
        competenceMonth: '2026-11',
        description: 'Salário Diogo',
        accountId: ACC_USER_A_ID,
        categoryId: CAT_SALARY_ID,
      });

      // 2. Receita Marina (Salário: R$ 7.000,00)
      createBaseTransaction(inMemoryDb.db, {
        id: testUuid(2),
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_B_ID,
        ownerUserId: USER_B_ID,
        type: 'INCOME',
        amountCents: 700000,
        transactionDate: '2026-11-05',
        competenceMonth: '2026-11',
        description: 'Salário Marina',
        accountId: ACC_USER_B_ID,
        categoryId: CAT_SALARY_ID,
      });

      // 3. Despesa Pessoal Diogo: R$ 300,00
      createBaseTransaction(inMemoryDb.db, {
        id: testUuid(3),
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        type: 'EXPENSE',
        amountCents: 30000,
        transactionDate: '2026-11-10',
        competenceMonth: '2026-11',
        description: 'Lazer Diogo',
        accountId: ACC_USER_A_ID,
        categoryId: CAT_PERSONAL_A_ID,
      });

      // 4. Despesa Pessoal Marina: R$ 400,00
      createBaseTransaction(inMemoryDb.db, {
        id: testUuid(4),
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_B_ID,
        ownerUserId: USER_B_ID,
        type: 'EXPENSE',
        amountCents: 40000,
        transactionDate: '2026-11-12',
        competenceMonth: '2026-11',
        description: 'Lazer Marina',
        accountId: ACC_USER_B_ID,
        categoryId: CAT_PERSONAL_B_ID,
      });

      // 5. Despesa Compartilhada da Casa paga com conta conjunta: R$ 1.200,00 (Aluguel/Condomínio)
      createBaseTransaction(inMemoryDb.db, {
        id: testUuid(5),
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        type: 'EXPENSE',
        amountCents: 120000,
        transactionDate: '2026-11-15',
        competenceMonth: '2026-11',
        description: 'Aluguel do Mês',
        accountId: ACC_JOINT_ID,
        categoryId: CAT_HOUSING_ID,
      });

      // 6. Transferência interna (Diogo aporta R$ 1.500,00 para conta conjunta, DEC-02 contribution)
      createBaseTransaction(inMemoryDb.db, {
        id: testUuid(6),
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        type: 'TRANSFER',
        amountCents: 150000,
        transactionDate: '2026-11-06',
        competenceMonth: '2026-11',
        description: 'Aporte Diogo Casa',
        accountId: ACC_USER_A_ID,
        transferAccountId: ACC_JOINT_ID,
        isHouseholdContribution: true,
      });

      // 7. Compra no Cartão Diogo para despesa doméstica compartilhada (DEC-02 direct contribution): R$ 800,00
      createCreditCardPurchase(inMemoryDb.db, {
        id: testUuid(7),
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null, // Shared domestic expense!
        amountCents: 80000,
        transactionDate: '2026-11-08',
        competenceMonth: '2026-11',
        description: 'Compras Supermercado Diogo no Cartão',
        creditCardId: CARD_USER_A_ID,
        invoiceId: INV_USER_A_ID,
        categoryId: CAT_GROCERIES_ID,
      });
    });

    it('aggregates Consolidated data correctly without network', () => {
      const aggregates = getDashboardAggregates(
        inMemoryDb.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'CONSOLIDATED' },
      );

      // Income: Diogo (8000) + Marina (7000) = R$ 15.000,00
      expect(aggregates.monthlySummary.incomeCents).toBe(1500000);

      // Expense: Diogo (300) + Marina (400) + Housing (1200) + Groceries CC (800) = R$ 2.700,00
      // Note: Transfer (1500) is NEVER an expense!
      expect(aggregates.monthlySummary.expenseCents).toBe(270000);

      // Net Savings: 15000 - 2700 = R$ 12.300,00
      expect(aggregates.monthlySummary.netSavingsCents).toBe(1230000);

      // Net Worth:
      // Initial balances: Joint (1000) + Diogo (5000) + Marina (4000) = R$ 10.000,00
      // Net Cash changes:
      // Diogo: +8000 (inc) - 300 (exp) - 1500 (transfer out) = +6200 -> Balance = 11200
      // Marina: +7000 (inc) - 400 (exp) = +6600 -> Balance = 10600
      // Joint: +1500 (transfer in) - 1200 (housing) = +300 -> Balance = 1300
      // Assets = 11200 + 10600 + 1300 = 23100
      // Liabilities: inv-a debt is 800 (groceries cc)
      // Net Worth = 23100 - 800 = 22300 (R$ 22.300,00)
      expect(aggregates.netWorthCents).toBe(2230000);
      expect(aggregates.netWorthEvolution).toHaveLength(6);
      expect(aggregates.netWorthEvolution[5].netWorthCents).toBe(2230000);
    });

    it('aggregates Mine context (Diogo) isolating individual finances', () => {
      const aggregates = getDashboardAggregates(
        inMemoryDb.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'USER', userId: USER_A_ID },
      );

      // Only Diogo's income (R$ 8.000,00)
      expect(aggregates.monthlySummary.incomeCents).toBe(800000);
      // Diogo's personal expense: 300
      expect(aggregates.monthlySummary.expenseCents).toBe(30000);
      expect(aggregates.monthlySummary.netSavingsCents).toBe(770000);

      // Mine Net Worth: Account Diogo (11200) - Card Diogo Invoice Debt (800) = 10400 (R$ 10.400,00)
      expect(aggregates.netWorthCents).toBe(1040000);
    });

    it('aggregates Partner context (Marina) isolating individual finances', () => {
      const aggregates = getDashboardAggregates(
        inMemoryDb.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'USER', userId: USER_B_ID },
      );

      // Only Marina's income (R$ 7.000,00)
      expect(aggregates.monthlySummary.incomeCents).toBe(700000);
      // Marina's personal expense: 400
      expect(aggregates.monthlySummary.expenseCents).toBe(40000);
      expect(aggregates.monthlySummary.netSavingsCents).toBe(660000);

      // Partner Net Worth: Account Marina (10600) - Card debts (0) = 10600 (R$ 10.600,00)
      expect(aggregates.netWorthCents).toBe(1060000);
    });

    it('aggregates Domestic context isolating shared household expenses', () => {
      const aggregates = getDashboardAggregates(
        inMemoryDb.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'DOMESTIC' },
      );

      // Domestic income: 0
      expect(aggregates.monthlySummary.incomeCents).toBe(0);
      // Domestic expenses: Housing (1200) + Groceries (800) = R$ 2.000,00
      expect(aggregates.monthlySummary.expenseCents).toBe(200000);
      expect(aggregates.monthlySummary.netSavingsCents).toBe(-200000);

      // Domestic Net Worth: Joint Account (1300) - Domestic card debt (0) = 1300 (R$ 1.300,00)
      expect(aggregates.netWorthCents).toBe(130000);
    });

    it('honors DEC-01 for budgets: consumes cash-basis credit card purchase and debit expenses', () => {
      const aggregates = getDashboardAggregates(
        inMemoryDb.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'CONSOLIDATED' },
      );

      expect(aggregates.budgets).toHaveLength(2);

      const grocBudget = aggregates.budgets.find(
        (b) => b.categoryId === CAT_GROCERIES_ID,
      );
      expect(grocBudget).toBeDefined();
      expect(grocBudget?.limitCents).toBe(150000); // R$ 1.500,00
      expect(grocBudget?.consumedCents).toBe(80000); // R$ 800,00 (credit purchase)

      const housingBudget = aggregates.budgets.find(
        (b) => b.categoryId === CAT_HOUSING_ID,
      );
      expect(housingBudget).toBeDefined();
      expect(housingBudget?.limitCents).toBe(200000); // R$ 2.000,00
      expect(housingBudget?.consumedCents).toBe(120000); // R$ 1.200,00 (debit expense)
    });

    it('honors DEC-02 for household contributions: combines explicit transfers and shared expenses paid via individual card', () => {
      const aggregates = getDashboardAggregates(
        inMemoryDb.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'CONSOLIDATED' },
      );

      expect(aggregates.contributions).not.toBeNull();
      const contrib = aggregates.contributions!;

      // Diogo:
      // - Transfer to joint account: R$ 1.500,00
      // - Domestic groceries on individual card: R$ 800,00
      // Total Diogo = R$ 2.300,00 (230000 cents)
      // Marina: R$ 0,00
      // Grand Total = R$ 2.300,00
      expect(contrib.totalContributionCents).toBe(230000);

      const diogoContrib = contrib.members.find((m) => m.userId === USER_A_ID);
      expect(diogoContrib).toBeDefined();
      expect(diogoContrib?.explicitTransferCents).toBe(150000);
      expect(diogoContrib?.directDomesticExpenseCents).toBe(80000);
      expect(diogoContrib?.totalContributionCents).toBe(230000);
      expect(diogoContrib?.sharePercentage).toBe(100);

      const marinaContrib = contrib.members.find((m) => m.userId === USER_B_ID);
      expect(marinaContrib).toBeDefined();
      expect(marinaContrib?.totalContributionCents).toBe(0);
      expect(marinaContrib?.sharePercentage).toBe(0);
    });

    it('restores budget and reduces expenses on DEBIT_REFUND without inflating income', () => {
      // Add a debit refund of R$ 200,00 (20000 cents) on housing
      createBaseTransaction(inMemoryDb.db, {
        id: testUuid(50),
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        type: 'DEBIT_REFUND',
        amountCents: 20000,
        transactionDate: '2026-11-20',
        competenceMonth: '2026-11',
        description: 'Estorno Parcial Aluguel',
        accountId: ACC_JOINT_ID,
        categoryId: CAT_HOUSING_ID,
      });

      const aggregates = getDashboardAggregates(
        inMemoryDb.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'CONSOLIDATED' },
      );

      // Income must still be R$ 15.000,00 (refunds NEVER inflate income)
      expect(aggregates.monthlySummary.incomeCents).toBe(1500000);

      // Housing expense reduced from 1200 to 1000 -> Total expense: 2700 - 200 = 2500 (250000 cents)
      expect(aggregates.monthlySummary.expenseCents).toBe(250000);
      expect(aggregates.monthlySummary.netSavingsCents).toBe(1250000);

      // Housing budget consumed reduced from 120000 to 100000
      const housingBudget = aggregates.budgets.find(
        (b) => b.categoryId === CAT_HOUSING_ID,
      );
      expect(housingBudget?.consumedCents).toBe(100000);
    });

    it('computes 6-month historical net worth evolution with correct labels and trajectory', () => {
      const aggregates = getDashboardAggregates(
        inMemoryDb.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'CONSOLIDATED' },
      );

      expect(aggregates.netWorthEvolution).toHaveLength(6);
      expect(aggregates.netWorthEvolution.map((p) => p.label)).toEqual([
        'Jun',
        'Jul',
        'Ago',
        'Set',
        'Out',
        'Nov',
      ]);
      expect(
        aggregates.netWorthEvolution.map((p) => p.competenceMonth),
      ).toEqual([
        '2026-06',
        '2026-07',
        '2026-08',
        '2026-09',
        '2026-10',
        '2026-11',
      ]);

      // Before November (June - October), only initial balances existed (R$ 10.000,00)
      for (let i = 0; i < 5; i++) {
        expect(aggregates.netWorthEvolution[i].netWorthCents).toBe(1000000);
      }
      // November reflects all November transactions (R$ 22.300,00)
      expect(aggregates.netWorthEvolution[5].netWorthCents).toBe(2230000);
    });
  });

  describe('T9.3 — Performance Gate (< 20ms Target)', () => {
    it('executes getDashboardAggregates with multiple transactions in < 20ms', () => {
      // Seed 60 additional transactions to simulate realistic load
      for (let i = 0; i < 60; i++) {
        createBaseTransaction(inMemoryDb.db, {
          id: testUuid(100 + i),
          householdId: HOUSEHOLD_ID,
          createdByUserId: i % 2 === 0 ? USER_A_ID : USER_B_ID,
          ownerUserId: i % 3 === 0 ? null : i % 2 === 0 ? USER_A_ID : USER_B_ID,
          type: 'EXPENSE',
          amountCents: (i + 1) * 1000,
          transactionDate: '2026-11-18',
          competenceMonth: '2026-11',
          description: `Compra teste ${i}`,
          accountId: ACC_JOINT_ID,
          categoryId: CAT_GROCERIES_ID,
        });
      }

      // Warmup query
      getDashboardAggregates(inMemoryDb.db, HOUSEHOLD_ID, '2026-11', {
        mode: 'CONSOLIDATED',
      });

      // Benchmark measurement
      const tStart = performance.now();
      const result = getDashboardAggregates(
        inMemoryDb.db,
        HOUSEHOLD_ID,
        '2026-11',
        { mode: 'CONSOLIDATED' },
      );
      const elapsedMs = performance.now() - tStart;

      expect(elapsedMs).toBeLessThan(20);
      expect(result.timingMs).toBeLessThan(20);
      expect(result.budgets.length).toBeGreaterThan(0);
    });
  });
});
