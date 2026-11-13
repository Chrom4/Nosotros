import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const SYNCABLE_TABLES = [
  'accounts',
  'categories',
  'credit_cards',
  'credit_card_invoices',
  'installment_plans',
  'recurring_rules',
  'transactions',
  'budgets',
] as const;

export type SyncableTableName = (typeof SYNCABLE_TABLES)[number];

/**
 * FK topological priority shared by the local outbox, peer reconcile and the sync engine.
 * Parents always sort before dependants (accounts -> categories -> cards -> ... -> transactions).
 */
export const TOPOLOGICAL_TABLE_PRIORITY: Record<SyncableTableName, number> = {
  accounts: 1,
  categories: 2,
  credit_cards: 3,
  credit_card_invoices: 4,
  installment_plans: 5,
  recurring_rules: 6,
  transactions: 7,
  budgets: 8,
};

export const OUTBOX_OPERATIONS = ['UPSERT', 'SOFT_DELETE', 'RESTORE'] as const;
export type OutboxOperation = (typeof OUTBOX_OPERATIONS)[number];

export const OUTBOX_STATUSES = [
  'PENDING',
  'IN_FLIGHT',
  'FAILED_PERMANENT',
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const SYNC_META_KEYS = {
  DEVICE_NODE_ID: 'device_node_id',
  LAST_SERVER_SEQ: 'last_server_seq',
  SYNC_EPOCH: 'sync_epoch',
  SERVER_TIME_OFFSET: 'server_time_offset',
  HLC_STATE: 'hlc_state',
} as const;

/**
 * Local key-value control metadata for the sync engine (`sync_meta`).
 * Keys:
 * - `device_node_id`: 12-char hex device identifier
 * - `last_server_seq`: monotonic downlink pull cursor
 * - `sync_epoch`: household epoch to detect backup restores
 * - `server_time_offset`: server clock offset in milliseconds
 * - `hlc_state`: JSON serialized `{ lastWallMs, counter, nodeId }`
 */
export const syncMeta = sqliteTable('sync_meta', {
  key: text('key').primaryKey().notNull(),
  value: text('value').notNull(),
});

/**
 * Transactional outbox queue (`sync_outbox`) written in the same SQLite transaction
 * as every local domain mutation.
 */
export const syncOutbox = sqliteTable(
  'sync_outbox',
  {
    seqId: integer('seq_id').primaryKey({ autoIncrement: true }),
    mutationId: text('mutation_id').notNull().unique(),
    batchId: text('batch_id').notNull(),
    tableName: text('table_name').$type<SyncableTableName>().notNull(),
    recordId: text('record_id').notNull(),
    operation: text('operation').$type<OutboxOperation>().notNull(),
    payloadJson: text('payload_json').notNull(),
    fieldHlcJson: text('field_hlc_json').notNull(),
    hlcTimestamp: text('hlc_timestamp').notNull(),
    status: text('status')
      .$type<OutboxStatus>()
      .notNull()
      .default('PENDING'),
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_outbox_status_seq').on(table.status, table.seqId),
    index('idx_outbox_table_record').on(
      table.tableName,
      table.recordId,
      table.status,
    ),
    index('idx_outbox_batch_id').on(table.batchId),
    check(
      'chk_outbox_table_name',
      sql`${table.tableName} IN ('accounts', 'categories', 'credit_cards', 'credit_card_invoices', 'installment_plans', 'recurring_rules', 'transactions', 'budgets')`,
    ),
    check(
      'chk_outbox_operation',
      sql`${table.operation} IN ('UPSERT', 'SOFT_DELETE', 'RESTORE')`,
    ),
    check(
      'chk_outbox_status',
      sql`${table.status} IN ('PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT')`,
    ),
  ],
);

export type SyncMetaRow = typeof syncMeta.$inferSelect;
export type NewSyncMetaRow = typeof syncMeta.$inferInsert;
export type SyncOutboxRow = typeof syncOutbox.$inferSelect;
export type NewSyncOutboxRow = typeof syncOutbox.$inferInsert;
