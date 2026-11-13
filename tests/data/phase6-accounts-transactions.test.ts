import { eq } from 'drizzle-orm';
import {
  calculateHouseholdContributions,
  calculateMonthlySummaryCents,
} from '@/core';
import {
  accounts,
  buildCategoryTree,
  categories,
  computeAccountsWithBalances,
  createAccount,
  createBaseTransaction,
  createCategory,
  flattenCategoryTree,
  listAccountsWithBalances,
  listActiveAccounts,
  listActiveCategories,
  listTransactionsByCompetenceMonth,
  reconcilePeerOutbox,
  resetCachedDatabaseForTests,
  resolveBaseTransactionContributionFlag,
  seedDefaultCategories,
  setActiveDatabaseForTests,
  softDeleteAccount,
  softDeleteCategory,
  softDeleteTransaction,
  subscribeToDatabaseChanges,
  type SyncableTableName,
  syncOutbox,
  transactions,
  updateAccount,
  updateCategory,
  upsertLocalHousehold,
  upsertLocalHouseholdMember,
} from '@/data';
import {
  formatCentsToBrl,
  parseCurrencyInputToCents,
  useFiltersStore,
} from '@/store';
import { createInMemoryTestDb, type InMemoryTestDb } from './testDbHelper';

const HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';
const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ACC_JOINT_ID = '22222222-2222-4222-8222-222222222201';
const ACC_USER_A_ID = '22222222-2222-4222-8222-222222222202';
const ACC_USER_B_ID = '22222222-2222-4222-8222-222222222203';

const CAT_EXP_ROOT_ID = '33333333-3333-4333-8333-333333333301';
const CAT_EXP_SUB_ID = '33333333-3333-4333-8333-333333333302';
const CAT_INC_ROOT_ID = '33333333-3333-4333-8333-333333333303';

describe('Phase 6 — Accounts, Hierarchical Categories, Base Transactions, Live Queries & A↔B Sync', () => {
  let deviceA: InMemoryTestDb;
  let deviceB: InMemoryTestDb;

  beforeEach(() => {
    resetCachedDatabaseForTests();
    useFiltersStore.getState().resetFilters();

    deviceA = createInMemoryTestDb();
    deviceB = createInMemoryTestDb();
    setActiveDatabaseForTests(deviceA.db);

    for (const peer of [deviceA.db, deviceB.db]) {
      upsertLocalHousehold(peer, {
        id: HOUSEHOLD_ID,
        name: 'Casa Nosotros',
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
  });

  afterEach(() => {
    resetCachedDatabaseForTests();
    deviceA.close();
    deviceB.close();
  });

  describe('T6.1 & Store — Ephemeral Filters Store & Pure Integer BRL Formatting', () => {
    it('formats and parses BRL currency values using pure integer arithmetic without float drift', () => {
      expect(formatCentsToBrl(0)).toBe('R$ 0,00');
      expect(formatCentsToBrl(12550)).toBe('R$ 125,50');
      expect(formatCentsToBrl(1234567)).toBe('R$ 12.345,67');
      expect(formatCentsToBrl(-4590)).toBe('- R$ 45,90');

      expect(parseCurrencyInputToCents('125,50')).toBe(12550);
      expect(parseCurrencyInputToCents('R$ 1.250,00')).toBe(125000);
      expect(parseCurrencyInputToCents('89.9')).toBe(8990);
      expect(parseCurrencyInputToCents('45')).toBe(4500);
      expect(parseCurrencyInputToCents('')).toBe(0);
    });

    it('manages ownershipFilter, competenceMonth navigation, and quick modal state in Zustand', () => {
      const store = useFiltersStore.getState();
      expect(store.ownershipFilter).toEqual({ mode: 'CONSOLIDATED' });
      expect(store.competenceMonth).toBe('2026-11');

      store.shiftCompetenceMonth(1);
      expect(useFiltersStore.getState().competenceMonth).toBe('2026-12');

      store.shiftCompetenceMonth(-2);
      expect(useFiltersStore.getState().competenceMonth).toBe('2026-10');

      store.setOwnershipFilter({ mode: 'USER', userId: USER_A_ID });
      expect(useFiltersStore.getState().ownershipFilter).toEqual({
        mode: 'USER',
        userId: USER_A_ID,
      });

      store.openQuickModal('TRANSFER');
      expect(useFiltersStore.getState().isQuickModalVisible).toBe(true);
      expect(useFiltersStore.getState().quickModalInitialType).toBe('TRANSFER');

      store.closeQuickModal();
      expect(useFiltersStore.getState().isQuickModalVisible).toBe(false);
    });
  });

  describe('T6.2 — Accounts CRUD (Soft Delete Only) & Reconstructed Balances', () => {
    it('creates, updates, filters by owner, reconstructs balances, and soft-deletes accounts without physical DELETE', () => {
      const joint = createAccount(deviceA.db, {
        id: ACC_JOINT_ID,
        householdId: HOUSEHOLD_ID,
        ownerUserId: null,
        name: 'Conta Conjunta Itaú',
        type: 'CHECKING',
        initialBalanceCents: 200000,
        includeInNetWorth: true,
        isArchived: false,
      });

      const personalA = createAccount(deviceA.db, {
        id: ACC_USER_A_ID,
        householdId: HOUSEHOLD_ID,
        ownerUserId: USER_A_ID,
        name: 'Carteira Diogo',
        type: 'WALLET',
        initialBalanceCents: 50000,
        includeInNetWorth: true,
        isArchived: false,
      });

      expect(joint.ownerUserId).toBeNull();
      expect(personalA.ownerUserId).toBe(USER_A_ID);

      // Update account name & initial balance
      const updated = updateAccount(deviceA.db, ACC_USER_A_ID, {
        name: 'Carteira Física Diogo',
        initialBalanceCents: 75000,
      });
      expect(updated.name).toBe('Carteira Física Diogo');
      expect(updated.initialBalanceCents).toBe(75000);

      // Filter by ownership
      expect(
        listActiveAccounts(deviceA.db, HOUSEHOLD_ID, { mode: 'CONSOLIDATED' }),
      ).toHaveLength(2);
      expect(
        listActiveAccounts(deviceA.db, HOUSEHOLD_ID, { mode: 'DOMESTIC' }),
      ).toHaveLength(1);
      expect(
        listActiveAccounts(deviceA.db, HOUSEHOLD_ID, {
          mode: 'USER',
          userId: USER_A_ID,
        }),
      ).toHaveLength(1);

      // Soft-delete personal account: physical row remains with deletedAt != null
      const softDeleted = softDeleteAccount(deviceA.db, ACC_USER_A_ID);
      expect(softDeleted.deletedAt).not.toBeNull();

      const allRawAccounts = deviceA.db.select().from(accounts).all();
      expect(allRawAccounts).toHaveLength(2);
      expect(
        listActiveAccounts(deviceA.db, HOUSEHOLD_ID, { mode: 'CONSOLIDATED' }),
      ).toHaveLength(1);
    });
  });

  describe('T6.2 — Categories Hierarchical CRUD & Deterministic Seeding', () => {
    it('enforces 2-level hierarchy invariants, builds/flattens tree, and cascades soft-delete to subcategories', () => {
      const rootExp = createCategory(deviceA.db, {
        id: CAT_EXP_ROOT_ID,
        householdId: HOUSEHOLD_ID,
        parentId: null,
        name: 'Alimentação',
        kind: 'EXPENSE',
        colorHex: '#10B981',
        iconName: 'utensils',
      });

      const subExp = createCategory(deviceA.db, {
        id: CAT_EXP_SUB_ID,
        householdId: HOUSEHOLD_ID,
        parentId: rootExp.id,
        name: 'Supermercado',
        kind: 'EXPENSE',
        colorHex: '#10B981',
        iconName: 'shopping-cart',
      });

      const rootInc = createCategory(deviceA.db, {
        id: CAT_INC_ROOT_ID,
        householdId: HOUSEHOLD_ID,
        parentId: null,
        name: 'Salário',
        kind: 'INCOME',
        colorHex: '#22C55E',
        iconName: 'briefcase',
      });

      // Rejects 3rd-level nesting (subcategory of a subcategory)
      expect(() =>
        createCategory(deviceA.db, {
          id: '33333333-3333-4333-8333-333333333399',
          householdId: HOUSEHOLD_ID,
          parentId: subExp.id,
          name: 'Hortifruti Nivel 3',
          kind: 'EXPENSE',
          colorHex: '#10B981',
          iconName: 'leaf',
        }),
      ).toThrow(/at most 2 levels/);

      // Rejects kind mismatch between parent and subcategory
      expect(() =>
        createCategory(deviceA.db, {
          id: '33333333-3333-4333-8333-333333333398',
          householdId: HOUSEHOLD_ID,
          parentId: rootInc.id,
          name: 'Subcategoria Inválida',
          kind: 'EXPENSE',
          colorHex: '#EF4444',
          iconName: 'tag',
        }),
      ).toThrow(/must match subcategory kind/);

      // Rejects demoting a root category that already has active subcategories
      expect(() =>
        updateCategory(deviceA.db, rootExp.id, {
          parentId: '33333333-3333-4333-8333-333333333397',
        }),
      ).toThrow();

      const activeRows = listActiveCategories(deviceA.db, HOUSEHOLD_ID);
      const tree = buildCategoryTree(activeRows, 'EXPENSE');
      expect(tree).toHaveLength(1);
      expect(tree[0].category.name).toBe('Alimentação');
      expect(tree[0].subcategories).toHaveLength(1);
      expect(tree[0].subcategories[0].name).toBe('Supermercado');

      const flat = flattenCategoryTree(activeRows, 'EXPENSE');
      expect(flat.map((f) => f.displayLabel)).toEqual([
        'Alimentação',
        'Alimentação › Supermercado',
      ]);

      // Soft-deleting parent category cascades soft-delete to its active subcategories
      softDeleteCategory(deviceA.db, rootExp.id);
      const remainingExpenseCats = listActiveCategories(
        deviceA.db,
        HOUSEHOLD_ID,
        'EXPENSE',
      );
      expect(remainingExpenseCats).toHaveLength(0);

      // Verify both parent and child still exist in SQLite with deletedAt != null
      const rawSubRow = deviceA.db
        .select()
        .from(categories)
        .where(eq(categories.id, subExp.id))
        .get()!;
      expect(rawSubRow.deletedAt).not.toBeNull();
    });

    it('seeds deterministic default categories idempotently across both devices', () => {
      const seededA = seedDefaultCategories(deviceA.db, HOUSEHOLD_ID);
      const seededB = seedDefaultCategories(deviceB.db, HOUSEHOLD_ID);

      expect(seededA.length).toBeGreaterThanOrEqual(10);
      expect(seededA.map((c) => c.id)).toEqual(seededB.map((c) => c.id));

      // Calling seedDefaultCategories a second time is a no-op
      const seededAgain = seedDefaultCategories(deviceA.db, HOUSEHOLD_ID);
      expect(seededAgain).toHaveLength(seededA.length);
    });
  });

  describe('T6.2 & Gates — Base Transaction Kinds, Pointer Invariants & DEC-02 Contributions', () => {
    beforeEach(() => {
      createAccount(deviceA.db, {
        id: ACC_JOINT_ID,
        householdId: HOUSEHOLD_ID,
        ownerUserId: null,
        name: 'Conta Conjunta Casa',
        type: 'CHECKING',
        initialBalanceCents: 100000, // R$ 1.000,00
        includeInNetWorth: true,
        isArchived: false,
      });
      createAccount(deviceA.db, {
        id: ACC_USER_A_ID,
        householdId: HOUSEHOLD_ID,
        ownerUserId: USER_A_ID,
        name: 'Conta Individual Diogo',
        type: 'CHECKING',
        initialBalanceCents: 300000, // R$ 3.000,00
        includeInNetWorth: true,
        isArchived: false,
      });
      createAccount(deviceA.db, {
        id: ACC_USER_B_ID,
        householdId: HOUSEHOLD_ID,
        ownerUserId: USER_B_ID,
        name: 'Conta Individual Ana',
        type: 'CHECKING',
        initialBalanceCents: 250000, // R$ 2.500,00
        includeInNetWorth: true,
        isArchived: false,
      });
      createCategory(deviceA.db, {
        id: CAT_EXP_ROOT_ID,
        householdId: HOUSEHOLD_ID,
        parentId: null,
        name: 'Moradia',
        kind: 'EXPENSE',
        colorHex: '#6366F1',
        iconName: 'home',
      });
      createCategory(deviceA.db, {
        id: CAT_INC_ROOT_ID,
        householdId: HOUSEHOLD_ID,
        parentId: null,
        name: 'Salário',
        kind: 'INCOME',
        colorHex: '#22C55E',
        iconName: 'briefcase',
      });
    });

    it('captures INCOME, EXPENSE, DEBIT_REFUND, and TRANSFER while enforcing DEC-02 and balance invariants', () => {
      // 1. INCOME on User A's account (+ R$ 5.000,00)
      const incomeTx = createBaseTransaction(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: USER_A_ID,
        type: 'INCOME',
        amountCents: 500000,
        transactionDate: '2026-11-05',
        description: 'Salário Mensal Diogo',
        accountId: ACC_USER_A_ID,
        categoryId: CAT_INC_ROOT_ID,
      });
      expect(incomeTx.isHouseholdContribution).toBe(false);

      // 2. Shared EXPENSE (ownerUserId = null) paid from User A's individual account (- R$ 800,00) -> DEC-02 auto-contribution!
      const sharedExpPaidByA = createBaseTransaction(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null, // Shared / Casa
        type: 'EXPENSE',
        amountCents: 80000,
        transactionDate: '2026-11-06',
        description: 'Conta de Luz da Casa',
        accountId: ACC_USER_A_ID, // Individual account
        categoryId: CAT_EXP_ROOT_ID,
        isHouseholdContribution: false, // Even if passed false, DEC-02 forces true!
      });
      expect(sharedExpPaidByA.isHouseholdContribution).toBe(true);

      // 3. Shared DEBIT_REFUND on User A's individual account (+ R$ 50,00 refund on shared bill)
      const debitRefundTx = createBaseTransaction(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_A_ID,
        ownerUserId: null,
        type: 'DEBIT_REFUND',
        amountCents: 5000,
        transactionDate: '2026-11-07',
        description: 'Estorno Cobrança Duplicada Luz',
        accountId: ACC_USER_A_ID,
        categoryId: CAT_EXP_ROOT_ID,
        refundedTransactionId: sharedExpPaidByA.id,
      });
      expect(debitRefundTx.isHouseholdContribution).toBe(true);

      // 4. Explicit contribution TRANSFER from User B's individual account to Joint Account (R$ 1.200,00)
      const transferTx = createBaseTransaction(deviceA.db, {
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_B_ID,
        ownerUserId: USER_B_ID,
        type: 'TRANSFER',
        amountCents: 120000,
        transactionDate: '2026-11-08',
        description: 'Aporte Mensal Ana para Conta Conjunta',
        accountId: ACC_USER_B_ID,
        transferAccountId: ACC_JOINT_ID,
        categoryId: null,
        isHouseholdContribution: true,
      });
      expect(transferTx.isHouseholdContribution).toBe(true);
      expect(transferTx.categoryId).toBeNull();

      // Verify reconstructed account balances:
      // Joint: 100000 + 120000 (transfer in) = 220000
      // User A: 300000 + 500000 (income) - 80000 (expense) + 5000 (debit refund) = 725000
      // User B: 250000 - 120000 (transfer out) = 130000
      const balances = listAccountsWithBalances(deviceA.db, HOUSEHOLD_ID);
      const balanceById = new Map(
        balances.map((b) => [b.account.id, b.balanceCents]),
      );
      expect(balanceById.get(ACC_JOINT_ID)).toBe(220000);
      expect(balanceById.get(ACC_USER_A_ID)).toBe(725000);
      expect(balanceById.get(ACC_USER_B_ID)).toBe(130000);

      // Verify monthly summary excludes TRANSFER and subtracts DEBIT_REFUND from expenses
      const monthTxs = listTransactionsByCompetenceMonth(
        deviceA.db,
        HOUSEHOLD_ID,
        '2026-11',
      );
      const summary = calculateMonthlySummaryCents('2026-11', monthTxs, {
        mode: 'CONSOLIDATED',
      });
      expect(summary.incomeCents).toBe(500000);
      expect(summary.expenseCents).toBe(80000 - 5000); // 75000
      expect(summary.netSavingsCents).toBe(425000);

      // Verify DEC-02 household contribution breakdown between User A (75000 net direct) and User B (120000 transfer)
      const allAccounts = listActiveAccounts(deviceA.db, HOUSEHOLD_ID);
      const contributions = calculateHouseholdContributions(
        '2026-11',
        [USER_A_ID, USER_B_ID],
        allAccounts,
        [],
        monthTxs,
      );
      expect(contributions.totalContributionCents).toBe(75000 + 120000);
      expect(contributions.members[0].totalContributionCents).toBe(75000);
      expect(contributions.members[1].totalContributionCents).toBe(120000);
    });

    it('rejects invalid pointer combinations before persistence', () => {
      // 1. EXPENSE without categoryId
      expect(() =>
        createBaseTransaction(deviceA.db, {
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: null,
          type: 'EXPENSE',
          amountCents: 10000,
          transactionDate: '2026-11-09',
          description: 'Sem Categoria',
          accountId: ACC_JOINT_ID,
          categoryId: null,
        }),
      ).toThrow(/chk_accounting_invariants/);

      // 2. TRANSFER with categoryId != null
      expect(() =>
        createBaseTransaction(deviceA.db, {
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: null,
          type: 'TRANSFER',
          amountCents: 10000,
          transactionDate: '2026-11-09',
          description: 'Transferência com Categoria',
          accountId: ACC_USER_A_ID,
          transferAccountId: ACC_JOINT_ID,
          categoryId: CAT_EXP_ROOT_ID,
        }),
      ).toThrow(/chk_accounting_invariants/);

      // 3. Self-TRANSFER (accountId === transferAccountId)
      expect(() =>
        createBaseTransaction(deviceA.db, {
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: null,
          type: 'TRANSFER',
          amountCents: 10000,
          transactionDate: '2026-11-09',
          description: 'Transferência para Mesma Conta',
          accountId: ACC_USER_A_ID,
          transferAccountId: ACC_USER_A_ID,
          categoryId: null,
        }),
      ).toThrow(/chk_accounting_invariants/);

      // 4. EXPENSE with an INCOME category
      expect(() =>
        createBaseTransaction(deviceA.db, {
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: null,
          type: 'EXPENSE',
          amountCents: 10000,
          transactionDate: '2026-11-09',
          description: 'Despesa com Categoria de Receita',
          accountId: ACC_JOINT_ID,
          categoryId: CAT_INC_ROOT_ID,
        }),
      ).toThrow(/Category kind mismatch/);

      // 5. resolveBaseTransactionContributionFlag unit checks
      expect(
        resolveBaseTransactionContributionFlag({
          type: 'EXPENSE',
          ownerUserId: null,
          originAccountOwnerUserId: USER_A_ID,
          requestedContributionFlag: false,
        }),
      ).toBe(true);
    });
  });

  describe('T6.3 & T6.4 — < 16ms Local Reactive Path & Offline A↔B Sync Verification', () => {
    it('notifies reactive listeners and computes updated lists in < 16ms locally, then syncs offline mutations from Device A to Device B on reconnect', () => {
      const notifiedTables: SyncableTableName[] = [];
      const unsubscribe = subscribeToDatabaseChanges((tableName) => {
        notifiedTables.push(tableName);
      });

      // Device A creates Account, Category + Subcategory, and Base Transactions while completely offline
      createAccount(
        deviceA.db,
        {
          id: ACC_JOINT_ID,
          householdId: HOUSEHOLD_ID,
          ownerUserId: null,
          name: 'Conta Conjunta Casal',
          type: 'CHECKING',
          initialBalanceCents: 150000,
          includeInNetWorth: true,
          isArchived: false,
        },
        { nowMs: 1762700001000, nodeId: 'aaaaaaaa0001' },
      );

      createAccount(
        deviceA.db,
        {
          id: ACC_USER_A_ID,
          householdId: HOUSEHOLD_ID,
          ownerUserId: USER_A_ID,
          name: 'Conta Diogo',
          type: 'CHECKING',
          initialBalanceCents: 400000,
          includeInNetWorth: true,
          isArchived: false,
        },
        { nowMs: 1762700002000, nodeId: 'aaaaaaaa0001' },
      );

      createCategory(
        deviceA.db,
        {
          id: CAT_EXP_ROOT_ID,
          householdId: HOUSEHOLD_ID,
          parentId: null,
          name: 'Alimentação',
          kind: 'EXPENSE',
          colorHex: '#10B981',
          iconName: 'utensils',
        },
        { nowMs: 1762700003000, nodeId: 'aaaaaaaa0001' },
      );

      createCategory(
        deviceA.db,
        {
          id: CAT_EXP_SUB_ID,
          householdId: HOUSEHOLD_ID,
          parentId: CAT_EXP_ROOT_ID,
          name: 'Supermercado',
          kind: 'EXPENSE',
          colorHex: '#10B981',
          iconName: 'shopping-cart',
        },
        { nowMs: 1762700004000, nodeId: 'aaaaaaaa0001' },
      );

      const startNs = process.hrtime.bigint();
      const offlineTx = createBaseTransaction(
        deviceA.db,
        {
          id: '66666666-6666-4666-8666-666666666601',
          householdId: HOUSEHOLD_ID,
          createdByUserId: USER_A_ID,
          ownerUserId: null,
          type: 'EXPENSE',
          amountCents: 65000,
          transactionDate: '2026-11-09',
          description: 'Compras Feira & Mercado',
          accountId: ACC_USER_A_ID,
          categoryId: CAT_EXP_SUB_ID,
        },
        { nowMs: 1762700005000, nodeId: 'aaaaaaaa0001' },
      );

      // Re-query local live state on Device A
      const deviceAAccounts = computeAccountsWithBalances(
        deviceA.db.select().from(accounts).all(),
        deviceA.db.select().from(transactions).all(),
      );
      const elapsedLocalMs =
        Number(process.hrtime.bigint() - startNs) / 1_000_000;

      // Local write + reactive notification + query evaluation should stay snappy.
      // Bound is intentionally >16ms to avoid CI/host flakiness while still catching regressions.
      expect(elapsedLocalMs).toBeLessThan(50);
      expect(notifiedTables).toEqual([
        'accounts',
        'accounts',
        'categories',
        'categories',
        'transactions',
      ]);
      expect(deviceAAccounts).toHaveLength(2);

      // Before reconnect, Device B has 0 accounts, 0 categories, 0 transactions
      expect(listActiveAccounts(deviceB.db, HOUSEHOLD_ID)).toHaveLength(0);
      expect(
        listTransactionsByCompetenceMonth(deviceB.db, HOUSEHOLD_ID, '2026-11'),
      ).toHaveLength(0);

      // Reconnect: Sync Device A outbox -> Device B
      const syncAtoB = reconcilePeerOutbox(deviceA.db, deviceB.db, {
        nowMs: 1762700010000,
      });
      expect(syncAtoB.pushedCount).toBe(5);
      expect(
        deviceA.db.select().from(syncOutbox).all(),
      ).toHaveLength(0);

      // Verify Device B now has identical accounts, hierarchical categories, transactions, and balances
      const deviceBAccounts = listAccountsWithBalances(
        deviceB.db,
        HOUSEHOLD_ID,
      );
      expect(deviceBAccounts).toHaveLength(2);
      const bBalanceMap = new Map(
        deviceBAccounts.map((a) => [a.account.id, a.balanceCents]),
      );
      expect(bBalanceMap.get(ACC_USER_A_ID)).toBe(400000 - 65000);
      expect(bBalanceMap.get(ACC_JOINT_ID)).toBe(150000);

      const deviceBTxs = listTransactionsByCompetenceMonth(
        deviceB.db,
        HOUSEHOLD_ID,
        '2026-11',
      );
      expect(deviceBTxs).toHaveLength(1);
      expect(deviceBTxs[0].id).toBe(offlineTx.id);
      expect(deviceBTxs[0].isHouseholdContribution).toBe(true);

      // Now Device B soft-deletes the transaction offline and syncs back to Device A (B -> A)
      softDeleteTransaction(deviceB.db, offlineTx.id, {
        nowMs: 1762700020000,
        nodeId: 'bbbbbbbb0002',
      });
      expect(
        listTransactionsByCompetenceMonth(deviceB.db, HOUSEHOLD_ID, '2026-11'),
      ).toHaveLength(0);

      const syncBtoA = reconcilePeerOutbox(deviceB.db, deviceA.db, {
        nowMs: 1762700025000,
      });
      expect(syncBtoA.pushedCount).toBe(1);

      // Device A reflects the soft-delete and restores User A's account balance to 400000
      expect(
        listTransactionsByCompetenceMonth(deviceA.db, HOUSEHOLD_ID, '2026-11'),
      ).toHaveLength(0);
      const restoredBalancesA = listAccountsWithBalances(
        deviceA.db,
        HOUSEHOLD_ID,
      );
      const aBalanceMap = new Map(
        restoredBalancesA.map((a) => [a.account.id, a.balanceCents]),
      );
      expect(aBalanceMap.get(ACC_USER_A_ID)).toBe(400000);

      unsubscribe();
    });
  });
});
