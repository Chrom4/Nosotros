import {
  type PullChangesRequest,
  type PullChangesResult,
  type PushBatchRequest,
  type PushBatchResult,
  type SyncBackendGateway,
  SyncError,
  type WireChange,
  type WireMutation,
} from '@/sync/syncGateway';
import type { ServerFixture } from './syncTestKit';
import { HOUSEHOLD_ID } from './syncTestKit';

type Row = Record<string, unknown> & {
  id: string;
  household_id: string;
  field_hlc: Record<string, string>;
  hlc_timestamp: string;
  server_seq: number;
  deleted_at: string | null;
  updated_at: string;
};

/** Mirrors `sync_table_priority` / `sync_mutable_columns` from migration 0004. */
const PRIORITY: Record<string, number> = {
  accounts: 1,
  categories: 2,
  credit_cards: 3,
  credit_card_invoices: 4,
  installment_plans: 5,
  recurring_rules: 6,
  transactions: 7,
  budgets: 8,
};

const MUTABLE: Record<string, string[]> = {
  accounts: [
    'owner_user_id',
    'name',
    'type',
    'initial_balance_cents',
    'include_in_net_worth',
    'is_archived',
  ],
  categories: ['parent_id', 'name', 'color_hex', 'icon_name'],
  credit_cards: [
    'owner_user_id',
    'default_payment_account_id',
    'name',
    'limit_cents',
    'closing_day',
    'due_day',
    'is_archived',
  ],
  credit_card_invoices: ['status'],
  installment_plans: [
    'owner_user_id',
    'category_id',
    'description',
    'total_amount_cents',
    'total_installments',
    'purchase_date',
  ],
  recurring_rules: [
    'owner_user_id',
    'type',
    'account_id',
    'credit_card_id',
    'category_id',
    'description',
    'amount_cents',
    'frequency',
    'day_of_month',
    'start_month',
    'end_month',
    'is_active',
  ],
  transactions: [
    'owner_user_id',
    'status',
    'amount_cents',
    'transaction_date',
    'competence_month',
    'description',
    'notes',
    'account_id',
    'transfer_account_id',
    'category_id',
    'is_household_contribution',
  ],
  budgets: ['owner_user_id', 'limit_cents'],
};

/** Foreign keys enforced by the real schema (column -> referenced table). */
const FOREIGN_KEYS: Record<string, Array<[string, string]>> = {
  categories: [['parent_id', 'categories']],
  credit_cards: [['default_payment_account_id', 'accounts']],
  credit_card_invoices: [['credit_card_id', 'credit_cards']],
  installment_plans: [
    ['category_id', 'categories'],
    ['credit_card_id', 'credit_cards'],
    ['account_id', 'accounts'],
  ],
  recurring_rules: [
    ['account_id', 'accounts'],
    ['credit_card_id', 'credit_cards'],
    ['category_id', 'categories'],
  ],
  transactions: [
    ['account_id', 'accounts'],
    ['transfer_account_id', 'accounts'],
    ['credit_card_id', 'credit_cards'],
    ['invoice_id', 'credit_card_invoices'],
    ['category_id', 'categories'],
    ['installment_plan_id', 'installment_plans'],
    ['recurring_rule_id', 'recurring_rules'],
  ],
  budgets: [['category_id', 'categories']],
};

const IDENTITY_KEYS = ['server_seq', 'hlc_timestamp', 'field_hlc'];

/** Postgres-style timestamptz rendering so clients must normalize on pull. */
function toPgTimestamp(value: string): string {
  return new Date(value).toISOString().replace('Z', '+00:00');
}

export interface PushLogEntry {
  epoch: number;
  mutationIds: string[];
  tables: string[];
  accepted: number;
  skippedIdempotent: number;
}

export interface InMemoryServerOptions {
  /**
   * When true the server re-sorts each batch by FK priority (like the SQL RPC).
   * Default false: rows are applied exactly as received, so FK checks prove the client's order.
   */
  sortBatch?: boolean;
}

/**
 * In-memory implementation of the `sync_push_batch` / `sync_pull_changes` contract with the
 * same merge rules as migration 0004 (per-field HLC, Tombstone Precedence, idempotency).
 */
export class InMemorySyncServer implements ServerFixture {
  private tables = new Map<string, Map<string, Row>>();
  private processed = new Set<string>();
  private seq = 0;
  private epoch = 1;
  readonly pushLog: PushLogEntry[] = [];
  pullCalls = 0;

  constructor(private readonly options: InMemoryServerOptions = {}) {
    this.resetSync();
  }

  private resetSync(): void {
    this.tables = new Map(Object.keys(PRIORITY).map((t) => [t, new Map()]));
    this.processed = new Set();
    this.seq = 0;
    this.epoch = 1;
    this.pushLog.length = 0;
    this.pullCalls = 0;
  }

  async reset(): Promise<void> {
    this.resetSync();
  }

  async setEpoch(epoch: number): Promise<void> {
    this.epoch = epoch;
  }

  async processedCount(): Promise<number> {
    return this.processed.size;
  }

  async getRow(table: string, id: string): Promise<Record<string, unknown> | null> {
    return this.tables.get(table)?.get(id) ?? null;
  }

  gatewayFor(_userId: string): SyncBackendGateway {
    return {
      pushBatch: (request) => this.pushBatch(request),
      pullChanges: (request) => this.pullChanges(request),
    };
  }

  private requireHousehold(householdId: string): void {
    if (householdId !== HOUSEHOLD_ID) {
      throw new SyncError('AUTH', 'FORBIDDEN: not a member');
    }
  }

  async pushBatch(request: PushBatchRequest): Promise<PushBatchResult> {
    this.requireHousehold(request.householdId);
    if (request.syncEpoch !== this.epoch) {
      throw new SyncError(
        'EPOCH_MISMATCH',
        `EPOCH_MISMATCH: client ${request.syncEpoch} server ${this.epoch}`,
      );
    }
    if (request.mutations.length > 100) {
      throw new SyncError('PERMANENT', 'BATCH_TOO_LARGE');
    }

    // Transactional: snapshot, apply, restore on any failure.
    const snapshot = this.snapshot();
    const entry: PushLogEntry = {
      epoch: request.syncEpoch,
      mutationIds: request.mutations.map((m) => m.mutation_id),
      tables: request.mutations.map((m) => m.table_name),
      accepted: 0,
      skippedIdempotent: 0,
    };

    try {
      let ordered = request.mutations.map((m, ord) => ({ m, ord }));
      if (this.options.sortBatch) {
        ordered = ordered.sort(
          (a, b) =>
            PRIORITY[a.m.table_name] - PRIORITY[b.m.table_name] ||
            Number(a.m.table_name === 'categories' && a.m.payload.parent_id != null) -
              Number(b.m.table_name === 'categories' && b.m.payload.parent_id != null) ||
            a.ord - b.ord,
        );
      }

      let seqMax = 0;
      for (const { m } of ordered) {
        if (this.processed.has(m.mutation_id)) {
          entry.skippedIdempotent += 1;
          continue;
        }
        this.processed.add(m.mutation_id);
        const assigned = this.apply(m);
        entry.accepted += 1;
        if (assigned !== null) seqMax = Math.max(seqMax, assigned);
      }
      this.pushLog.push(entry);
      return {
        accepted: entry.accepted,
        skippedIdempotent: entry.skippedIdempotent,
        serverSeqMax: seqMax,
      };
    } catch (err) {
      this.restore(snapshot);
      throw err;
    }
  }

  async pullChanges(request: PullChangesRequest): Promise<PullChangesResult> {
    this.requireHousehold(request.householdId);
    this.pullCalls += 1;
    const limit = Math.min(Math.max(request.limit, 1), 500);

    const all: Array<{ table: string; row: Row }> = [];
    for (const [table, rows] of this.tables) {
      for (const row of rows.values()) {
        if (row.server_seq > request.lastServerSeq) all.push({ table, row });
      }
    }
    all.sort((a, b) => a.row.server_seq - b.row.server_seq);

    const page = all.slice(0, limit);
    const changes: WireChange[] = page.map(({ table, row }) => {
      const payload: Record<string, unknown> = { ...row };
      for (const key of IDENTITY_KEYS) delete payload[key];
      const hasRestore = 'deleted_at' in row.field_hlc;
      return {
        table_name: table as WireChange['table_name'],
        record_id: row.id,
        server_seq: row.server_seq,
        operation:
          row.deleted_at !== null
            ? 'SOFT_DELETE'
            : hasRestore
              ? 'RESTORE'
              : 'UPSERT',
        payload,
        field_hlc: { ...row.field_hlc },
        hlc_timestamp: row.hlc_timestamp,
        deleted_at: row.deleted_at,
      };
    });

    return {
      syncEpoch: this.epoch,
      changes: JSON.parse(JSON.stringify(changes)) as WireChange[],
      hasMore: all.length > limit,
    };
  }

  // ------------------------------------------------------------------ merge --

  private apply(m: WireMutation): number | null {
    const rows = this.tables.get(m.table_name);
    if (!rows) throw new SyncError('PERMANENT', 'INVALID_MUTATION: table');
    if (typeof m.payload.__poison === 'string') {
      throw new SyncError('PERMANENT', `INVALID_MUTATION: ${m.payload.__poison}`);
    }

    const existing = rows.get(m.record_id);
    const incomingDeleted = (m.payload.deleted_at as string | null) ?? null;
    const inDelHlc = m.field_hlc.deleted_at ?? m.hlc_timestamp;

    if (!existing) {
      this.assertForeignKeys(m.table_name, m.payload);
      const fieldHlc = { ...m.field_hlc };
      if (incomingDeleted !== null && !('deleted_at' in fieldHlc)) {
        fieldHlc.deleted_at = m.hlc_timestamp;
      }
      const row: Row = {
        ...(JSON.parse(JSON.stringify(m.payload)) as Record<string, unknown>),
        id: m.record_id,
        household_id: HOUSEHOLD_ID,
        created_at: toPgTimestamp(String(m.payload.created_at)),
        updated_at: toPgTimestamp(String(m.payload.updated_at)),
        deleted_at: incomingDeleted ? toPgTimestamp(incomingDeleted) : null,
        hlc_timestamp: m.hlc_timestamp,
        field_hlc: fieldHlc,
        server_seq: ++this.seq,
      };
      rows.set(m.record_id, row);
      return row.server_seq;
    }

    if (existing.household_id !== HOUSEHOLD_ID) {
      throw new SyncError('AUTH', 'FORBIDDEN: other household');
    }

    const next: Row = { ...existing, field_hlc: { ...existing.field_hlc } };
    let changed = false;

    for (const col of MUTABLE[m.table_name]) {
      if (!(col in m.payload) || !(col in m.field_hlc)) continue;
      const current = existing.field_hlc[col] ?? existing.hlc_timestamp;
      if (m.field_hlc[col] > current) {
        next[col] = m.payload[col];
        next.field_hlc[col] = m.field_hlc[col];
        changed = true;
      }
    }

    const recorded = existing.field_hlc.deleted_at;
    const currentDelHlc = recorded ?? existing.hlc_timestamp;
    if (m.operation === 'RESTORE') {
      if (existing.deleted_at !== null) {
        if (inDelHlc > currentDelHlc) {
          next.deleted_at = null;
          next.field_hlc.deleted_at = inDelHlc;
          changed = true;
        }
      } else if (!recorded || inDelHlc > recorded) {
        next.field_hlc.deleted_at = inDelHlc;
        changed = true;
      }
    } else if (incomingDeleted !== null) {
      if (existing.deleted_at !== null) {
        if (inDelHlc > currentDelHlc) {
          next.field_hlc.deleted_at = inDelHlc;
          changed = true;
        }
      } else if (!recorded || inDelHlc >= recorded) {
        next.deleted_at = toPgTimestamp(incomingDeleted);
        next.field_hlc.deleted_at = inDelHlc;
        changed = true;
      }
    }

    if (!changed) return null;

    const incomingUpdated = toPgTimestamp(String(m.payload.updated_at ?? existing.updated_at));
    next.updated_at =
      Date.parse(incomingUpdated) > Date.parse(existing.updated_at)
        ? incomingUpdated
        : existing.updated_at;
    next.hlc_timestamp =
      m.hlc_timestamp > existing.hlc_timestamp ? m.hlc_timestamp : existing.hlc_timestamp;
    next.server_seq = ++this.seq;
    rows.set(m.record_id, next);
    return next.server_seq;
  }

  private assertForeignKeys(table: string, payload: Record<string, unknown>): void {
    for (const [column, refTable] of FOREIGN_KEYS[table] ?? []) {
      const ref = payload[column];
      if (ref == null) continue;
      if (!this.tables.get(refTable)?.has(String(ref))) {
        throw new SyncError(
          'PERMANENT',
          `23503: ${table}.${column} -> ${refTable} missing (${String(ref)})`,
        );
      }
    }
  }

  private snapshot() {
    return {
      tables: new Map(
        [...this.tables].map(([t, rows]) => [
          t,
          new Map([...rows].map(([id, row]) => [id, structuredClone(row)])),
        ]),
      ),
      processed: new Set(this.processed),
      seq: this.seq,
    };
  }

  private restore(snapshot: ReturnType<InMemorySyncServer['snapshot']>): void {
    this.tables = snapshot.tables;
    this.processed = snapshot.processed;
    this.seq = snapshot.seq;
  }
}
