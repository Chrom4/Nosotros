import {
  assertCompetenceMonth,
  assertTransactionInvariants,
  assertValidCents,
  type LedgerTransaction,
} from './accounting';

export const NAMESPACE_RECURRING = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
export const NAMESPACE_INVOICE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

export type RecurringRuleType = 'INCOME' | 'EXPENSE' | 'CREDIT_PURCHASE';
export type RecurringFrequency = 'MONTHLY' | 'YEARLY';

export interface RecurringRuleDefinition {
  id: string;
  ownerUserId: string | null;
  type: RecurringRuleType;
  accountId: string | null;
  creditCardId: string | null;
  categoryId: string;
  description: string;
  amountCents: number;
  frequency: RecurringFrequency;
  dayOfMonth: number; // 1..31
  startMonth: string; // YYYY-MM
  endMonth: string | null; // YYYY-MM | null
  isActive: boolean;
  deletedAt: string | null;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuidToBytes(uuid: string): Uint8Array {
  if (!UUID_REGEX.test(uuid)) {
    throw new Error(`Invalid UUID format: ${uuid}`);
  }
  const hex = uuid.replace(/-/g, '').toLowerCase();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function utf8Encode(input: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(input);
  }
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let codePoint = input.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = ((codePoint - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function rotl32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

/**
 * Pure TypeScript FIPS 180-4 SHA-1 implementation for RFC 4122 UUIDv5 generation.
 */
function sha1Bytes(message: Uint8Array): Uint8Array {
  const mlBits = message.length * 8;
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(message);
  buffer[message.length] = 0x80;

  const view = new DataView(buffer.buffer);
  const highBits = Math.floor(mlBits / 0x100000000);
  const lowBits = mlBits >>> 0;
  view.setUint32(paddedLength - 8, highBits, false);
  view.setUint32(paddedLength - 4, lowBits, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f = 0;
      let k = 0;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotl32(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, h0, false);
  digestView.setUint32(4, h1, false);
  digestView.setUint32(8, h2, false);
  digestView.setUint32(12, h3, false);
  digestView.setUint32(16, h4, false);
  return digest;
}

function formatUuidBytes(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/**
 * Generates an RFC 4122 compliant deterministic UUIDv5 (SHA-1 namespace hash).
 */
export function uuidv5(namespaceUuid: string, name: string): string {
  const nsBytes = parseUuidToBytes(namespaceUuid);
  const nameBytes = utf8Encode(name);

  const combined = new Uint8Array(nsBytes.length + nameBytes.length);
  combined.set(nsBytes, 0);
  combined.set(nameBytes, nsBytes.length);

  const hash = sha1Bytes(combined).slice(0, 16);
  // Set version to 5 (0101xxxx)
  hash[6] = (hash[6] & 0x0f) | 0x50;
  // Set variant to RFC 4122 (10xxxxxx)
  hash[8] = (hash[8] & 0x3f) | 0x80;

  return formatUuidBytes(hash);
}

/**
 * Generates the deterministic primary key for a recurring transaction occurrence:
 * `UUIDv5(NAMESPACE_RECURRING, recurring_rule_id + ":" + competence_month)` (Resolves AUD-05).
 */
export function generateRecurringTransactionId(
  recurringRuleId: string,
  competenceMonth: string,
): string {
  if (!recurringRuleId || typeof recurringRuleId !== 'string') {
    throw new Error('Invalid recurringRuleId');
  }
  assertCompetenceMonth(competenceMonth, 'competenceMonth');
  return uuidv5(NAMESPACE_RECURRING, `${recurringRuleId}:${competenceMonth}`);
}

/**
 * Generates the deterministic primary key for a credit card invoice:
 * `UUIDv5(NAMESPACE_INVOICE, credit_card_id + ":" + competence_month)`.
 */
export function generateInvoiceId(creditCardId: string, competenceMonth: string): string {
  if (!creditCardId || typeof creditCardId !== 'string') {
    throw new Error('Invalid creditCardId');
  }
  assertCompetenceMonth(competenceMonth, 'competenceMonth');
  return uuidv5(NAMESPACE_INVOICE, `${creditCardId}:${competenceMonth}`);
}

function daysInCalendarMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

/**
 * Checks whether a recurring rule is active and scheduled to occur in `competenceMonth`.
 */
export function isRecurringRuleDueInMonth(
  rule: RecurringRuleDefinition,
  competenceMonth: string,
): boolean {
  assertCompetenceMonth(competenceMonth, 'competenceMonth');
  assertCompetenceMonth(rule.startMonth, 'rule.startMonth');
  if (rule.endMonth !== null) {
    assertCompetenceMonth(rule.endMonth, 'rule.endMonth');
  }

  if (!rule.isActive || rule.deletedAt !== null) {
    return false;
  }
  if (competenceMonth < rule.startMonth) {
    return false;
  }
  if (rule.endMonth !== null && competenceMonth > rule.endMonth) {
    return false;
  }

  if (rule.frequency === 'YEARLY') {
    const startMonthPart = rule.startMonth.slice(5, 7);
    const targetMonthPart = competenceMonth.slice(5, 7);
    return startMonthPart === targetMonthPart;
  }

  return true;
}

/**
 * Materializes a `PENDING` (or `CLEARED` for credit purchase if specified) `LedgerTransaction`
 * for a given `RecurringRuleDefinition` and `competenceMonth`.
 * Because the ID is computed via `generateRecurringTransactionId`, two offline devices
 * materializing the same month will produce identical transaction IDs and converge cleanly.
 */
export function materializeRecurringTransaction(
  rule: RecurringRuleDefinition,
  competenceMonth: string,
  options: { invoiceId?: string | null } = {},
): LedgerTransaction {
  assertValidCents(rule.amountCents, 'rule.amountCents');
  assertCompetenceMonth(competenceMonth, 'competenceMonth');
  if (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth < 1 || rule.dayOfMonth > 31) {
    throw new Error(`Invalid rule.dayOfMonth: ${rule.dayOfMonth}`);
  }
  if (!isRecurringRuleDueInMonth(rule, competenceMonth)) {
    throw new Error(
      `Recurring rule ${rule.id} is not due in competenceMonth ${competenceMonth}`,
    );
  }

  const [yearStr, monthStr] = competenceMonth.split('-');
  const clampedDay = Math.min(
    rule.dayOfMonth,
    daysInCalendarMonth(Number(yearStr), Number(monthStr)),
  );
  const transactionDate = `${competenceMonth}-${String(clampedDay).padStart(2, '0')}`;

  const id = generateRecurringTransactionId(rule.id, competenceMonth);

  const invoiceId =
    rule.type === 'CREDIT_PURCHASE'
      ? (options.invoiceId ??
        (rule.creditCardId
          ? generateInvoiceId(rule.creditCardId, competenceMonth)
          : null))
      : null;

  const tx: LedgerTransaction = {
    id,
    type: rule.type,
    status: 'PENDING',
    amountCents: rule.amountCents,
    transactionDate,
    competenceMonth,
    description: rule.description,
    accountId: rule.type === 'CREDIT_PURCHASE' ? null : rule.accountId,
    transferAccountId: null,
    creditCardId: rule.type === 'CREDIT_PURCHASE' ? rule.creditCardId : null,
    invoiceId,
    categoryId: rule.categoryId,
    ownerUserId: rule.ownerUserId,
    installmentPlanId: null,
    installmentNumber: null,
    totalInstallments: null,
    recurringRuleId: rule.id,
    refundedTransactionId: null,
    isHouseholdContribution: false,
    deletedAt: null,
  };

  assertTransactionInvariants(tx);
  return tx;
}

/**
 * Applies changes from a `RecurringRuleDefinition` (`amountCents`, `categoryId`, `description`, `ownerUserId`)
 * only to future occurrences (`competenceMonth > currentCompetenceMonth`) or to the current month's
 * occurrence if its `status === 'PENDING'`. Past occurrences and `CLEARED` occurrences remain untouched.
 */
export function applyRecurringRuleUpdateToOccurrences(
  rule: RecurringRuleDefinition,
  currentCompetenceMonth: string,
  existingTransactions: readonly LedgerTransaction[],
): LedgerTransaction[] {
  assertCompetenceMonth(currentCompetenceMonth, 'currentCompetenceMonth');
  assertValidCents(rule.amountCents, 'rule.amountCents');

  return existingTransactions.map((tx) => {
    if (tx.deletedAt !== null || tx.recurringRuleId !== rule.id) {
      return tx;
    }
    if (tx.status === 'CLEARED') {
      return tx;
    }
    if (tx.competenceMonth < currentCompetenceMonth) {
      return tx;
    }

    return {
      ...tx,
      amountCents: rule.amountCents,
      categoryId: rule.categoryId,
      description: rule.description,
      ownerUserId: rule.ownerUserId,
    };
  });
}
