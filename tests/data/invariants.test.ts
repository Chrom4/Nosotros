import {
  getOrCreateDeviceNodeId,
  getOrCreateSqlCipherKeyHex,
  type KeyStoreAdapter,
  SQLCIPHER_KEY_STORAGE_KEY,
} from '@/data/db';
import {
  createAccount,
  createCategory,
  createCreditCard,
  createCreditCardInvoice,
  upsertLocalHousehold,
  upsertLocalHouseholdMember,
} from '@/data/repositories';
import { createInMemoryTestDb, type InMemoryTestDb } from './testDbHelper';

const HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';
const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACCOUNT_A_ID = '22222222-2222-4222-8222-222222222221';
const ACCOUNT_B_ID = '22222222-2222-4222-8222-222222222222';
const CATEGORY_EXP_ID = '33333333-3333-4333-8333-333333333331';
const CARD_ID = '44444444-4444-4444-8444-444444444441';
const INVOICE_ID = '55555555-5555-4555-8555-555555555551';
const HLC_SAMPLE = '2026-11-06T18:00:00.000Z-0000-010203040506';

describe('Phase 2 — TEST-DB-01: SQLite Schema & Accounting CHECK Invariants', () => {
  let harness: InMemoryTestDb;

  beforeEach(() => {
    harness = createInMemoryTestDb();
    upsertLocalHousehold(harness.db, {
      id: HOUSEHOLD_ID,
      name: 'Casa Diogo & Parceira',
    });
    createAccount(harness.db, {
      id: ACCOUNT_A_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_A_ID,
      name: 'Conta Corrente A',
      type: 'CHECKING',
      initialBalanceCents: 500000,
      includeInNetWorth: true,
      isArchived: false,
    });
    createAccount(harness.db, {
      id: ACCOUNT_B_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: null,
      name: 'Conta Conjunta',
      type: 'CHECKING',
      initialBalanceCents: 100000,
      includeInNetWorth: true,
      isArchived: false,
    });
    createCategory(harness.db, {
      id: CATEGORY_EXP_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Alimentação',
      kind: 'EXPENSE',
      colorHex: '#FF5722',
      iconName: 'utensils',
    });
    createCreditCard(harness.db, {
      id: CARD_ID,
      householdId: HOUSEHOLD_ID,
      ownerUserId: USER_A_ID,
      defaultPaymentAccountId: ACCOUNT_A_ID,
      name: 'Nubank Ultravioleta',
      limitCents: 2000000,
      closingDay: 10,
      dueDay: 17,
      isArchived: false,
    });
    createCreditCardInvoice(harness.db, {
      id: INVOICE_ID,
      householdId: HOUSEHOLD_ID,
      creditCardId: CARD_ID,
      competenceMonth: '2026-11',
      closingDate: '2026-11-10',
      dueDate: '2026-11-17',
      status: 'OPEN',
    });
  });

  afterEach(() => {
    harness.close();
  });

  const insertRawTransaction = (overrides: Record<string, unknown>) => {
    const base = {
      id: '99999999-9999-4999-8999-999999999999',
      household_id: HOUSEHOLD_ID,
      created_by_user_id: USER_A_ID,
      owner_user_id: USER_A_ID,
      type: 'EXPENSE',
      status: 'CLEARED',
      amount_cents: 15000,
      transaction_date: '2026-11-06',
      competence_month: '2026-11',
      description: 'Teste Invariante SQL',
      notes: null,
      account_id: ACCOUNT_A_ID,
      transfer_account_id: null,
      credit_card_id: null,
      invoice_id: null,
      category_id: CATEGORY_EXP_ID,
      installment_plan_id: null,
      installment_number: null,
      total_installments: null,
      recurring_rule_id: null,
      refunded_transaction_id: null,
      is_household_contribution: 0,
      calendar_event_id: null,
      created_at: '2026-11-06T18:00:00.000Z',
      updated_at: '2026-11-06T18:00:00.000Z',
      deleted_at: null,
      hlc_timestamp: HLC_SAMPLE,
      field_hlc: '{}',
      server_seq: 0,
      ...overrides,
    };

    const stmt = harness.raw.prepare(`
      INSERT INTO transactions (
        id, household_id, created_by_user_id, owner_user_id, type, status,
        amount_cents, transaction_date, competence_month, description, notes,
        account_id, transfer_account_id, credit_card_id, invoice_id, category_id,
        installment_plan_id, installment_number, total_installments, recurring_rule_id,
        refunded_transaction_id, is_household_contribution, calendar_event_id,
        created_at, updated_at, deleted_at, hlc_timestamp, field_hlc, server_seq
      ) VALUES (
        @id, @household_id, @created_by_user_id, @owner_user_id, @type, @status,
        @amount_cents, @transaction_date, @competence_month, @description, @notes,
        @account_id, @transfer_account_id, @credit_card_id, @invoice_id, @category_id,
        @installment_plan_id, @installment_number, @total_installments, @recurring_rule_id,
        @refunded_transaction_id, @is_household_contribution, @calendar_event_id,
        @created_at, @updated_at, @deleted_at, @hlc_timestamp, @field_hlc, @server_seq
      )
    `);

    return stmt.run(base);
  };

  it('TEST-DB-01.1: rejects CREDIT_PURCHASE when account_id IS NOT NULL or invoice_id IS NULL', () => {
    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000001',
        type: 'CREDIT_PURCHASE',
        account_id: ACCOUNT_A_ID, // Illegal for CREDIT_PURCHASE
        credit_card_id: CARD_ID,
        invoice_id: INVOICE_ID,
        category_id: CATEGORY_EXP_ID,
      }),
    ).toThrow(/chk_accounting_invariants/);

    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000002',
        type: 'CREDIT_PURCHASE',
        account_id: null,
        credit_card_id: CARD_ID,
        invoice_id: null, // Illegal: invoice_id required
        category_id: CATEGORY_EXP_ID,
      }),
    ).toThrow(/chk_accounting_invariants/);
  });

  it('TEST-DB-01.2: rejects TRANSFER when transfer_account_id IS NULL, equals account_id, or has category_id', () => {
    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000003',
        type: 'TRANSFER',
        account_id: ACCOUNT_A_ID,
        transfer_account_id: null, // Illegal
        category_id: null,
      }),
    ).toThrow(/chk_accounting_invariants/);

    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000004',
        type: 'TRANSFER',
        account_id: ACCOUNT_A_ID,
        transfer_account_id: ACCOUNT_A_ID, // Illegal self-transfer
        category_id: null,
      }),
    ).toThrow(/chk_accounting_invariants/);

    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000005',
        type: 'TRANSFER',
        account_id: ACCOUNT_A_ID,
        transfer_account_id: ACCOUNT_B_ID,
        category_id: CATEGORY_EXP_ID, // Illegal: category_id must be NULL on TRANSFER
      }),
    ).toThrow(/chk_accounting_invariants/);
  });

  it('TEST-DB-01.3: rejects EXPENSE/INCOME/DEBIT_REFUND with credit_card_id or missing category_id', () => {
    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000006',
        type: 'EXPENSE',
        account_id: ACCOUNT_A_ID,
        credit_card_id: CARD_ID, // Illegal on EXPENSE
        category_id: CATEGORY_EXP_ID,
      }),
    ).toThrow(/chk_accounting_invariants/);

    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000007',
        type: 'INCOME',
        account_id: ACCOUNT_A_ID,
        category_id: null, // Illegal on INCOME
      }),
    ).toThrow(/chk_accounting_invariants/);
  });

  it('TEST-DB-01.4: rejects INVOICE_PAYMENT with category_id IS NOT NULL or missing account_id/invoice_id', () => {
    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000008',
        type: 'INVOICE_PAYMENT',
        account_id: ACCOUNT_A_ID,
        credit_card_id: CARD_ID,
        invoice_id: INVOICE_ID,
        category_id: CATEGORY_EXP_ID, // Illegal on INVOICE_PAYMENT
      }),
    ).toThrow(/chk_accounting_invariants/);

    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000009',
        type: 'INVOICE_PAYMENT',
        account_id: null, // Illegal
        credit_card_id: CARD_ID,
        invoice_id: INVOICE_ID,
        category_id: null,
      }),
    ).toThrow(/chk_accounting_invariants/);
  });

  it('TEST-DB-01.5: rejects non-positive amount_cents (<= 0) and invalid competence_month at SQLite level', () => {
    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000010',
        amount_cents: 0,
      }),
    ).toThrow(/chk_transactions_amount_cents/);

    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000011',
        amount_cents: -500,
      }),
    ).toThrow(/chk_transactions_amount_cents/);

    expect(() =>
      insertRawTransaction({
        id: '99999999-9999-4999-8999-000000000012',
        competence_month: '2026/11',
      }),
    ).toThrow(/chk_transactions_competence_month/);
  });

  it('TEST-DB-01.6: enforces maximum of 2 active members per household in repository', () => {
    upsertLocalHouseholdMember(harness.db, {
      id: '10000000-0000-4000-8000-000000000001',
      householdId: HOUSEHOLD_ID,
      userId: USER_A_ID,
      displayName: 'Diogo',
      role: 'FOUNDER',
      colorHex: '#1E88E5',
    });
    upsertLocalHouseholdMember(harness.db, {
      id: '10000000-0000-4000-8000-000000000002',
      householdId: HOUSEHOLD_ID,
      userId: USER_B_ID,
      displayName: 'Parceira',
      role: 'PARTNER',
      colorHex: '#8E24AA',
    });

    expect(() =>
      upsertLocalHouseholdMember(harness.db, {
        id: '10000000-0000-4000-8000-000000000003',
        householdId: HOUSEHOLD_ID,
        userId: USER_C_ID,
        displayName: 'Intruso',
        role: 'PARTNER',
        colorHex: '#43A047',
      }),
    ).toThrow(/HOUSEHOLD_FULL/);
  });

  it('TEST-DB-01.7: generates and persists 256-bit SQLCipher key and 48-bit device nodeId via KeyStoreAdapter', async () => {
    const store = new Map<string, string>();
    let seed = 1;
    const mockAdapter: KeyStoreAdapter = {
      getItemAsync: async (k) => store.get(k) ?? null,
      setItemAsync: async (k, v) => {
        store.set(k, v);
      },
      getRandomBytes: (len) => {
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          arr[i] = (seed * 37 + i * 13) & 0xff;
        }
        seed++;
        return arr;
      },
    };

    const key1 = await getOrCreateSqlCipherKeyHex(mockAdapter);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
    expect(store.get(SQLCIPHER_KEY_STORAGE_KEY)).toBe(key1);

    // Subsequent call loads the exact same key without regenerating
    const key2 = await getOrCreateSqlCipherKeyHex(mockAdapter);
    expect(key2).toBe(key1);

    const nodeId1 = await getOrCreateDeviceNodeId(mockAdapter);
    expect(nodeId1).toMatch(/^[0-9a-f]{12}$/);
    const nodeId2 = await getOrCreateDeviceNodeId(mockAdapter);
    expect(nodeId2).toBe(nodeId1);
  });
});
