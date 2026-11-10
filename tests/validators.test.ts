import {
  AccountInputSchema,
  BudgetInputSchema,
  CategoryInputSchema,
  CreditCardInputSchema,
  HlcStringSchema,
  InstallmentPlanInputSchema,
  RecurringRuleInputSchema,
  TransactionInputSchema,
} from '@/core/validators';

describe('Phase 1 — Zod Domain Validators (/src/core/validators.ts)', () => {
  const uuid1 = '11111111-1111-4111-8111-111111111111';
  const uuid2 = '22222222-2222-4222-8222-222222222222';
  const uuid3 = '33333333-3333-4333-8333-333333333333';
  const uuid4 = '44444444-4444-4444-8444-444444444444';
  const uuid5 = '55555555-5555-4555-8555-555555555555';

  it('validates canonical TransactionInputSchema across all 4 pointer invariant groups', () => {
    // 1. EXPENSE
    expect(
      TransactionInputSchema.safeParse({
        id: uuid1,
        householdId: uuid2,
        createdByUserId: uuid3,
        ownerUserId: null,
        type: 'EXPENSE',
        amountCents: 15000,
        transactionDate: '2026-11-06',
        competenceMonth: '2026-11',
        description: 'Supermercado',
        accountId: uuid4,
        categoryId: uuid5,
      }).success,
    ).toBe(true);

    // 2. TRANSFER
    expect(
      TransactionInputSchema.safeParse({
        id: uuid1,
        householdId: uuid2,
        createdByUserId: uuid3,
        ownerUserId: uuid3,
        type: 'TRANSFER',
        amountCents: 180000,
        transactionDate: '2026-11-06',
        competenceMonth: '2026-11',
        description: 'Aporte Conta Conjunta',
        accountId: uuid4,
        transferAccountId: uuid5,
        isHouseholdContribution: true,
      }).success,
    ).toBe(true);

    // 3. CREDIT_PURCHASE
    expect(
      TransactionInputSchema.safeParse({
        id: uuid1,
        householdId: uuid2,
        createdByUserId: uuid3,
        ownerUserId: uuid3,
        type: 'CREDIT_PURCHASE',
        amountCents: 40000,
        transactionDate: '2026-11-06',
        competenceMonth: '2026-11',
        description: 'Eletrônicos',
        creditCardId: uuid4,
        invoiceId: uuid5,
        categoryId: uuid2,
      }).success,
    ).toBe(true);

    // 4. INVOICE_PAYMENT
    expect(
      TransactionInputSchema.safeParse({
        id: uuid1,
        householdId: uuid2,
        createdByUserId: uuid3,
        ownerUserId: uuid3,
        type: 'INVOICE_PAYMENT',
        amountCents: 40000,
        transactionDate: '2026-12-05',
        competenceMonth: '2026-12',
        description: 'Pagamento Fatura Nov',
        accountId: uuid4,
        creditCardId: uuid5,
        invoiceId: uuid2,
        categoryId: null,
      }).success,
    ).toBe(true);
  });

  it('rejects invalid pointer combinations and floating-point cent amounts', () => {
    // CREDIT_PURCHASE with accountId != null must fail
    const badCreditPurchase = TransactionInputSchema.safeParse({
      id: uuid1,
      householdId: uuid2,
      createdByUserId: uuid3,
      ownerUserId: null,
      type: 'CREDIT_PURCHASE',
      amountCents: 10000,
      transactionDate: '2026-11-06',
      competenceMonth: '2026-11',
      description: 'Compra Inválida',
      accountId: uuid4,
      creditCardId: uuid5,
      invoiceId: uuid2,
      categoryId: uuid3,
    });
    expect(badCreditPurchase.success).toBe(false);

    // TRANSFER with same origin and destination account must fail
    const badTransfer = TransactionInputSchema.safeParse({
      id: uuid1,
      householdId: uuid2,
      createdByUserId: uuid3,
      ownerUserId: null,
      type: 'TRANSFER',
      amountCents: 10000,
      transactionDate: '2026-11-06',
      competenceMonth: '2026-11',
      description: 'Transferência para mesma conta',
      accountId: uuid4,
      transferAccountId: uuid4,
    });
    expect(badTransfer.success).toBe(false);

    // Float amountCents must fail
    const floatTx = TransactionInputSchema.safeParse({
      id: uuid1,
      householdId: uuid2,
      createdByUserId: uuid3,
      ownerUserId: null,
      type: 'INCOME',
      amountCents: 99.95,
      transactionDate: '2026-11-06',
      competenceMonth: '2026-11',
      description: 'Float proibido',
      accountId: uuid4,
      categoryId: uuid5,
    });
    expect(floatTx.success).toBe(false);
  });

  it('validates Account, Category, CreditCard, InstallmentPlan, RecurringRule, Budget, and HLC schemas', () => {
    expect(
      AccountInputSchema.safeParse({
        id: uuid1,
        householdId: uuid2,
        ownerUserId: null,
        name: 'Conta Conjunta',
        type: 'CHECKING',
        initialBalanceCents: 0,
      }).success,
    ).toBe(true);

    expect(
      CategoryInputSchema.safeParse({
        id: uuid1,
        householdId: uuid2,
        parentId: null,
        name: 'Lazer',
        kind: 'EXPENSE',
        colorHex: '#4CAF50',
        iconName: 'celebration',
      }).success,
    ).toBe(true);

    expect(
      CreditCardInputSchema.safeParse({
        id: uuid1,
        householdId: uuid2,
        ownerUserId: uuid3,
        defaultPaymentAccountId: uuid4,
        name: 'Nubank Ultravioleta',
        limitCents: 300000,
        closingDay: 10,
        dueDay: 17,
      }).success,
    ).toBe(true);

    expect(
      InstallmentPlanInputSchema.safeParse({
        id: uuid1,
        householdId: uuid2,
        createdByUserId: uuid3,
        ownerUserId: null,
        creditCardId: uuid4,
        accountId: null,
        categoryId: uuid5,
        description: 'Geladeira 10x',
        totalAmountCents: 450000,
        totalInstallments: 10,
        purchaseDate: '2026-11-06',
      }).success,
    ).toBe(true);

    expect(
      RecurringRuleInputSchema.safeParse({
        id: uuid1,
        householdId: uuid2,
        createdByUserId: uuid3,
        ownerUserId: null,
        type: 'EXPENSE',
        accountId: uuid4,
        creditCardId: null,
        categoryId: uuid5,
        description: 'Condomínio',
        amountCents: 85000,
        frequency: 'MONTHLY',
        dayOfMonth: 10,
        startMonth: '2026-01',
        endMonth: null,
      }).success,
    ).toBe(true);

    expect(
      BudgetInputSchema.safeParse({
        id: uuid1,
        householdId: uuid2,
        ownerUserId: null,
        categoryId: uuid5,
        competenceMonth: '2026-11',
        limitCents: 120000,
      }).success,
    ).toBe(true);

    expect(
      HlcStringSchema.safeParse('2026-11-06T18:45:12.345Z-0001-a1b2c3d4e5f6').success,
    ).toBe(true);
    expect(HlcStringSchema.safeParse('invalid-hlc').success).toBe(false);
  });
});
