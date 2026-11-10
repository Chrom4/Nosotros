import {
  applyRecurringRuleUpdateToOccurrences,
  generateInvoiceId,
  generateRecurringTransactionId,
  isRecurringRuleDueInMonth,
  materializeRecurringTransaction,
  NAMESPACE_RECURRING,
  uuidv5,
  type RecurringRuleDefinition,
} from '@/core/recurring';

describe('Phase 1 — Deterministic Recurring Rules & UUIDv5 (/src/core/recurring.ts)', () => {
  describe('RFC 4122 UUIDv5 standard vectors', () => {
    it('matches standard RFC 4122 DNS namespace SHA-1 UUIDv5 vectors', () => {
      const dnsNamespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      expect(uuidv5(dnsNamespace, 'python.org')).toBe(
        '886313e1-3b8a-5372-9b90-0c9aee199e5d',
      );
      expect(uuidv5(dnsNamespace, 'www.example.com')).toBe(
        '2ed6657d-e927-568b-95e1-2665a8aea6a2',
      );
    });
  });

  describe('TEST-FIN-06: Concurrent offline recurring generation without duplication (AUD-05)', () => {
    const fiberRule: RecurringRuleDefinition = {
      id: 'c36b8b40-9e42-4e8d-9b39-1a2b3c4d5e6f',
      ownerUserId: null, // Domestic internet bill
      type: 'EXPENSE',
      accountId: 'a1111111-2222-4333-8444-555555555555',
      creditCardId: null,
      categoryId: 'b1111111-2222-4333-8444-555555555555',
      description: 'Internet Fibra',
      amountCents: 14990,
      frequency: 'MONTHLY',
      dayOfMonth: 15,
      startMonth: '2026-01',
      endMonth: null,
      isActive: true,
      deletedAt: null,
    };

    it('produces the exact same UUIDv5 and identical LedgerTransaction on two offline devices for 2026-12', () => {
      // Device A materializes 2026-12 offline
      const deviceATx = materializeRecurringTransaction(fiberRule, '2026-12');
      // Device B materializes 2026-12 offline
      const deviceBTx = materializeRecurringTransaction(fiberRule, '2026-12');

      const expectedId = uuidv5(NAMESPACE_RECURRING, `${fiberRule.id}:2026-12`);
      expect(deviceATx.id).toBe(expectedId);
      expect(deviceBTx.id).toBe(expectedId);
      expect(deviceATx.id).toBe(deviceBTx.id);
      expect(deviceATx.transactionDate).toBe('2026-12-15');
      expect(deviceATx.status).toBe('PENDING');

      // Deduping by primary key (id) as done by ON CONFLICT (id) DO UPDATE yields 1 row
      const convergedLedger = new Map([
        [deviceATx.id, deviceATx],
        [deviceBTx.id, deviceBTx],
      ]);
      expect(convergedLedger.size).toBe(1);
    });

    it('generates distinct deterministic UUIDs across different months or rules', () => {
      const decId = generateRecurringTransactionId(fiberRule.id, '2026-12');
      const janId = generateRecurringTransactionId(fiberRule.id, '2027-01');
      expect(decId).not.toBe(janId);

      const invDec = generateInvoiceId('99999999-2222-4333-8444-555555555555', '2026-12');
      expect(invDec).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('preserves past or CLEARED occurrences when the recurring rule is edited', () => {
      const novCleared = {
        ...materializeRecurringTransaction(fiberRule, '2026-11'),
        status: 'CLEARED' as const,
      };
      const decPending = materializeRecurringTransaction(fiberRule, '2026-12');
      const janPending = materializeRecurringTransaction(fiberRule, '2027-01');

      const updatedRule: RecurringRuleDefinition = {
        ...fiberRule,
        amountCents: 16990,
        description: 'Internet Fibra 1Gbps',
      };

      const updatedList = applyRecurringRuleUpdateToOccurrences(updatedRule, '2026-12', [
        novCleared,
        decPending,
        janPending,
      ]);

      expect(updatedList[0].amountCents).toBe(14990); // CLEARED past untouched
      expect(updatedList[1].amountCents).toBe(16990); // Current PENDING updated
      expect(updatedList[2].amountCents).toBe(16990); // Future PENDING updated
    });

    it('clamps dayOfMonth to valid calendar days (e.g. Feb 28) and checks YEARLY frequency', () => {
      const yearlyRule: RecurringRuleDefinition = {
        ...fiberRule,
        frequency: 'YEARLY',
        dayOfMonth: 31,
        startMonth: '2026-02',
      };

      expect(isRecurringRuleDueInMonth(yearlyRule, '2026-02')).toBe(true);
      expect(isRecurringRuleDueInMonth(yearlyRule, '2026-03')).toBe(false);
      expect(isRecurringRuleDueInMonth(yearlyRule, '2027-02')).toBe(true);

      const febTx = materializeRecurringTransaction(yearlyRule, '2026-02');
      expect(febTx.transactionDate).toBe('2026-02-28');
    });
  });
});
