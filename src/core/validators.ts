import { z } from 'zod';
import { isValidHlc } from './hlc';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPETENCE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const UuidSchema = z
  .string()
  .regex(UUID_PATTERN, 'Invalid UUID format');

export const CompetenceMonthSchema = z
  .string()
  .regex(COMPETENCE_MONTH_PATTERN, 'Expected competence month in YYYY-MM format');

export const IsoDateSchema = z
  .string()
  .regex(ISO_DATE_PATTERN, 'Expected ISO date in YYYY-MM-DD format');

export const PositiveCentsSchema = z
  .number()
  .int('Monetary amount must be an integer in cents')
  .positive('Monetary amount in cents must be > 0')
  .refine((val) => Number.isSafeInteger(val), {
    message: 'Monetary amount must be a safe integer',
  });

export const NonNegativeCentsSchema = z
  .number()
  .int('Monetary amount must be an integer in cents')
  .min(0, 'Monetary amount in cents must be >= 0')
  .refine((val) => Number.isSafeInteger(val), {
    message: 'Monetary amount must be a safe integer',
  });

export const SafeIntegerCentsSchema = z
  .number()
  .int('Monetary amount must be an integer in cents')
  .refine((val) => Number.isSafeInteger(val), {
    message: 'Monetary amount must be a safe integer',
  });

export const HlcStringSchema = z
  .string()
  .refine((val) => isValidHlc(val), {
    message: 'Invalid canonical 42-character HLC string',
  });

export const TransactionTypeSchema = z.enum([
  'INCOME',
  'EXPENSE',
  'TRANSFER',
  'CREDIT_PURCHASE',
  'CREDIT_REFUND',
  'DEBIT_REFUND',
  'INVOICE_PAYMENT',
]);

export const TransactionStatusSchema = z.enum(['PENDING', 'CLEARED']);

export const AccountTypeSchema = z.enum([
  'CHECKING',
  'SAVINGS',
  'WALLET',
  'INVESTMENT',
]);

export const CategoryKindSchema = z.enum(['INCOME', 'EXPENSE']);

export const InvoiceStatusSchema = z.enum(['OPEN', 'CLOSED', 'PAID']);

export const RecurringRuleTypeSchema = z.enum([
  'INCOME',
  'EXPENSE',
  'CREDIT_PURCHASE',
]);

export const RecurringFrequencySchema = z.enum(['MONTHLY', 'YEARLY']);

export const AccountInputSchema = z.object({
  id: UuidSchema,
  householdId: UuidSchema,
  ownerUserId: UuidSchema.nullable(),
  name: z.string().trim().min(1, 'Account name is required').max(120),
  type: AccountTypeSchema,
  initialBalanceCents: SafeIntegerCentsSchema.default(0),
  includeInNetWorth: z.boolean().default(true),
  isArchived: z.boolean().default(false),
});

export const CategoryInputSchema = z.object({
  id: UuidSchema,
  householdId: UuidSchema,
  parentId: UuidSchema.nullable().default(null),
  name: z.string().trim().min(1, 'Category name is required').max(100),
  kind: CategoryKindSchema,
  colorHex: z.string().regex(HEX_COLOR_PATTERN, 'Expected hex color (#RRGGBB)'),
  iconName: z.string().trim().min(1, 'Icon name is required').max(80),
});

export const CreditCardInputSchema = z.object({
  id: UuidSchema,
  householdId: UuidSchema,
  ownerUserId: UuidSchema.nullable(),
  defaultPaymentAccountId: UuidSchema,
  name: z.string().trim().min(1, 'Credit card name is required').max(120),
  limitCents: NonNegativeCentsSchema,
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  isArchived: z.boolean().default(false),
});

export const CreditCardInvoiceInputSchema = z.object({
  id: UuidSchema,
  householdId: UuidSchema,
  creditCardId: UuidSchema,
  competenceMonth: CompetenceMonthSchema,
  closingDate: IsoDateSchema,
  dueDate: IsoDateSchema,
  status: InvoiceStatusSchema,
});

export const InstallmentPlanInputSchema = z
  .object({
    id: UuidSchema,
    householdId: UuidSchema,
    createdByUserId: UuidSchema,
    ownerUserId: UuidSchema.nullable(),
    creditCardId: UuidSchema.nullable(),
    accountId: UuidSchema.nullable(),
    categoryId: UuidSchema,
    description: z.string().trim().min(1, 'Description is required').max(240),
    totalAmountCents: PositiveCentsSchema,
    totalInstallments: z.number().int().min(2).max(240),
    purchaseDate: IsoDateSchema,
  })
  .superRefine((plan, ctx) => {
    const hasCard = plan.creditCardId !== null;
    const hasAccount = plan.accountId !== null;
    if (hasCard === hasAccount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Installment plan must reference either creditCardId OR accountId (mutually exclusive)',
        path: ['creditCardId'],
      });
    }
  });

export const RecurringRuleInputSchema = z
  .object({
    id: UuidSchema,
    householdId: UuidSchema,
    createdByUserId: UuidSchema,
    ownerUserId: UuidSchema.nullable(),
    type: RecurringRuleTypeSchema,
    accountId: UuidSchema.nullable(),
    creditCardId: UuidSchema.nullable(),
    categoryId: UuidSchema,
    description: z.string().trim().min(1, 'Description is required').max(240),
    amountCents: PositiveCentsSchema,
    frequency: RecurringFrequencySchema,
    dayOfMonth: z.number().int().min(1).max(31),
    startMonth: CompetenceMonthSchema,
    endMonth: CompetenceMonthSchema.nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((rule, ctx) => {
    if (rule.type === 'CREDIT_PURCHASE') {
      if (rule.creditCardId === null || rule.accountId !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'CREDIT_PURCHASE recurring rule requires creditCardId != null and accountId == null',
          path: ['creditCardId'],
        });
      }
    } else if (rule.accountId === null || rule.creditCardId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${rule.type} recurring rule requires accountId != null and creditCardId == null`,
        path: ['accountId'],
      });
    }

    if (rule.endMonth !== null && rule.endMonth < rule.startMonth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endMonth must be greater than or equal to startMonth',
        path: ['endMonth'],
      });
    }
  });

export const TransactionInputSchema = z
  .object({
    id: UuidSchema,
    householdId: UuidSchema,
    createdByUserId: UuidSchema,
    ownerUserId: UuidSchema.nullable(),
    type: TransactionTypeSchema,
    status: TransactionStatusSchema.default('CLEARED'),
    amountCents: PositiveCentsSchema,
    transactionDate: IsoDateSchema,
    competenceMonth: CompetenceMonthSchema,
    description: z.string().trim().min(1, 'Description is required').max(240),
    notes: z.string().max(1000).nullable().default(null),
    accountId: UuidSchema.nullable().default(null),
    transferAccountId: UuidSchema.nullable().default(null),
    creditCardId: UuidSchema.nullable().default(null),
    invoiceId: UuidSchema.nullable().default(null),
    categoryId: UuidSchema.nullable().default(null),
    installmentPlanId: UuidSchema.nullable().default(null),
    installmentNumber: z.number().int().min(1).max(240).nullable().default(null),
    totalInstallments: z.number().int().min(2).max(240).nullable().default(null),
    recurringRuleId: UuidSchema.nullable().default(null),
    refundedTransactionId: UuidSchema.nullable().default(null),
    isHouseholdContribution: z.boolean().default(false),
    calendarEventId: z.string().nullable().default(null),
  })
  .superRefine((tx, ctx) => {
    // Enforce chk_accounting_invariants (AGENTS.md §4.2)
    switch (tx.type) {
      case 'INCOME':
      case 'EXPENSE':
      case 'DEBIT_REFUND': {
        if (
          tx.accountId === null ||
          tx.transferAccountId !== null ||
          tx.creditCardId !== null ||
          tx.invoiceId !== null ||
          tx.categoryId === null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `chk_accounting_invariants violated for ${tx.type}: requires accountId != null, transferAccountId == null, creditCardId == null, invoiceId == null, categoryId != null`,
            path: ['type'],
          });
        }
        break;
      }

      case 'TRANSFER': {
        if (
          tx.accountId === null ||
          tx.transferAccountId === null ||
          tx.accountId === tx.transferAccountId ||
          tx.creditCardId !== null ||
          tx.invoiceId !== null ||
          tx.categoryId !== null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'chk_accounting_invariants violated for TRANSFER: requires accountId != null, transferAccountId != null (<> accountId), creditCardId == null, invoiceId == null, categoryId == null',
            path: ['type'],
          });
        }
        break;
      }

      case 'CREDIT_PURCHASE':
      case 'CREDIT_REFUND': {
        if (
          tx.accountId !== null ||
          tx.transferAccountId !== null ||
          tx.creditCardId === null ||
          tx.invoiceId === null ||
          tx.categoryId === null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `chk_accounting_invariants violated for ${tx.type}: requires accountId == null, transferAccountId == null, creditCardId != null, invoiceId != null, categoryId != null`,
            path: ['type'],
          });
        }
        break;
      }

      case 'INVOICE_PAYMENT': {
        if (
          tx.accountId === null ||
          tx.transferAccountId !== null ||
          tx.creditCardId === null ||
          tx.invoiceId === null ||
          tx.categoryId !== null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'chk_accounting_invariants violated for INVOICE_PAYMENT: requires accountId != null, transferAccountId == null, creditCardId != null, invoiceId != null, categoryId == null',
            path: ['type'],
          });
        }
        break;
      }
    }

    if (tx.installmentPlanId !== null) {
      if (tx.installmentNumber === null || tx.totalInstallments === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'installmentNumber and totalInstallments are required when installmentPlanId is set',
          path: ['installmentNumber'],
        });
      } else if (tx.installmentNumber > tx.totalInstallments) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'installmentNumber cannot exceed totalInstallments',
          path: ['installmentNumber'],
        });
      }
    }
  });

export const BudgetInputSchema = z.object({
  id: UuidSchema,
  householdId: UuidSchema,
  ownerUserId: UuidSchema.nullable(),
  categoryId: UuidSchema,
  competenceMonth: CompetenceMonthSchema,
  limitCents: PositiveCentsSchema,
});

export type AccountInput = z.infer<typeof AccountInputSchema>;
export type CategoryInput = z.infer<typeof CategoryInputSchema>;
export type CreditCardInput = z.infer<typeof CreditCardInputSchema>;
export type CreditCardInvoiceInput = z.infer<typeof CreditCardInvoiceInputSchema>;
export type InstallmentPlanInput = z.infer<typeof InstallmentPlanInputSchema>;
export type RecurringRuleInput = z.infer<typeof RecurringRuleInputSchema>;
export type TransactionInput = z.infer<typeof TransactionInputSchema>;
export type BudgetInput = z.infer<typeof BudgetInputSchema>;
