import { eq } from 'drizzle-orm';
import {
  createAccount,
  createBaseTransaction,
  createBudget,
  createCategory,
  createCreditCard,
  createInstallmentPurchase,
  createRecurringRule,
  upsertLocalHousehold,
  upsertLocalHouseholdMember,
} from '@/data';
import * as schema from '@/data/schema';
import {
  createEncryptedBackupFile,
  restoreDatabaseFromBackup,
} from '@/sync/backupService';
import { createInMemoryTestDb, type InMemoryTestDb } from '../data/testDbHelper';

describe('Disaster Recovery Drill — Device A to Device B Restore with sync_epoch Bump', () => {
  let deviceA: InMemoryTestDb;
  let deviceB: InMemoryTestDb;

  const couplePassphrase = 'minha-senha-secreta-do-casal-2026';
  const householdId = '11111111-1111-4111-8111-111111111111';
  const founderUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const partnerUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const accId = '22222222-2222-4222-8222-222222222201';
  const catExpenseId = '33333333-3333-4333-8333-333333333301';
  const catIncomeId = '33333333-3333-4333-8333-333333333302';
  const cardId = '44444444-4444-4444-8444-444444444401';
  const instId = '55555555-5555-4555-8555-555555555501';
  const ruleRentId = '66666666-6666-4666-8666-666666666601';
  const tx1Id = '77777777-7777-4777-8777-777777777701';
  const tx2Id = '77777777-7777-4777-8777-777777777702';
  const bgtId = '88888888-8888-4888-8888-888888888801';

  beforeEach(() => {
    deviceA = createInMemoryTestDb();
    deviceB = createInMemoryTestDb();
  });

  afterEach(() => {
    deviceA.close();
    deviceB.close();
  });

  it('performs full backup from Device A and restores on Device B bumping sync_epoch', async () => {
    const dbA = deviceA.db;

    // 1. Seed complete domain state on Device A
    upsertLocalHousehold(dbA, {
      id: householdId,
      name: 'Casal Silva & Souza',
    });

    upsertLocalHouseholdMember(dbA, {
      id: '10000000-0000-4000-8000-000000000001',
      householdId,
      userId: founderUserId,
      displayName: 'Diogo',
      role: 'FOUNDER',
      colorHex: '#3B82F6',
    });

    upsertLocalHouseholdMember(dbA, {
      id: '10000000-0000-4000-8000-000000000002',
      householdId,
      userId: partnerUserId,
      displayName: 'Parceira',
      role: 'PARTNER',
      colorHex: '#EC4899',
    });

    createAccount(dbA, {
      id: accId,
      householdId,
      ownerUserId: null,
      name: 'Conta Conjunta Nubank',
      type: 'CHECKING',
      initialBalanceCents: 500000,
      includeInNetWorth: true,
      isArchived: false,
    });

    createCategory(dbA, {
      id: catExpenseId,
      householdId,
      parentId: null,
      name: 'Alimentação',
      kind: 'EXPENSE',
      colorHex: '#EF4444',
      iconName: 'cart',
    });

    createCategory(dbA, {
      id: catIncomeId,
      householdId,
      parentId: null,
      name: 'Salário',
      kind: 'INCOME',
      colorHex: '#10B981',
      iconName: 'cash',
    });

    createCreditCard(dbA, {
      id: cardId,
      householdId,
      ownerUserId: null,
      defaultPaymentAccountId: accId,
      name: 'Nubank Ultravioleta',
      closingDay: 5,
      dueDay: 12,
      limitCents: 2000000,
      isArchived: false,
    });

    createInstallmentPurchase(dbA, {
      plan: {
        id: instId,
        householdId,
        createdByUserId: founderUserId,
        ownerUserId: null,
        creditCardId: cardId,
        accountId: null,
        categoryId: catExpenseId,
        description: 'Geladeira Nova Frost Free 10x',
        totalAmountCents: 350000,
        totalInstallments: 10,
        purchaseDate: '2026-11-01',
      },
    });

    createRecurringRule(dbA, {
      id: ruleRentId,
      householdId,
      createdByUserId: founderUserId,
      ownerUserId: null,
      accountId: accId,
      creditCardId: null,
      categoryId: catExpenseId,
      type: 'EXPENSE',
      description: 'Aluguel do Apartamento',
      amountCents: 250000,
      frequency: 'MONTHLY',
      dayOfMonth: 10,
      startMonth: '2026-01',
      endMonth: null,
      isActive: true,
    });

    createBaseTransaction(dbA, {
      id: tx1Id,
      householdId,
      createdByUserId: founderUserId,
      ownerUserId: null,
      accountId: accId,
      categoryId: catExpenseId,
      type: 'EXPENSE',
      amountCents: 15450,
      description: 'Supermercado Mensal',
      transactionDate: '2026-11-02',
    });

    createBaseTransaction(dbA, {
      id: tx2Id,
      householdId,
      createdByUserId: founderUserId,
      ownerUserId: null,
      accountId: accId,
      categoryId: catIncomeId,
      type: 'INCOME',
      amountCents: 850000,
      description: 'Salário Trabalho',
      transactionDate: '2026-11-05',
    });

    createBudget(dbA, {
      id: bgtId,
      householdId,
      ownerUserId: null,
      categoryId: catExpenseId,
      competenceMonth: '2026-11',
      limitCents: 200000,
    });

    // 2. Create encrypted backup on Device A
    const backupResult = await createEncryptedBackupFile(
      dbA,
      householdId,
      couplePassphrase,
    );

    expect(backupResult.filename).toContain('nosotros_backup_');
    expect(backupResult.envelope).toBeInstanceOf(Uint8Array);
    expect(backupResult.envelope.length).toBeGreaterThan(100);

    // 3. Catastrophic Disaster: Device B restores onto fresh DB
    const dbB = deviceB.db;

    // Verify wrong passphrase fails without touching DB
    await expect(
      restoreDatabaseFromBackup(
        dbB,
        backupResult.envelope,
        'senha-errada-nao-autorizada',
      ),
    ).rejects.toThrow(/BACKUP_DECRYPTION_FAILED/);

    const [bHouseholdBefore] = await dbB.select().from(schema.households);
    expect(bHouseholdBefore).toBeUndefined();

    // 4. Restore with correct couple passphrase
    const restoreResult = await restoreDatabaseFromBackup(
      dbB,
      backupResult.envelope,
      couplePassphrase,
    );

    expect(restoreResult.success).toBe(true);
    expect(restoreResult.householdId).toBe(householdId);
    expect(restoreResult.previousSyncEpoch).toBe(1);
    expect(restoreResult.newSyncEpoch).toBe(2);
    expect(restoreResult.recordCounts.accounts).toBe(1);
    expect(restoreResult.recordCounts.categories).toBe(2);
    expect(restoreResult.recordCounts.creditCards).toBe(1);
    expect(restoreResult.recordCounts.installmentPlans).toBe(1);
    expect(restoreResult.recordCounts.recurringRules).toBe(1);
    expect(restoreResult.recordCounts.budgets).toBe(1);
    // Transactions include the 2 base transactions + 10 installment slice transactions created by createInstallmentPurchase
    expect(restoreResult.recordCounts.transactions).toBe(12);

    // 5. Verify restored state on Device B
    const [restoredHousehold] = await dbB
      .select()
      .from(schema.households)
      .where(eq(schema.households.id, householdId));

    expect(restoredHousehold).toBeDefined();
    expect(restoredHousehold.name).toBe('Casal Silva & Souza');
    expect(restoredHousehold.syncEpoch).toBe(2); // sync_epoch bumped!

    // Verify sync_meta has the bumped epoch
    const [metaEpoch] = await dbB
      .select()
      .from(schema.syncMeta)
      .where(eq(schema.syncMeta.key, schema.SYNC_META_KEYS.SYNC_EPOCH));

    expect(metaEpoch).toBeDefined();
    expect(metaEpoch.value).toBe('2');

    // Verify members
    const restoredMembers = await dbB.select().from(schema.householdMembers);
    expect(restoredMembers).toHaveLength(2);

    // Verify transactions
    const restoredTxs = await dbB.select().from(schema.transactions);
    expect(restoredTxs).toHaveLength(12);

    const txSuper = restoredTxs.find((t) => t.id === tx1Id);
    expect(txSuper?.amountCents).toBe(15450);
    expect(txSuper?.description).toBe('Supermercado Mensal');

    // Verify credit cards & installments
    const restoredCards = await dbB.select().from(schema.creditCards);
    expect(restoredCards).toHaveLength(1);
    expect(restoredCards[0].name).toBe('Nubank Ultravioleta');

    const restoredPlans = await dbB.select().from(schema.installmentPlans);
    expect(restoredPlans).toHaveLength(1);
    expect(restoredPlans[0].totalAmountCents).toBe(350000);
  });
});
