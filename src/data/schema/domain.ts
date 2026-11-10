import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  AccountType,
  FieldHlcMap,
  InvoiceStatus,
  TransactionStatus,
  TransactionType,
} from '@/core';

export type HouseholdMemberRole = 'FOUNDER' | 'PARTNER';
export type CategoryKind = 'INCOME' | 'EXPENSE';
export type RecurringRuleType = 'INCOME' | 'EXPENSE' | 'CREDIT_PURCHASE';
export type RecurringFrequency = 'MONTHLY' | 'YEARLY';

/**
 * 1. Household (`households`)
 */
export const households = sqliteTable('households', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
  syncEpoch: integer('sync_epoch').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * 2. Household Members (`household_members` - max 2 active members per household)
 */
export const householdMembers = sqliteTable(
  'household_members',
  {
    id: text('id').primaryKey().notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role').$type<HouseholdMemberRole>().notNull(),
    colorHex: text('color_hex').notNull(),
    joinedAt: text('joined_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (table) => [
    uniqueIndex('uq_household_members_household_user').on(
      table.householdId,
      table.userId,
    ),
    index('idx_household_members_household_active').on(
      table.householdId,
      table.revokedAt,
    ),
    check(
      'chk_household_members_role',
      sql`${table.role} IN ('FOUNDER', 'PARTNER')`,
    ),
  ],
);

/**
 * 3. Bank Accounts & Wallets (`accounts`)
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey().notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id'), // NULL = Conta Conjunta / Doméstica
    name: text('name').notNull(),
    type: text('type').$type<AccountType>().notNull(),
    initialBalanceCents: integer('initial_balance_cents').notNull().default(0),
    includeInNetWorth: integer('include_in_net_worth', { mode: 'boolean' })
      .notNull()
      .default(true),
    isArchived: integer('is_archived', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    hlcTimestamp: text('hlc_timestamp').notNull(),
    fieldHlc: text('field_hlc', { mode: 'json' })
      .$type<FieldHlcMap>()
      .notNull()
      .default(sql`'{}'`),
    serverSeq: integer('server_seq').notNull().default(0),
  },
  (table) => [
    index('idx_accounts_household_active').on(
      table.householdId,
      table.deletedAt,
      table.isArchived,
    ),
    index('idx_accounts_household_owner').on(
      table.householdId,
      table.ownerUserId,
      table.deletedAt,
    ),
    index('idx_accounts_household_seq').on(table.householdId, table.serverSeq),
    check(
      'chk_accounts_type',
      sql`${table.type} IN ('CHECKING', 'SAVINGS', 'WALLET', 'INVESTMENT')`,
    ),
  ],
);

/**
 * 4. Categories & Subcategories (`categories`)
 */
export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey().notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references(
      (): AnySQLiteColumn => categories.id,
    ),
    name: text('name').notNull(),
    kind: text('kind').$type<CategoryKind>().notNull(),
    colorHex: text('color_hex').notNull(),
    iconName: text('icon_name').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    hlcTimestamp: text('hlc_timestamp').notNull(),
    fieldHlc: text('field_hlc', { mode: 'json' })
      .$type<FieldHlcMap>()
      .notNull()
      .default(sql`'{}'`),
    serverSeq: integer('server_seq').notNull().default(0),
  },
  (table) => [
    index('idx_categories_household_kind_active').on(
      table.householdId,
      table.kind,
      table.deletedAt,
    ),
    index('idx_categories_household_parent').on(
      table.householdId,
      table.parentId,
      table.deletedAt,
    ),
    index('idx_categories_household_seq').on(table.householdId, table.serverSeq),
    check('chk_categories_kind', sql`${table.kind} IN ('INCOME', 'EXPENSE')`),
  ],
);

/**
 * 5. Credit Cards (`credit_cards`)
 */
export const creditCards = sqliteTable(
  'credit_cards',
  {
    id: text('id').primaryKey().notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id'), // NULL = Cartão Compartilhado da Casa
    defaultPaymentAccountId: text('default_payment_account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    limitCents: integer('limit_cents').notNull(),
    closingDay: integer('closing_day').notNull(),
    dueDay: integer('due_day').notNull(),
    isArchived: integer('is_archived', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    hlcTimestamp: text('hlc_timestamp').notNull(),
    fieldHlc: text('field_hlc', { mode: 'json' })
      .$type<FieldHlcMap>()
      .notNull()
      .default(sql`'{}'`),
    serverSeq: integer('server_seq').notNull().default(0),
  },
  (table) => [
    index('idx_credit_cards_household_active').on(
      table.householdId,
      table.deletedAt,
      table.isArchived,
    ),
    index('idx_credit_cards_household_owner').on(
      table.householdId,
      table.ownerUserId,
      table.deletedAt,
    ),
    index('idx_credit_cards_household_seq').on(
      table.householdId,
      table.serverSeq,
    ),
    check('chk_credit_cards_limit_cents', sql`${table.limitCents} >= 0`),
    check(
      'chk_credit_cards_closing_day',
      sql`${table.closingDay} BETWEEN 1 AND 31`,
    ),
    check('chk_credit_cards_due_day', sql`${table.dueDay} BETWEEN 1 AND 31`),
  ],
);

/**
 * 6. Credit Card Invoices (`credit_card_invoices` - immutable cycle competences)
 */
export const creditCardInvoices = sqliteTable(
  'credit_card_invoices',
  {
    id: text('id').primaryKey().notNull(), // UUIDv5(credit_card_id + competence_month)
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    creditCardId: text('credit_card_id')
      .notNull()
      .references(() => creditCards.id),
    competenceMonth: text('competence_month').notNull(), // YYYY-MM
    closingDate: text('closing_date').notNull(), // YYYY-MM-DD
    dueDate: text('due_date').notNull(), // YYYY-MM-DD
    status: text('status').$type<InvoiceStatus>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    hlcTimestamp: text('hlc_timestamp').notNull(),
    fieldHlc: text('field_hlc', { mode: 'json' })
      .$type<FieldHlcMap>()
      .notNull()
      .default(sql`'{}'`),
    serverSeq: integer('server_seq').notNull().default(0),
  },
  (table) => [
    uniqueIndex('uq_invoices_card_competence').on(
      table.creditCardId,
      table.competenceMonth,
    ),
    index('idx_invoices_household_card_status').on(
      table.householdId,
      table.creditCardId,
      table.status,
      table.deletedAt,
    ),
    index('idx_invoices_household_competence').on(
      table.householdId,
      table.competenceMonth,
      table.deletedAt,
    ),
    index('idx_invoices_household_seq').on(table.householdId, table.serverSeq),
    check(
      'chk_invoices_competence_month',
      sql`${table.competenceMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`,
    ),
    check(
      'chk_invoices_status',
      sql`${table.status} IN ('OPEN', 'CLOSED', 'PAID')`,
    ),
  ],
);

/**
 * 7. Installment Plans (`installment_plans` - non-computable header for traceability)
 */
export const installmentPlans = sqliteTable(
  'installment_plans',
  {
    id: text('id').primaryKey().notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    createdByUserId: text('created_by_user_id').notNull(),
    ownerUserId: text('owner_user_id'),
    creditCardId: text('credit_card_id').references(() => creditCards.id),
    accountId: text('account_id').references(() => accounts.id),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    description: text('description').notNull(),
    totalAmountCents: integer('total_amount_cents').notNull(),
    totalInstallments: integer('total_installments').notNull(),
    purchaseDate: text('purchase_date').notNull(), // YYYY-MM-DD
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    hlcTimestamp: text('hlc_timestamp').notNull(),
    fieldHlc: text('field_hlc', { mode: 'json' })
      .$type<FieldHlcMap>()
      .notNull()
      .default(sql`'{}'`),
    serverSeq: integer('server_seq').notNull().default(0),
  },
  (table) => [
    index('idx_installment_plans_household_active').on(
      table.householdId,
      table.deletedAt,
    ),
    index('idx_installment_plans_household_seq').on(
      table.householdId,
      table.serverSeq,
    ),
    check(
      'chk_installment_plans_total_amount_cents',
      sql`${table.totalAmountCents} > 0`,
    ),
    check(
      'chk_installment_plans_total_installments',
      sql`${table.totalInstallments} >= 2`,
    ),
    check(
      'chk_installment_plans_target',
      sql`(${table.creditCardId} IS NOT NULL AND ${table.accountId} IS NULL) OR (${table.creditCardId} IS NULL AND ${table.accountId} IS NOT NULL)`,
    ),
  ],
);

/**
 * 8. Recurring Rules (`recurring_rules` - subscriptions, salaries, fixed bills)
 */
export const recurringRules = sqliteTable(
  'recurring_rules',
  {
    id: text('id').primaryKey().notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    createdByUserId: text('created_by_user_id').notNull(),
    ownerUserId: text('owner_user_id'),
    type: text('type').$type<RecurringRuleType>().notNull(),
    accountId: text('account_id').references(() => accounts.id),
    creditCardId: text('credit_card_id').references(() => creditCards.id),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    description: text('description').notNull(),
    amountCents: integer('amount_cents').notNull(),
    frequency: text('frequency').$type<RecurringFrequency>().notNull(),
    dayOfMonth: integer('day_of_month').notNull(),
    startMonth: text('start_month').notNull(), // YYYY-MM
    endMonth: text('end_month'), // YYYY-MM
    isActive: integer('is_active', { mode: 'boolean' })
      .notNull()
      .default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    hlcTimestamp: text('hlc_timestamp').notNull(),
    fieldHlc: text('field_hlc', { mode: 'json' })
      .$type<FieldHlcMap>()
      .notNull()
      .default(sql`'{}'`),
    serverSeq: integer('server_seq').notNull().default(0),
  },
  (table) => [
    index('idx_recurring_rules_household_active').on(
      table.householdId,
      table.isActive,
      table.deletedAt,
    ),
    index('idx_recurring_rules_household_seq').on(
      table.householdId,
      table.serverSeq,
    ),
    check(
      'chk_recurring_rules_type',
      sql`${table.type} IN ('INCOME', 'EXPENSE', 'CREDIT_PURCHASE')`,
    ),
    check('chk_recurring_rules_amount_cents', sql`${table.amountCents} > 0`),
    check(
      'chk_recurring_rules_frequency',
      sql`${table.frequency} IN ('MONTHLY', 'YEARLY')`,
    ),
    check(
      'chk_recurring_rules_day_of_month',
      sql`${table.dayOfMonth} BETWEEN 1 AND 31`,
    ),
    check(
      'chk_recurring_rules_start_month',
      sql`${table.startMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`,
    ),
    check(
      'chk_recurring_rules_end_month',
      sql`${table.endMonth} IS NULL OR ${table.endMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`,
    ),
    check(
      'chk_recurring_rules_target',
      sql`(${table.type} = 'CREDIT_PURCHASE' AND ${table.creditCardId} IS NOT NULL AND ${table.accountId} IS NULL) OR (${table.type} IN ('INCOME', 'EXPENSE') AND ${table.accountId} IS NOT NULL AND ${table.creditCardId} IS NULL)`,
    ),
  ],
);

/**
 * 9. Transactions Ledger (`transactions`)
 */
export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey().notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    createdByUserId: text('created_by_user_id').notNull(),
    ownerUserId: text('owner_user_id'), // NULL = Doméstico/Casal
    type: text('type').$type<TransactionType>().notNull(),
    status: text('status')
      .$type<TransactionStatus>()
      .notNull()
      .default('CLEARED'),
    amountCents: integer('amount_cents').notNull(),
    transactionDate: text('transaction_date').notNull(), // YYYY-MM-DD
    competenceMonth: text('competence_month').notNull(), // YYYY-MM
    description: text('description').notNull(),
    notes: text('notes'),
    accountId: text('account_id').references(() => accounts.id),
    transferAccountId: text('transfer_account_id').references(
      () => accounts.id,
    ),
    creditCardId: text('credit_card_id').references(() => creditCards.id),
    invoiceId: text('invoice_id').references(() => creditCardInvoices.id),
    categoryId: text('category_id').references(() => categories.id),
    installmentPlanId: text('installment_plan_id').references(
      () => installmentPlans.id,
    ),
    installmentNumber: integer('installment_number'),
    totalInstallments: integer('total_installments'),
    recurringRuleId: text('recurring_rule_id').references(
      () => recurringRules.id,
    ),
    refundedTransactionId: text('refunded_transaction_id').references(
      (): AnySQLiteColumn => transactions.id,
    ),
    isHouseholdContribution: integer('is_household_contribution', {
      mode: 'boolean',
    })
      .notNull()
      .default(false),
    calendarEventId: text('calendar_event_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    hlcTimestamp: text('hlc_timestamp').notNull(),
    fieldHlc: text('field_hlc', { mode: 'json' })
      .$type<FieldHlcMap>()
      .notNull()
      .default(sql`'{}'`),
    serverSeq: integer('server_seq').notNull().default(0),
  },
  (table) => [
    index('idx_transactions_household_seq').on(
      table.householdId,
      table.serverSeq,
    ),
    index('idx_transactions_account_active').on(
      table.householdId,
      table.accountId,
      table.status,
      table.deletedAt,
    ),
    index('idx_transactions_transfer_active').on(
      table.householdId,
      table.transferAccountId,
      table.status,
      table.deletedAt,
    ),
    index('idx_transactions_invoice_active').on(
      table.householdId,
      table.invoiceId,
      table.deletedAt,
    ),
    index('idx_transactions_competence_active').on(
      table.householdId,
      table.competenceMonth,
      table.ownerUserId,
      table.deletedAt,
    ),
    index('idx_transactions_installment_plan').on(
      table.householdId,
      table.installmentPlanId,
      table.deletedAt,
    ),
    index('idx_transactions_recurring_rule').on(
      table.householdId,
      table.recurringRuleId,
      table.competenceMonth,
    ),
    check(
      'chk_transactions_type',
      sql`${table.type} IN ('INCOME', 'EXPENSE', 'TRANSFER', 'CREDIT_PURCHASE', 'CREDIT_REFUND', 'DEBIT_REFUND', 'INVOICE_PAYMENT')`,
    ),
    check(
      'chk_transactions_status',
      sql`${table.status} IN ('PENDING', 'CLEARED')`,
    ),
    check('chk_transactions_amount_cents', sql`${table.amountCents} > 0`),
    check(
      'chk_transactions_competence_month',
      sql`${table.competenceMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`,
    ),
    check(
      'chk_accounting_invariants',
      sql`(
        (${table.type} IN ('INCOME', 'EXPENSE', 'DEBIT_REFUND') AND ${table.accountId} IS NOT NULL AND ${table.transferAccountId} IS NULL AND ${table.creditCardId} IS NULL AND ${table.invoiceId} IS NULL AND ${table.categoryId} IS NOT NULL)
        OR
        (${table.type} = 'TRANSFER' AND ${table.accountId} IS NOT NULL AND ${table.transferAccountId} IS NOT NULL AND ${table.accountId} <> ${table.transferAccountId} AND ${table.creditCardId} IS NULL AND ${table.invoiceId} IS NULL AND ${table.categoryId} IS NULL)
        OR
        (${table.type} IN ('CREDIT_PURCHASE', 'CREDIT_REFUND') AND ${table.accountId} IS NULL AND ${table.transferAccountId} IS NULL AND ${table.creditCardId} IS NOT NULL AND ${table.invoiceId} IS NOT NULL AND ${table.categoryId} IS NOT NULL)
        OR
        (${table.type} = 'INVOICE_PAYMENT' AND ${table.accountId} IS NOT NULL AND ${table.transferAccountId} IS NULL AND ${table.creditCardId} IS NOT NULL AND ${table.invoiceId} IS NOT NULL AND ${table.categoryId} IS NULL)
      )`,
    ),
  ],
);

/**
 * 10. Monthly Budgets (`budgets`)
 */
export const budgets = sqliteTable(
  'budgets',
  {
    id: text('id').primaryKey().notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id'), // NULL = Orçamento Conjunto da Casa
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    competenceMonth: text('competence_month').notNull(), // YYYY-MM
    limitCents: integer('limit_cents').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    hlcTimestamp: text('hlc_timestamp').notNull(),
    fieldHlc: text('field_hlc', { mode: 'json' })
      .$type<FieldHlcMap>()
      .notNull()
      .default(sql`'{}'`),
    serverSeq: integer('server_seq').notNull().default(0),
  },
  (table) => [
    index('idx_budgets_household_competence').on(
      table.householdId,
      table.competenceMonth,
      table.ownerUserId,
      table.deletedAt,
    ),
    index('idx_budgets_household_category').on(
      table.householdId,
      table.categoryId,
      table.competenceMonth,
      table.deletedAt,
    ),
    index('idx_budgets_household_seq').on(table.householdId, table.serverSeq),
    check(
      'chk_budgets_competence_month',
      sql`${table.competenceMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`,
    ),
    check('chk_budgets_limit_cents', sql`${table.limitCents} > 0`),
  ],
);

export type HouseholdRow = typeof households.$inferSelect;
export type NewHouseholdRow = typeof households.$inferInsert;
export type HouseholdMemberRow = typeof householdMembers.$inferSelect;
export type NewHouseholdMemberRow = typeof householdMembers.$inferInsert;
export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
export type CategoryRow = typeof categories.$inferSelect;
export type NewCategoryRow = typeof categories.$inferInsert;
export type CreditCardRow = typeof creditCards.$inferSelect;
export type NewCreditCardRow = typeof creditCards.$inferInsert;
export type CreditCardInvoiceRow = typeof creditCardInvoices.$inferSelect;
export type NewCreditCardInvoiceRow = typeof creditCardInvoices.$inferInsert;
export type InstallmentPlanRow = typeof installmentPlans.$inferSelect;
export type NewInstallmentPlanRow = typeof installmentPlans.$inferInsert;
export type RecurringRuleRow = typeof recurringRules.$inferSelect;
export type NewRecurringRuleRow = typeof recurringRules.$inferInsert;
export type TransactionRow = typeof transactions.$inferSelect;
export type NewTransactionRow = typeof transactions.$inferInsert;
export type BudgetRow = typeof budgets.$inferSelect;
export type NewBudgetRow = typeof budgets.$inferInsert;
