import { eq } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { compareHlc, type FieldHlcMap, type HlcState, receiveRemoteHlc } from '@/core';
import type { DbExecutor } from '../db';
import {
  accounts,
  budgets,
  categories,
  creditCardInvoices,
  creditCards,
  installmentPlans,
  type OutboxOperation,
  recurringRules,
  SYNC_META_KEYS,
  type SyncableTableName,
  transactions,
} from '../schema';
import { getSyncMetaValue, setSyncMetaValue } from './syncMetaStore';

/**
 * A remote (or peer) change in wire shape: snake_case `payload`, per-column `fieldHlc`
 * and the mutation-level `hlcTimestamp`. `payload.deleted_at` carries the local tombstone
 * representation (the delete HLC), never a server timestamptz.
 */
export interface RemoteChange {
  tableName: SyncableTableName;
  recordId: string;
  operation: OutboxOperation;
  payload: Record<string, unknown>;
  fieldHlc: FieldHlcMap;
  hlcTimestamp: string;
}

export interface RemoteChangeEnvelope {
  change: RemoteChange;
  serverSeq: number;
}

type ColumnKind = 'text' | 'textNull' | 'int' | 'intNull' | 'bool';

interface ColumnSpec {
  /** snake_case wire key; the Drizzle property is derived via camelCase. */
  key: string;
  kind: ColumnKind;
  /** Only mutable columns take part in field-level HLC merge of existing rows. */
  mutable: boolean;
  /** Value used on insert when the payload omits the key. */
  fallback?: number | boolean;
}

const imm = (kind: ColumnKind, key: string): ColumnSpec => ({
  key,
  kind,
  mutable: false,
});
const mut = (
  kind: ColumnKind,
  key: string,
  fallback?: number | boolean,
): ColumnSpec => ({ key, kind, mutable: true, fallback });

interface TableSpec {
  table: SQLiteTable;
  columns: readonly ColumnSpec[];
}

/**
 * Per-table column specs. Immutable columns are written on insert only; mutable columns
 * are merged per field using HLC. `created_at`, `updated_at`, `deleted_at`,
 * `hlc_timestamp`, `field_hlc` and `server_seq` are handled generically.
 */
const TABLE_SPECS: Record<SyncableTableName, TableSpec> = {
  accounts: {
    table: accounts,
    columns: [
      imm('text', 'id'),
      imm('text', 'household_id'),
      mut('textNull', 'owner_user_id'),
      mut('text', 'name'),
      mut('text', 'type'),
      mut('int', 'initial_balance_cents', 0),
      mut('bool', 'include_in_net_worth', true),
      mut('bool', 'is_archived', false),
    ],
  },
  categories: {
    table: categories,
    columns: [
      imm('text', 'id'),
      imm('text', 'household_id'),
      mut('textNull', 'parent_id'),
      mut('text', 'name'),
      imm('text', 'kind'),
      mut('text', 'color_hex'),
      mut('text', 'icon_name'),
    ],
  },
  credit_cards: {
    table: creditCards,
    columns: [
      imm('text', 'id'),
      imm('text', 'household_id'),
      mut('textNull', 'owner_user_id'),
      mut('text', 'default_payment_account_id'),
      mut('text', 'name'),
      mut('int', 'limit_cents'),
      mut('int', 'closing_day'),
      mut('int', 'due_day'),
      mut('bool', 'is_archived', false),
    ],
  },
  credit_card_invoices: {
    table: creditCardInvoices,
    columns: [
      imm('text', 'id'),
      imm('text', 'household_id'),
      imm('text', 'credit_card_id'),
      imm('text', 'competence_month'),
      imm('text', 'closing_date'),
      imm('text', 'due_date'),
      mut('text', 'status'),
    ],
  },
  installment_plans: {
    table: installmentPlans,
    columns: [
      imm('text', 'id'),
      imm('text', 'household_id'),
      imm('text', 'created_by_user_id'),
      mut('textNull', 'owner_user_id'),
      imm('textNull', 'credit_card_id'),
      imm('textNull', 'account_id'),
      mut('text', 'category_id'),
      mut('text', 'description'),
      mut('int', 'total_amount_cents'),
      mut('int', 'total_installments'),
      mut('text', 'purchase_date'),
    ],
  },
  recurring_rules: {
    table: recurringRules,
    columns: [
      imm('text', 'id'),
      imm('text', 'household_id'),
      imm('text', 'created_by_user_id'),
      mut('textNull', 'owner_user_id'),
      mut('text', 'type'),
      mut('textNull', 'account_id'),
      mut('textNull', 'credit_card_id'),
      mut('text', 'category_id'),
      mut('text', 'description'),
      mut('int', 'amount_cents'),
      mut('text', 'frequency'),
      mut('int', 'day_of_month'),
      mut('text', 'start_month'),
      mut('textNull', 'end_month'),
      mut('bool', 'is_active', true),
    ],
  },
  transactions: {
    table: transactions,
    columns: [
      imm('text', 'id'),
      imm('text', 'household_id'),
      imm('text', 'created_by_user_id'),
      mut('textNull', 'owner_user_id'),
      imm('text', 'type'),
      mut('text', 'status'),
      mut('int', 'amount_cents'),
      mut('text', 'transaction_date'),
      mut('text', 'competence_month'),
      mut('text', 'description'),
      mut('textNull', 'notes'),
      mut('textNull', 'account_id'),
      mut('textNull', 'transfer_account_id'),
      imm('textNull', 'credit_card_id'),
      imm('textNull', 'invoice_id'),
      mut('textNull', 'category_id'),
      imm('textNull', 'installment_plan_id'),
      imm('intNull', 'installment_number'),
      imm('intNull', 'total_installments'),
      imm('textNull', 'recurring_rule_id'),
      imm('textNull', 'refunded_transaction_id'),
      mut('bool', 'is_household_contribution', false),
      imm('textNull', 'calendar_event_id'),
    ],
  },
  budgets: {
    table: budgets,
    columns: [
      imm('text', 'id'),
      imm('text', 'household_id'),
      mut('textNull', 'owner_user_id'),
      imm('text', 'category_id'),
      imm('text', 'competence_month'),
      mut('int', 'limit_cents'),
    ],
  },
};

type LooseRow = Record<string, unknown> & {
  id: string;
  deletedAt: string | null;
  updatedAt: string;
  hlcTimestamp: string;
  fieldHlc: FieldHlcMap;
};

const DEFAULT_NODE_ID = '010203040506';

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function coerce(spec: ColumnSpec, raw: unknown): unknown {
  switch (spec.kind) {
    case 'text':
      return String(raw);
    case 'textNull':
      return raw != null ? String(raw) : null;
    case 'int':
      return Number(raw ?? spec.fallback);
    case 'intNull':
      return raw != null ? Number(raw) : null;
    case 'bool':
      return Boolean(raw ?? spec.fallback);
  }
}

function maxString(a: string, b: string): string {
  return a >= b ? a : b;
}

function readHlcState(tx: DbExecutor): HlcState {
  const nodeId =
    getSyncMetaValue(tx, SYNC_META_KEYS.DEVICE_NODE_ID) ?? DEFAULT_NODE_ID;
  const fallback: HlcState = { lastWallMs: 0, counter: 0, nodeId };
  const raw = getSyncMetaValue(tx, SYNC_META_KEYS.HLC_STATE);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<HlcState>;
    if (
      typeof parsed.lastWallMs === 'number' &&
      typeof parsed.counter === 'number'
    ) {
      return {
        lastWallMs: parsed.lastWallMs,
        counter: parsed.counter,
        nodeId: parsed.nodeId || nodeId,
      };
    }
  } catch {
    // Corrupted hlc_state: recover from scratch.
  }
  return fallback;
}

function insertRemoteRow(
  tx: DbExecutor,
  spec: TableSpec,
  change: RemoteChange,
  serverSeq: number,
): void {
  const { payload } = change;
  const values: Record<string, unknown> = {};
  for (const col of spec.columns) {
    values[toCamelCase(col.key)] = coerce(col, payload[col.key]);
  }
  values.createdAt = String(payload.created_at);
  values.updatedAt = String(payload.updated_at);
  values.deletedAt =
    payload.deleted_at != null ? String(payload.deleted_at) : null;
  values.hlcTimestamp = change.hlcTimestamp;
  values.fieldHlc = change.fieldHlc;
  values.serverSeq = serverSeq;
  tx.insert(spec.table)
    .values(values as never)
    .run();
}

/**
 * Resolves `deleted_at` with Tombstone Precedence (`field_hlc.deleted_at` records the newest
 * delete OR restore HLC seen for the row):
 * - a tombstone is never undone by concurrent field edits (`UPSERT` carrying `deleted_at = null`);
 * - only a `RESTORE` whose HLC is newer than the tombstone HLC lifts it;
 * - a delete older than a recorded restore is ignored; a restore that arrives first is recorded
 *   so convergence does not depend on delivery order.
 */
function resolveDeletedAt(
  existing: LooseRow,
  change: RemoteChange,
  mergedFieldHlc: FieldHlcMap,
): string | null {
  const incomingDeletedAt =
    change.payload.deleted_at != null ? String(change.payload.deleted_at) : null;
  const incomingDelHlc = change.fieldHlc.deleted_at ?? change.hlcTimestamp;
  const recordedHlc = existing.fieldHlc.deleted_at;
  const currentDelHlc = recordedHlc ?? existing.hlcTimestamp;

  if (change.operation === 'RESTORE') {
    if (existing.deletedAt !== null) {
      if (compareHlc(incomingDelHlc, currentDelHlc) > 0) {
        mergedFieldHlc.deleted_at = incomingDelHlc;
        return null;
      }
      return existing.deletedAt;
    }
    if (!recordedHlc || compareHlc(incomingDelHlc, recordedHlc) > 0) {
      mergedFieldHlc.deleted_at = incomingDelHlc;
    }
    return null;
  }

  if (incomingDeletedAt === null) {
    return existing.deletedAt;
  }

  if (existing.deletedAt !== null) {
    if (compareHlc(incomingDelHlc, currentDelHlc) > 0) {
      mergedFieldHlc.deleted_at = incomingDelHlc;
      return maxString(existing.deletedAt, incomingDeletedAt);
    }
    return existing.deletedAt;
  }

  if (recordedHlc && compareHlc(incomingDelHlc, recordedHlc) < 0) {
    return null;
  }
  mergedFieldHlc.deleted_at = incomingDelHlc;
  return incomingDeletedAt;
}

function mergeRemoteRow(
  tx: DbExecutor,
  spec: TableSpec,
  existing: LooseRow,
  change: RemoteChange,
  serverSeq: number,
): void {
  const { payload } = change;
  const mergedFieldHlc: FieldHlcMap = { ...existing.fieldHlc };
  const patch: Record<string, unknown> = {};

  for (const col of spec.columns) {
    if (!col.mutable || !(col.key in payload)) continue;
    const incomingHlc = change.fieldHlc[col.key];
    // A column without its own incoming HLC was not written by this mutation.
    if (!incomingHlc) continue;
    const currentHlc = existing.fieldHlc[col.key] ?? existing.hlcTimestamp;
    if (compareHlc(incomingHlc, currentHlc) > 0) {
      patch[toCamelCase(col.key)] = coerce(col, payload[col.key]);
      mergedFieldHlc[col.key] = incomingHlc;
    } else {
      mergedFieldHlc[col.key] = currentHlc;
    }
  }

  const deletedAt = resolveDeletedAt(existing, change, mergedFieldHlc);
  const incomingUpdatedAt =
    payload.updated_at != null ? String(payload.updated_at) : existing.updatedAt;

  const idColumn = (spec.table as unknown as Record<string, never>).id;
  tx.update(spec.table)
    .set({
      ...patch,
      updatedAt: maxString(existing.updatedAt, incomingUpdatedAt),
      deletedAt,
      hlcTimestamp:
        compareHlc(change.hlcTimestamp, existing.hlcTimestamp) > 0
          ? change.hlcTimestamp
          : existing.hlcTimestamp,
      fieldHlc: mergedFieldHlc,
      serverSeq,
    } as never)
    .where(eq(idColumn, existing.id))
    .run();
}

/**
 * Applies a single remote/peer change to its domain table inside the caller's transaction:
 * insert when missing, otherwise per-field HLC merge with Tombstone Precedence.
 * Never performs a physical DELETE.
 */
export function applyRemoteChange(
  tx: DbExecutor,
  change: RemoteChange,
  serverSeq: number,
): void {
  const spec = TABLE_SPECS[change.tableName];
  const idColumn = (spec.table as unknown as Record<string, never>).id;
  const existing = tx
    .select()
    .from(spec.table)
    .where(eq(idColumn, change.recordId))
    .get() as LooseRow | undefined;

  if (!existing) {
    insertRemoteRow(tx, spec, change, serverSeq);
    return;
  }
  mergeRemoteRow(tx, spec, existing, change, serverSeq);
}

/**
 * Applies an ordered list of remote changes in the caller's transaction, folding every
 * incoming HLC into the persisted local `hlc_state`. Returns the touched tables.
 * The caller owns the transaction and the cursor update.
 */
export function applyRemoteChanges(
  tx: DbExecutor,
  envelopes: readonly RemoteChangeEnvelope[],
  options: { nowMs?: number } = {},
): SyncableTableName[] {
  const nowMs = options.nowMs ?? Date.now();
  const touched = new Set<SyncableTableName>();
  let hlcState = readHlcState(tx);

  for (const { change, serverSeq } of envelopes) {
    hlcState = receiveRemoteHlc(hlcState, change.hlcTimestamp, nowMs);
    applyRemoteChange(tx, change, serverSeq);
    touched.add(change.tableName);
  }

  setSyncMetaValue(tx, SYNC_META_KEYS.HLC_STATE, JSON.stringify(hlcState));
  return Array.from(touched);
}
