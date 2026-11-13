import type * as SQLite from 'expo-sqlite';

export const LOCAL_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS \`households\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`name\` text NOT NULL,
	\`sync_epoch\` integer DEFAULT 1 NOT NULL,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL
);

CREATE TABLE IF NOT EXISTS \`household_members\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`household_id\` text NOT NULL,
	\`user_id\` text NOT NULL,
	\`display_name\` text NOT NULL,
	\`role\` text NOT NULL,
	\`color_hex\` text NOT NULL,
	\`joined_at\` text NOT NULL,
	\`revoked_at\` text,
	FOREIGN KEY (\`household_id\`) REFERENCES \`households\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_household_members_role" CHECK("household_members"."role" IN ('FOUNDER', 'PARTNER'))
);
CREATE UNIQUE INDEX IF NOT EXISTS \`uq_household_members_household_user\` ON \`household_members\` (\`household_id\`,\`user_id\`);
CREATE INDEX IF NOT EXISTS \`idx_household_members_household_active\` ON \`household_members\` (\`household_id\`,\`revoked_at\`);

CREATE TABLE IF NOT EXISTS \`accounts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`household_id\` text NOT NULL,
	\`owner_user_id\` text,
	\`name\` text NOT NULL,
	\`type\` text NOT NULL,
	\`initial_balance_cents\` integer DEFAULT 0 NOT NULL,
	\`include_in_net_worth\` integer DEFAULT 1 NOT NULL,
	\`is_archived\` integer DEFAULT 0 NOT NULL,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	\`deleted_at\` text,
	\`hlc_timestamp\` text NOT NULL,
	\`field_hlc\` text DEFAULT '{}' NOT NULL,
	\`server_seq\` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (\`household_id\`) REFERENCES \`households\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_accounts_type" CHECK("accounts"."type" IN ('CHECKING', 'SAVINGS', 'WALLET', 'INVESTMENT'))
);
CREATE INDEX IF NOT EXISTS \`idx_accounts_household_active\` ON \`accounts\` (\`household_id\`,\`deleted_at\`,\`is_archived\`);
CREATE INDEX IF NOT EXISTS \`idx_accounts_household_owner\` ON \`accounts\` (\`household_id\`,\`owner_user_id\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_accounts_household_seq\` ON \`accounts\` (\`household_id\`,\`server_seq\`);

CREATE TABLE IF NOT EXISTS \`categories\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`household_id\` text NOT NULL,
	\`parent_id\` text,
	\`name\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`color_hex\` text NOT NULL,
	\`icon_name\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	\`deleted_at\` text,
	\`hlc_timestamp\` text NOT NULL,
	\`field_hlc\` text DEFAULT '{}' NOT NULL,
	\`server_seq\` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (\`household_id\`) REFERENCES \`households\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`parent_id\`) REFERENCES \`categories\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_categories_kind" CHECK("categories"."kind" IN ('INCOME', 'EXPENSE'))
);
CREATE INDEX IF NOT EXISTS \`idx_categories_household_kind_active\` ON \`categories\` (\`household_id\`,\`kind\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_categories_household_parent\` ON \`categories\` (\`household_id\`,\`parent_id\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_categories_household_seq\` ON \`categories\` (\`household_id\`,\`server_seq\`);

CREATE TABLE IF NOT EXISTS \`credit_cards\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`household_id\` text NOT NULL,
	\`owner_user_id\` text,
	\`default_payment_account_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`limit_cents\` integer NOT NULL,
	\`closing_day\` integer NOT NULL,
	\`due_day\` integer NOT NULL,
	\`is_archived\` integer DEFAULT 0 NOT NULL,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	\`deleted_at\` text,
	\`hlc_timestamp\` text NOT NULL,
	\`field_hlc\` text DEFAULT '{}' NOT NULL,
	\`server_seq\` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (\`household_id\`) REFERENCES \`households\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`default_payment_account_id\`) REFERENCES \`accounts\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_credit_cards_limit_cents" CHECK("credit_cards"."limit_cents" >= 0),
	CONSTRAINT "chk_credit_cards_closing_day" CHECK("credit_cards"."closing_day" BETWEEN 1 AND 31),
	CONSTRAINT "chk_credit_cards_due_day" CHECK("credit_cards"."due_day" BETWEEN 1 AND 31)
);
CREATE INDEX IF NOT EXISTS \`idx_credit_cards_household_active\` ON \`credit_cards\` (\`household_id\`,\`deleted_at\`,\`is_archived\`);
CREATE INDEX IF NOT EXISTS \`idx_credit_cards_household_owner\` ON \`credit_cards\` (\`household_id\`,\`owner_user_id\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_credit_cards_household_seq\` ON \`credit_cards\` (\`household_id\`,\`server_seq\`);

CREATE TABLE IF NOT EXISTS \`credit_card_invoices\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`household_id\` text NOT NULL,
	\`credit_card_id\` text NOT NULL,
	\`competence_month\` text NOT NULL,
	\`closing_date\` text NOT NULL,
	\`due_date\` text NOT NULL,
	\`status\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	\`deleted_at\` text,
	\`hlc_timestamp\` text NOT NULL,
	\`field_hlc\` text DEFAULT '{}' NOT NULL,
	\`server_seq\` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (\`household_id\`) REFERENCES \`households\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`credit_card_id\`) REFERENCES \`credit_cards\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_invoices_competence_month" CHECK("credit_card_invoices"."competence_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "chk_invoices_status" CHECK("credit_card_invoices"."status" IN ('OPEN', 'CLOSED', 'PAID'))
);
CREATE UNIQUE INDEX IF NOT EXISTS \`uq_invoices_card_competence\` ON \`credit_card_invoices\` (\`credit_card_id\`,\`competence_month\`);
CREATE INDEX IF NOT EXISTS \`idx_invoices_household_card_status\` ON \`credit_card_invoices\` (\`household_id\`,\`credit_card_id\`,\`status\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_invoices_household_competence\` ON \`credit_card_invoices\` (\`household_id\`,\`competence_month\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_invoices_household_seq\` ON \`credit_card_invoices\` (\`household_id\`,\`server_seq\`);

CREATE TABLE IF NOT EXISTS \`installment_plans\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`household_id\` text NOT NULL,
	\`created_by_user_id\` text NOT NULL,
	\`owner_user_id\` text,
	\`credit_card_id\` text,
	\`account_id\` text,
	\`category_id\` text NOT NULL,
	\`description\` text NOT NULL,
	\`total_amount_cents\` integer NOT NULL,
	\`total_installments\` integer NOT NULL,
	\`purchase_date\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	\`deleted_at\` text,
	\`hlc_timestamp\` text NOT NULL,
	\`field_hlc\` text DEFAULT '{}' NOT NULL,
	\`server_seq\` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (\`household_id\`) REFERENCES \`households\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`credit_card_id\`) REFERENCES \`credit_cards\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`category_id\`) REFERENCES \`categories\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_installment_plans_total_amount_cents" CHECK("installment_plans"."total_amount_cents" > 0),
	CONSTRAINT "chk_installment_plans_total_installments" CHECK("installment_plans"."total_installments" >= 2),
	CONSTRAINT "chk_installment_plans_target" CHECK(("installment_plans"."credit_card_id" IS NOT NULL AND "installment_plans"."account_id" IS NULL) OR ("installment_plans"."credit_card_id" IS NULL AND "installment_plans"."account_id" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS \`idx_installment_plans_household_active\` ON \`installment_plans\` (\`household_id\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_installment_plans_household_seq\` ON \`installment_plans\` (\`household_id\`,\`server_seq\`);

CREATE TABLE IF NOT EXISTS \`recurring_rules\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`household_id\` text NOT NULL,
	\`created_by_user_id\` text NOT NULL,
	\`owner_user_id\` text,
	\`type\` text NOT NULL,
	\`account_id\` text,
	\`credit_card_id\` text,
	\`category_id\` text NOT NULL,
	\`description\` text NOT NULL,
	\`amount_cents\` integer NOT NULL,
	\`frequency\` text NOT NULL,
	\`day_of_month\` integer NOT NULL,
	\`start_month\` text NOT NULL,
	\`end_month\` text,
	\`is_active\` integer DEFAULT 1 NOT NULL,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	\`deleted_at\` text,
	\`hlc_timestamp\` text NOT NULL,
	\`field_hlc\` text DEFAULT '{}' NOT NULL,
	\`server_seq\` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (\`household_id\`) REFERENCES \`households\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`credit_card_id\`) REFERENCES \`credit_cards\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`category_id\`) REFERENCES \`categories\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_recurring_rules_type" CHECK("recurring_rules"."type" IN ('INCOME', 'EXPENSE', 'CREDIT_PURCHASE')),
	CONSTRAINT "chk_recurring_rules_amount_cents" CHECK("recurring_rules"."amount_cents" > 0),
	CONSTRAINT "chk_recurring_rules_frequency" CHECK("recurring_rules"."frequency" IN ('MONTHLY', 'YEARLY')),
	CONSTRAINT "chk_recurring_rules_day_of_month" CHECK("recurring_rules"."day_of_month" BETWEEN 1 AND 31),
	CONSTRAINT "chk_recurring_rules_start_month" CHECK("recurring_rules"."start_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "chk_recurring_rules_end_month" CHECK("recurring_rules"."end_month" IS NULL OR "recurring_rules"."end_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "chk_recurring_rules_target" CHECK(("recurring_rules"."type" = 'CREDIT_PURCHASE' AND "recurring_rules"."credit_card_id" IS NOT NULL AND "recurring_rules"."account_id" IS NULL) OR ("recurring_rules"."type" IN ('INCOME', 'EXPENSE') AND "recurring_rules"."account_id" IS NOT NULL AND "recurring_rules"."credit_card_id" IS NULL))
);
CREATE INDEX IF NOT EXISTS \`idx_recurring_rules_household_active\` ON \`recurring_rules\` (\`household_id\`,\`is_active\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_recurring_rules_household_seq\` ON \`recurring_rules\` (\`household_id\`,\`server_seq\`);

CREATE TABLE IF NOT EXISTS \`transactions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`household_id\` text NOT NULL,
	\`created_by_user_id\` text NOT NULL,
	\`owner_user_id\` text,
	\`type\` text NOT NULL,
	\`status\` text DEFAULT 'CLEARED' NOT NULL,
	\`amount_cents\` integer NOT NULL,
	\`transaction_date\` text NOT NULL,
	\`competence_month\` text NOT NULL,
	\`description\` text NOT NULL,
	\`notes\` text,
	\`account_id\` text,
	\`transfer_account_id\` text,
	\`credit_card_id\` text,
	\`invoice_id\` text,
	\`category_id\` text,
	\`installment_plan_id\` text,
	\`installment_number\` integer,
	\`total_installments\` integer,
	\`recurring_rule_id\` text,
	\`refunded_transaction_id\` text,
	\`is_household_contribution\` integer DEFAULT 0 NOT NULL,
	\`calendar_event_id\` text,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	\`deleted_at\` text,
	\`hlc_timestamp\` text NOT NULL,
	\`field_hlc\` text DEFAULT '{}' NOT NULL,
	\`server_seq\` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (\`household_id\`) REFERENCES \`households\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`transfer_account_id\`) REFERENCES \`accounts\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`credit_card_id\`) REFERENCES \`credit_cards\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`invoice_id\`) REFERENCES \`credit_card_invoices\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`category_id\`) REFERENCES \`categories\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`installment_plan_id\`) REFERENCES \`installment_plans\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`recurring_rule_id\`) REFERENCES \`recurring_rules\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`refunded_transaction_id\`) REFERENCES \`transactions\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_transactions_type" CHECK("transactions"."type" IN ('INCOME', 'EXPENSE', 'TRANSFER', 'CREDIT_PURCHASE', 'CREDIT_REFUND', 'DEBIT_REFUND', 'INVOICE_PAYMENT')),
	CONSTRAINT "chk_transactions_status" CHECK("transactions"."status" IN ('PENDING', 'CLEARED')),
	CONSTRAINT "chk_transactions_amount_cents" CHECK("transactions"."amount_cents" > 0),
	CONSTRAINT "chk_transactions_competence_month" CHECK("transactions"."competence_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "chk_accounting_invariants" CHECK((
        ("transactions"."type" IN ('INCOME', 'EXPENSE', 'DEBIT_REFUND') AND "transactions"."account_id" IS NOT NULL AND "transactions"."transfer_account_id" IS NULL AND "transactions"."credit_card_id" IS NULL AND "transactions"."invoice_id" IS NULL AND "transactions"."category_id" IS NOT NULL)
        OR
        ("transactions"."type" = 'TRANSFER' AND "transactions"."account_id" IS NOT NULL AND "transactions"."transfer_account_id" IS NOT NULL AND "transactions"."account_id" <> "transactions"."transfer_account_id" AND "transactions"."credit_card_id" IS NULL AND "transactions"."invoice_id" IS NULL AND "transactions"."category_id" IS NULL)
        OR
        ("transactions"."type" IN ('CREDIT_PURCHASE', 'CREDIT_REFUND') AND "transactions"."account_id" IS NULL AND "transactions"."transfer_account_id" IS NULL AND "transactions"."credit_card_id" IS NOT NULL AND "transactions"."invoice_id" IS NOT NULL AND "transactions"."category_id" IS NOT NULL)
        OR
        ("transactions"."type" = 'INVOICE_PAYMENT' AND "transactions"."account_id" IS NOT NULL AND "transactions"."transfer_account_id" IS NULL AND "transactions"."credit_card_id" IS NOT NULL AND "transactions"."invoice_id" IS NOT NULL AND "transactions"."category_id" IS NULL)
      ))
);
CREATE INDEX IF NOT EXISTS \`idx_transactions_household_seq\` ON \`transactions\` (\`household_id\`,\`server_seq\`);
CREATE INDEX IF NOT EXISTS \`idx_transactions_account_active\` ON \`transactions\` (\`household_id\`,\`account_id\`,\`status\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_transactions_transfer_active\` ON \`transactions\` (\`household_id\`,\`transfer_account_id\`,\`status\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_transactions_invoice_active\` ON \`transactions\` (\`household_id\`,\`invoice_id\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_transactions_competence_active\` ON \`transactions\` (\`household_id\`,\`competence_month\`,\`owner_user_id\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_transactions_installment_plan\` ON \`transactions\` (\`household_id\`,\`installment_plan_id\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_transactions_recurring_rule\` ON \`transactions\` (\`household_id\`,\`recurring_rule_id\`,\`competence_month\`);

CREATE TABLE IF NOT EXISTS \`budgets\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`household_id\` text NOT NULL,
	\`owner_user_id\` text,
	\`category_id\` text NOT NULL,
	\`competence_month\` text NOT NULL,
	\`limit_cents\` integer NOT NULL,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	\`deleted_at\` text,
	\`hlc_timestamp\` text NOT NULL,
	\`field_hlc\` text DEFAULT '{}' NOT NULL,
	\`server_seq\` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (\`household_id\`) REFERENCES \`households\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`category_id\`) REFERENCES \`categories\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_budgets_competence_month" CHECK("budgets"."competence_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "chk_budgets_limit_cents" CHECK("budgets"."limit_cents" > 0)
);
CREATE INDEX IF NOT EXISTS \`idx_budgets_household_competence\` ON \`budgets\` (\`household_id\`,\`competence_month\`,\`owner_user_id\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_budgets_household_category\` ON \`budgets\` (\`household_id\`,\`category_id\`,\`competence_month\`,\`deleted_at\`);
CREATE INDEX IF NOT EXISTS \`idx_budgets_household_seq\` ON \`budgets\` (\`household_id\`,\`server_seq\`);

CREATE TABLE IF NOT EXISTS \`sync_meta\` (
	\`key\` text PRIMARY KEY NOT NULL,
	\`value\` text NOT NULL
);

CREATE TABLE IF NOT EXISTS \`sync_outbox\` (
	\`seq_id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`mutation_id\` text NOT NULL,
	\`batch_id\` text NOT NULL,
	\`table_name\` text NOT NULL,
	\`record_id\` text NOT NULL,
	\`operation\` text NOT NULL,
	\`payload_json\` text NOT NULL,
	\`field_hlc_json\` text NOT NULL,
	\`hlc_timestamp\` text NOT NULL,
	\`status\` text DEFAULT 'PENDING' NOT NULL,
	\`retry_count\` integer DEFAULT 0 NOT NULL,
	\`last_error\` text,
	\`created_at\` text NOT NULL,
	CONSTRAINT "chk_outbox_table_name" CHECK("sync_outbox"."table_name" IN ('accounts', 'categories', 'credit_cards', 'credit_card_invoices', 'installment_plans', 'recurring_rules', 'transactions', 'budgets')),
	CONSTRAINT "chk_outbox_operation" CHECK("sync_outbox"."operation" IN ('UPSERT', 'SOFT_DELETE', 'RESTORE')),
	CONSTRAINT "chk_outbox_status" CHECK("sync_outbox"."status" IN ('PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT'))
);
CREATE UNIQUE INDEX IF NOT EXISTS \`sync_outbox_mutation_id_unique\` ON \`sync_outbox\` (\`mutation_id\`);
CREATE INDEX IF NOT EXISTS \`idx_outbox_status_seq\` ON \`sync_outbox\` (\`status\`,\`seq_id\`);
CREATE INDEX IF NOT EXISTS \`idx_outbox_table_record\` ON \`sync_outbox\` (\`table_name\`,\`record_id\`,\`status\`);
CREATE INDEX IF NOT EXISTS \`idx_outbox_batch_id\` ON \`sync_outbox\` (\`batch_id\`);
`;

/**
 * @deprecated Prefer `applyLocalMigrations` from `./migrations/localMigrations`.
 * Kept for callers that only need the IF NOT EXISTS bootstrap DDL.
 */
export function ensureLocalSchema(sqlite: SQLite.SQLiteDatabase): void {
  sqlite.execSync(LOCAL_SCHEMA_DDL);
}
