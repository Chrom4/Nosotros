import { and, asc, eq } from 'drizzle-orm';
import {
  compareHlc,
  computeCorrectedNowMs,
  type FieldHlcMap,
  type HlcState,
  nextLocalHlc,
  receiveRemoteHlc,
} from '@/core';
import { type AppDatabase, type DbExecutor, notifyDatabaseChange } from '../db';
import {
  accounts,
  categories,
  creditCardInvoices,
  creditCards,
  installmentPlans,
  type OutboxOperation,
  recurringRules,
  type SyncableTableName,
  SYNC_META_KEYS,
  syncMeta,
  syncOutbox,
  type SyncOutboxRow,
  transactions,
} from '../schema';

export interface MutationContextOptions {
  /**
   * Optional shared `batchId` for composite mutations (e.g. installment plan + N installments).
   */
  batchId?: string;
  /**
   * Optional explicit `mutationId` (defaults to a fresh UUIDv4).
   */
  mutationId?: string;
  /**
   * Optional wall clock override in milliseconds (useful for deterministic tests).
   */
  nowMs?: number;
  /**
   * Optional fallback nodeId if `device_node_id` is not yet stored in `sync_meta`.
   */
  nodeId?: string;
}

export interface StampedMutationMeta {
  hlc: string;
  isoNow: string;
  batchId: string;
  mutationId: string;
}

const DEFAULT_NODE_ID = '010203040506';

/**
 * Generates a RFC 4122 UUIDv4 string without requiring external native modules in Node/Hermes.
 */
export function generateUuidV4(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID().toLowerCase();
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  // Set version 4 (0100) and RFC 4122 variant (10xx)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[i].toString(16).padStart(2, '0'));
  }

  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

export function getSyncMetaValue(
  tx: DbExecutor,
  key: string,
): string | null {
  const row = tx
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, key))
    .get();
  return row ? row.value : null;
}

export function setSyncMetaValue(
  tx: DbExecutor,
  key: string,
  value: string,
): void {
  tx.insert(syncMeta)
    .values({ key, value })
    .onConflictDoUpdate({
      target: syncMeta.key,
      set: { value },
    })
    .run();
}

/**
 * Advances the local HLC state inside the active SQLite transaction and persists it in `sync_meta`.
 */
export function advanceTransactionHlc(
  tx: DbExecutor,
  options: MutationContextOptions = {},
): StampedMutationMeta {
  const storedNodeId =
    getSyncMetaValue(tx, SYNC_META_KEYS.DEVICE_NODE_ID) ??
    options.nodeId ??
    DEFAULT_NODE_ID;

  if (!getSyncMetaValue(tx, SYNC_META_KEYS.DEVICE_NODE_ID)) {
    setSyncMetaValue(tx, SYNC_META_KEYS.DEVICE_NODE_ID, storedNodeId);
  }

  const offsetRaw = getSyncMetaValue(tx, SYNC_META_KEYS.SERVER_TIME_OFFSET);
  const offsetMs = offsetRaw ? Number(offsetRaw) || 0 : 0;

  const localNowMs = options.nowMs ?? Date.now();
  const correctedNowMs = computeCorrectedNowMs(localNowMs, offsetMs);

  let currentState: HlcState = {
    lastWallMs: 0,
    counter: 0,
    nodeId: storedNodeId,
  };

  const rawState = getSyncMetaValue(tx, SYNC_META_KEYS.HLC_STATE);
  if (rawState) {
    try {
      const parsed = JSON.parse(rawState) as Partial<HlcState>;
      if (
        typeof parsed.lastWallMs === 'number' &&
        typeof parsed.counter === 'number'
      ) {
        currentState = {
          lastWallMs: parsed.lastWallMs,
          counter: parsed.counter,
          nodeId:
            typeof parsed.nodeId === 'string' && parsed.nodeId.length === 12
              ? parsed.nodeId
              : storedNodeId,
        };
      }
    } catch {
      // Recover cleanly if hlc_state JSON was corrupted
    }
  }

  const { hlc, nextState } = nextLocalHlc(currentState, correctedNowMs);
  setSyncMetaValue(tx, SYNC_META_KEYS.HLC_STATE, JSON.stringify(nextState));

  return {
    hlc,
    isoNow: new Date(correctedNowMs).toISOString(),
    batchId: options.batchId ?? generateUuidV4(),
    mutationId: options.mutationId ?? generateUuidV4(),
  };
}

/**
 * Builds a `FieldHlcMap` assigning `hlc` to every specified column name,
 * optionally merging over an existing `FieldHlcMap`.
 */
export function buildFieldHlcMap(
  columns: readonly string[],
  hlc: string,
  existing: FieldHlcMap = {},
): FieldHlcMap {
  const next: FieldHlcMap = { ...existing };
  for (const col of columns) {
    next[col] = hlc;
  }
  return next;
}

export interface EnqueueOutboxParams {
  mutationId?: string;
  batchId: string;
  tableName: SyncableTableName;
  recordId: string;
  operation: OutboxOperation;
  payload: Record<string, unknown>;
  fieldHlc: FieldHlcMap;
  hlcTimestamp: string;
  createdAt: string;
}

/**
 * Enqueues a domain mutation in `sync_outbox` within the same SQLite transaction.
 * Implements local outbox coalescing (Audit §13.5.2): if a `PENDING` entry already exists
 * for `(tableName, recordId)`, merges the payload and `field_hlc_json` in place while
 * preserving topological queue order (`seq_id`).
 */
export function enqueueOrCoalesceOutbox(
  tx: DbExecutor,
  params: EnqueueOutboxParams,
): SyncOutboxRow {
  const existingPending = tx
    .select()
    .from(syncOutbox)
    .where(
      and(
        eq(syncOutbox.tableName, params.tableName),
        eq(syncOutbox.recordId, params.recordId),
        eq(syncOutbox.status, 'PENDING'),
      ),
    )
    .get();

  if (existingPending) {
    const prevPayload = JSON.parse(existingPending.payloadJson) as Record<
      string,
      unknown
    >;
    const prevFieldHlc = JSON.parse(existingPending.fieldHlcJson) as FieldHlcMap;

    const mergedPayload = {
      ...prevPayload,
      ...params.payload,
    };
    const mergedFieldHlc: FieldHlcMap = {
      ...prevFieldHlc,
      ...params.fieldHlc,
    };

    tx.update(syncOutbox)
      .set({
        operation: params.operation,
        payloadJson: JSON.stringify(mergedPayload),
        fieldHlcJson: JSON.stringify(mergedFieldHlc),
        hlcTimestamp: params.hlcTimestamp,
      })
      .where(eq(syncOutbox.seqId, existingPending.seqId))
      .run();

    const coalesced = tx
      .select()
      .from(syncOutbox)
      .where(eq(syncOutbox.seqId, existingPending.seqId))
      .get()!;
    notifyDatabaseChange(params.tableName);
    return coalesced;
  }

  const mutationId = params.mutationId ?? generateUuidV4();
  tx.insert(syncOutbox)
    .values({
      mutationId,
      batchId: params.batchId,
      tableName: params.tableName,
      recordId: params.recordId,
      operation: params.operation,
      payloadJson: JSON.stringify(params.payload),
      fieldHlcJson: JSON.stringify(params.fieldHlc),
      hlcTimestamp: params.hlcTimestamp,
      status: 'PENDING',
      retryCount: 0,
      lastError: null,
      createdAt: params.createdAt,
    })
    .run();

  const inserted = tx
    .select()
    .from(syncOutbox)
    .where(eq(syncOutbox.mutationId, mutationId))
    .get()!;
  notifyDatabaseChange(params.tableName);
  return inserted;
}

const TOPOLOGICAL_TABLE_PRIORITY: Record<SyncableTableName, number> = {
  accounts: 1,
  categories: 2,
  credit_cards: 3,
  credit_card_invoices: 4,
  installment_plans: 5,
  recurring_rules: 6,
  transactions: 7,
  budgets: 8,
};

export interface PeerSyncSummary {
  pushedCount: number;
  appliedTables: SyncableTableName[];
  lastServerSeq: number;
}

/**
 * Reconciles pending offline mutations from `sourceDb.sync_outbox` into `targetDb`
 * in strict FK topological order (`accounts` -> `categories` root -> `categories` child -> `transactions`),
 * applying HLC field-level LWW and Tombstone Precedence (`deleted_at`), advancing `HLC_STATE` and
 * `LAST_SERVER_SEQ`, and clearing reconciled `PENDING` outbox rows on `sourceDb`.
 */
export function reconcilePeerOutbox(
  sourceDb: AppDatabase,
  targetDb: AppDatabase,
  options: { nowMs?: number } = {},
): PeerSyncSummary {
  const pendingRows = sourceDb
    .select()
    .from(syncOutbox)
    .where(eq(syncOutbox.status, 'PENDING'))
    .orderBy(asc(syncOutbox.seqId))
    .all();

  if (pendingRows.length === 0) {
    const seqStr = getSyncMetaValue(targetDb, SYNC_META_KEYS.LAST_SERVER_SEQ);
    return {
      pushedCount: 0,
      appliedTables: [],
      lastServerSeq: seqStr ? Number(seqStr) || 0 : 0,
    };
  }

  // Sort topologically by table priority, with root categories (parent_id === null) before child categories
  const sortedRows = [...pendingRows].sort((a, b) => {
    const prioDiff =
      TOPOLOGICAL_TABLE_PRIORITY[a.tableName] -
      TOPOLOGICAL_TABLE_PRIORITY[b.tableName];
    if (prioDiff !== 0) return prioDiff;

    if (a.tableName === 'categories' && b.tableName === 'categories') {
      const payloadA = JSON.parse(a.payloadJson) as Record<string, unknown>;
      const payloadB = JSON.parse(b.payloadJson) as Record<string, unknown>;
      const isRootA = payloadA.parent_id == null ? 0 : 1;
      const isRootB = payloadB.parent_id == null ? 0 : 1;
      if (isRootA !== isRootB) return isRootA - isRootB;
    }

    return a.seqId - b.seqId;
  });

  const touchedTables = new Set<SyncableTableName>();
  const nowMs = options.nowMs ?? Date.now();
  let nextSeq =
    Number(getSyncMetaValue(targetDb, SYNC_META_KEYS.LAST_SERVER_SEQ) ?? '0') ||
    0;

  targetDb.transaction((tx) => {
    const targetNodeId =
      getSyncMetaValue(tx, SYNC_META_KEYS.DEVICE_NODE_ID) ?? DEFAULT_NODE_ID;
    let hlcState: HlcState = {
      lastWallMs: 0,
      counter: 0,
      nodeId: targetNodeId,
    };
    const rawHlcState = getSyncMetaValue(tx, SYNC_META_KEYS.HLC_STATE);
    if (rawHlcState) {
      try {
        const parsed = JSON.parse(rawHlcState) as HlcState;
        if (
          typeof parsed.lastWallMs === 'number' &&
          typeof parsed.counter === 'number'
        ) {
          hlcState = {
            lastWallMs: parsed.lastWallMs,
            counter: parsed.counter,
            nodeId: parsed.nodeId || targetNodeId,
          };
        }
      } catch {
        // Ignore invalid state
      }
    }

    for (const outboxRow of sortedRows) {
      nextSeq += 1;
      const payload = JSON.parse(outboxRow.payloadJson) as Record<
        string,
        unknown
      >;
      const incomingFieldHlc = JSON.parse(
        outboxRow.fieldHlcJson,
      ) as FieldHlcMap;
      const incomingHlc = outboxRow.hlcTimestamp;

      hlcState = receiveRemoteHlc(hlcState, incomingHlc, nowMs);
      touchedTables.add(outboxRow.tableName);

      if (outboxRow.tableName === 'accounts') {
        const existing = tx
          .select()
          .from(accounts)
          .where(eq(accounts.id, outboxRow.recordId))
          .get();

        if (!existing) {
          tx.insert(accounts)
            .values({
              id: String(payload.id),
              householdId: String(payload.household_id),
              ownerUserId:
                payload.owner_user_id != null
                  ? String(payload.owner_user_id)
                  : null,
              name: String(payload.name),
              type: payload.type as typeof accounts.$inferInsert.type,
              initialBalanceCents: Number(payload.initial_balance_cents ?? 0),
              includeInNetWorth: Boolean(payload.include_in_net_worth ?? true),
              isArchived: Boolean(payload.is_archived ?? false),
              createdAt: String(payload.created_at),
              updatedAt: String(payload.updated_at),
              deletedAt:
                payload.deleted_at != null ? String(payload.deleted_at) : null,
              hlcTimestamp: incomingHlc,
              fieldHlc: incomingFieldHlc,
              serverSeq: nextSeq,
            })
            .run();
        } else {
          const mergedFieldHlc: FieldHlcMap = { ...existing.fieldHlc };
          const resolveCol = <T>(
            col: string,
            currentVal: T,
            incomingVal: T,
          ): T => {
            const curHlc = existing.fieldHlc[col] ?? existing.hlcTimestamp;
            const incHlc = incomingFieldHlc[col] ?? incomingHlc;
            if (compareHlc(incHlc, curHlc) > 0) {
              mergedFieldHlc[col] = incHlc;
              return incomingVal;
            }
            mergedFieldHlc[col] = curHlc;
            return currentVal;
          };

          const incomingDeletedAt =
            payload.deleted_at != null ? String(payload.deleted_at) : null;
          let deletedAt = existing.deletedAt;
          if (outboxRow.operation === 'RESTORE') {
            deletedAt = resolveCol('deleted_at', existing.deletedAt, null);
          } else if (existing.deletedAt !== null && incomingDeletedAt !== null) {
            deletedAt =
              existing.deletedAt >= incomingDeletedAt
                ? existing.deletedAt
                : incomingDeletedAt;
            mergedFieldHlc.deleted_at = deletedAt;
          } else if (existing.deletedAt !== null || incomingDeletedAt !== null) {
            deletedAt = existing.deletedAt ?? incomingDeletedAt;
            if (deletedAt) mergedFieldHlc.deleted_at = deletedAt;
          }

          tx.update(accounts)
            .set({
              ownerUserId: resolveCol(
                'owner_user_id',
                existing.ownerUserId,
                payload.owner_user_id != null
                  ? String(payload.owner_user_id)
                  : null,
              ),
              name: resolveCol('name', existing.name, String(payload.name)),
              type: resolveCol(
                'type',
                existing.type,
                payload.type as typeof existing.type,
              ),
              initialBalanceCents: resolveCol(
                'initial_balance_cents',
                existing.initialBalanceCents,
                Number(payload.initial_balance_cents ?? 0),
              ),
              includeInNetWorth: resolveCol(
                'include_in_net_worth',
                existing.includeInNetWorth,
                Boolean(payload.include_in_net_worth ?? true),
              ),
              isArchived: resolveCol(
                'is_archived',
                existing.isArchived,
                Boolean(payload.is_archived ?? false),
              ),
              updatedAt: String(payload.updated_at),
              deletedAt,
              hlcTimestamp:
                compareHlc(incomingHlc, existing.hlcTimestamp) > 0
                  ? incomingHlc
                  : existing.hlcTimestamp,
              fieldHlc: mergedFieldHlc,
              serverSeq: nextSeq,
            })
            .where(eq(accounts.id, existing.id))
            .run();
        }
      } else if (outboxRow.tableName === 'categories') {
        const existing = tx
          .select()
          .from(categories)
          .where(eq(categories.id, outboxRow.recordId))
          .get();

        if (!existing) {
          tx.insert(categories)
            .values({
              id: String(payload.id),
              householdId: String(payload.household_id),
              parentId:
                payload.parent_id != null ? String(payload.parent_id) : null,
              name: String(payload.name),
              kind: payload.kind as typeof categories.$inferInsert.kind,
              colorHex: String(payload.color_hex),
              iconName: String(payload.icon_name),
              createdAt: String(payload.created_at),
              updatedAt: String(payload.updated_at),
              deletedAt:
                payload.deleted_at != null ? String(payload.deleted_at) : null,
              hlcTimestamp: incomingHlc,
              fieldHlc: incomingFieldHlc,
              serverSeq: nextSeq,
            })
            .run();
        } else {
          const mergedFieldHlc: FieldHlcMap = { ...existing.fieldHlc };
          const resolveCol = <T>(
            col: string,
            currentVal: T,
            incomingVal: T,
          ): T => {
            const curHlc = existing.fieldHlc[col] ?? existing.hlcTimestamp;
            const incHlc = incomingFieldHlc[col] ?? incomingHlc;
            if (compareHlc(incHlc, curHlc) > 0) {
              mergedFieldHlc[col] = incHlc;
              return incomingVal;
            }
            mergedFieldHlc[col] = curHlc;
            return currentVal;
          };

          const incomingDeletedAt =
            payload.deleted_at != null ? String(payload.deleted_at) : null;
          let deletedAt = existing.deletedAt;
          if (outboxRow.operation === 'RESTORE') {
            deletedAt = resolveCol('deleted_at', existing.deletedAt, null);
          } else if (existing.deletedAt !== null && incomingDeletedAt !== null) {
            deletedAt =
              existing.deletedAt >= incomingDeletedAt
                ? existing.deletedAt
                : incomingDeletedAt;
            mergedFieldHlc.deleted_at = deletedAt;
          } else if (existing.deletedAt !== null || incomingDeletedAt !== null) {
            deletedAt = existing.deletedAt ?? incomingDeletedAt;
            if (deletedAt) mergedFieldHlc.deleted_at = deletedAt;
          }

          tx.update(categories)
            .set({
              parentId: resolveCol(
                'parent_id',
                existing.parentId,
                payload.parent_id != null ? String(payload.parent_id) : null,
              ),
              name: resolveCol('name', existing.name, String(payload.name)),
              colorHex: resolveCol(
                'color_hex',
                existing.colorHex,
                String(payload.color_hex),
              ),
              iconName: resolveCol(
                'icon_name',
                existing.iconName,
                String(payload.icon_name),
              ),
              updatedAt: String(payload.updated_at),
              deletedAt,
              hlcTimestamp:
                compareHlc(incomingHlc, existing.hlcTimestamp) > 0
                  ? incomingHlc
                  : existing.hlcTimestamp,
              fieldHlc: mergedFieldHlc,
              serverSeq: nextSeq,
            })
            .where(eq(categories.id, existing.id))
            .run();
        }
      } else if (outboxRow.tableName === 'credit_cards') {
        const existing = tx
          .select()
          .from(creditCards)
          .where(eq(creditCards.id, outboxRow.recordId))
          .get();

        if (!existing) {
          tx.insert(creditCards)
            .values({
              id: String(payload.id),
              householdId: String(payload.household_id),
              ownerUserId:
                payload.owner_user_id != null
                  ? String(payload.owner_user_id)
                  : null,
              defaultPaymentAccountId: String(
                payload.default_payment_account_id,
              ),
              name: String(payload.name),
              limitCents: Number(payload.limit_cents),
              closingDay: Number(payload.closing_day),
              dueDay: Number(payload.due_day),
              isArchived: Boolean(payload.is_archived ?? false),
              createdAt: String(payload.created_at),
              updatedAt: String(payload.updated_at),
              deletedAt:
                payload.deleted_at != null ? String(payload.deleted_at) : null,
              hlcTimestamp: incomingHlc,
              fieldHlc: incomingFieldHlc,
              serverSeq: nextSeq,
            })
            .run();
        } else {
          const mergedFieldHlc: FieldHlcMap = { ...existing.fieldHlc };
          const resolveCol = <T>(
            col: string,
            currentVal: T,
            incomingVal: T,
          ): T => {
            const curHlc = existing.fieldHlc[col] ?? existing.hlcTimestamp;
            const incHlc = incomingFieldHlc[col] ?? incomingHlc;
            if (compareHlc(incHlc, curHlc) > 0) {
              mergedFieldHlc[col] = incHlc;
              return incomingVal;
            }
            mergedFieldHlc[col] = curHlc;
            return currentVal;
          };

          const incomingDeletedAt =
            payload.deleted_at != null ? String(payload.deleted_at) : null;
          let deletedAt = existing.deletedAt;
          if (outboxRow.operation === 'RESTORE') {
            deletedAt = resolveCol('deleted_at', existing.deletedAt, null);
          } else if (existing.deletedAt !== null && incomingDeletedAt !== null) {
            deletedAt =
              existing.deletedAt >= incomingDeletedAt
                ? existing.deletedAt
                : incomingDeletedAt;
            mergedFieldHlc.deleted_at = deletedAt;
          } else if (existing.deletedAt !== null || incomingDeletedAt !== null) {
            deletedAt = existing.deletedAt ?? incomingDeletedAt;
            if (deletedAt) mergedFieldHlc.deleted_at = deletedAt;
          }

          tx.update(creditCards)
            .set({
              ownerUserId: resolveCol(
                'owner_user_id',
                existing.ownerUserId,
                payload.owner_user_id != null
                  ? String(payload.owner_user_id)
                  : null,
              ),
              defaultPaymentAccountId: resolveCol(
                'default_payment_account_id',
                existing.defaultPaymentAccountId,
                String(payload.default_payment_account_id),
              ),
              name: resolveCol('name', existing.name, String(payload.name)),
              limitCents: resolveCol(
                'limit_cents',
                existing.limitCents,
                Number(payload.limit_cents),
              ),
              closingDay: resolveCol(
                'closing_day',
                existing.closingDay,
                Number(payload.closing_day),
              ),
              dueDay: resolveCol(
                'due_day',
                existing.dueDay,
                Number(payload.due_day),
              ),
              isArchived: resolveCol(
                'is_archived',
                existing.isArchived,
                Boolean(payload.is_archived ?? false),
              ),
              updatedAt: String(payload.updated_at),
              deletedAt,
              hlcTimestamp:
                compareHlc(incomingHlc, existing.hlcTimestamp) > 0
                  ? incomingHlc
                  : existing.hlcTimestamp,
              fieldHlc: mergedFieldHlc,
              serverSeq: nextSeq,
            })
            .where(eq(creditCards.id, existing.id))
            .run();
        }
      } else if (outboxRow.tableName === 'credit_card_invoices') {
        const existing = tx
          .select()
          .from(creditCardInvoices)
          .where(eq(creditCardInvoices.id, outboxRow.recordId))
          .get();

        if (!existing) {
          tx.insert(creditCardInvoices)
            .values({
              id: String(payload.id),
              householdId: String(payload.household_id),
              creditCardId: String(payload.credit_card_id),
              competenceMonth: String(payload.competence_month),
              closingDate: String(payload.closing_date),
              dueDate: String(payload.due_date),
              status:
                payload.status as typeof creditCardInvoices.$inferInsert.status,
              createdAt: String(payload.created_at),
              updatedAt: String(payload.updated_at),
              deletedAt:
                payload.deleted_at != null ? String(payload.deleted_at) : null,
              hlcTimestamp: incomingHlc,
              fieldHlc: incomingFieldHlc,
              serverSeq: nextSeq,
            })
            .run();
        } else {
          const mergedFieldHlc: FieldHlcMap = { ...existing.fieldHlc };
          const resolveCol = <T>(
            col: string,
            currentVal: T,
            incomingVal: T,
          ): T => {
            const curHlc = existing.fieldHlc[col] ?? existing.hlcTimestamp;
            const incHlc = incomingFieldHlc[col] ?? incomingHlc;
            if (compareHlc(incHlc, curHlc) > 0) {
              mergedFieldHlc[col] = incHlc;
              return incomingVal;
            }
            mergedFieldHlc[col] = curHlc;
            return currentVal;
          };

          const incomingDeletedAt =
            payload.deleted_at != null ? String(payload.deleted_at) : null;
          let deletedAt = existing.deletedAt;
          if (outboxRow.operation === 'RESTORE') {
            deletedAt = resolveCol('deleted_at', existing.deletedAt, null);
          } else if (existing.deletedAt !== null && incomingDeletedAt !== null) {
            deletedAt =
              existing.deletedAt >= incomingDeletedAt
                ? existing.deletedAt
                : incomingDeletedAt;
            mergedFieldHlc.deleted_at = deletedAt;
          } else if (existing.deletedAt !== null || incomingDeletedAt !== null) {
            deletedAt = existing.deletedAt ?? incomingDeletedAt;
            if (deletedAt) mergedFieldHlc.deleted_at = deletedAt;
          }

          tx.update(creditCardInvoices)
            .set({
              status: resolveCol(
                'status',
                existing.status,
                payload.status as typeof existing.status,
              ),
              updatedAt: String(payload.updated_at),
              deletedAt,
              hlcTimestamp:
                compareHlc(incomingHlc, existing.hlcTimestamp) > 0
                  ? incomingHlc
                  : existing.hlcTimestamp,
              fieldHlc: mergedFieldHlc,
              serverSeq: nextSeq,
            })
            .where(eq(creditCardInvoices.id, existing.id))
            .run();
        }
      } else if (outboxRow.tableName === 'installment_plans') {
        const existing = tx
          .select()
          .from(installmentPlans)
          .where(eq(installmentPlans.id, outboxRow.recordId))
          .get();

        if (!existing) {
          tx.insert(installmentPlans)
            .values({
              id: String(payload.id),
              householdId: String(payload.household_id),
              createdByUserId: String(payload.created_by_user_id),
              ownerUserId:
                payload.owner_user_id != null
                  ? String(payload.owner_user_id)
                  : null,
              creditCardId:
                payload.credit_card_id != null
                  ? String(payload.credit_card_id)
                  : null,
              accountId:
                payload.account_id != null ? String(payload.account_id) : null,
              categoryId: String(payload.category_id),
              description: String(payload.description),
              totalAmountCents: Number(payload.total_amount_cents),
              totalInstallments: Number(payload.total_installments),
              purchaseDate: String(payload.purchase_date),
              createdAt: String(payload.created_at),
              updatedAt: String(payload.updated_at),
              deletedAt:
                payload.deleted_at != null ? String(payload.deleted_at) : null,
              hlcTimestamp: incomingHlc,
              fieldHlc: incomingFieldHlc,
              serverSeq: nextSeq,
            })
            .run();
        } else {
          const mergedFieldHlc: FieldHlcMap = { ...existing.fieldHlc };
          const resolveCol = <T>(
            col: string,
            currentVal: T,
            incomingVal: T,
          ): T => {
            const curHlc = existing.fieldHlc[col] ?? existing.hlcTimestamp;
            const incHlc = incomingFieldHlc[col] ?? incomingHlc;
            if (compareHlc(incHlc, curHlc) > 0) {
              mergedFieldHlc[col] = incHlc;
              return incomingVal;
            }
            mergedFieldHlc[col] = curHlc;
            return currentVal;
          };

          const incomingDeletedAt =
            payload.deleted_at != null ? String(payload.deleted_at) : null;
          let deletedAt = existing.deletedAt;
          if (outboxRow.operation === 'RESTORE') {
            deletedAt = resolveCol('deleted_at', existing.deletedAt, null);
          } else if (existing.deletedAt !== null && incomingDeletedAt !== null) {
            deletedAt =
              existing.deletedAt >= incomingDeletedAt
                ? existing.deletedAt
                : incomingDeletedAt;
            mergedFieldHlc.deleted_at = deletedAt;
          } else if (existing.deletedAt !== null || incomingDeletedAt !== null) {
            deletedAt = existing.deletedAt ?? incomingDeletedAt;
            if (deletedAt) mergedFieldHlc.deleted_at = deletedAt;
          }

          tx.update(installmentPlans)
            .set({
              ownerUserId: resolveCol(
                'owner_user_id',
                existing.ownerUserId,
                payload.owner_user_id != null
                  ? String(payload.owner_user_id)
                  : null,
              ),
              categoryId: resolveCol(
                'category_id',
                existing.categoryId,
                String(payload.category_id),
              ),
              description: resolveCol(
                'description',
                existing.description,
                String(payload.description),
              ),
              totalAmountCents: resolveCol(
                'total_amount_cents',
                existing.totalAmountCents,
                Number(payload.total_amount_cents),
              ),
              totalInstallments: resolveCol(
                'total_installments',
                existing.totalInstallments,
                Number(payload.total_installments),
              ),
              purchaseDate: resolveCol(
                'purchase_date',
                existing.purchaseDate,
                String(payload.purchase_date),
              ),
              updatedAt: String(payload.updated_at),
              deletedAt,
              hlcTimestamp:
                compareHlc(incomingHlc, existing.hlcTimestamp) > 0
                  ? incomingHlc
                  : existing.hlcTimestamp,
              fieldHlc: mergedFieldHlc,
              serverSeq: nextSeq,
            })
            .where(eq(installmentPlans.id, existing.id))
            .run();
        }
      } else if (outboxRow.tableName === 'recurring_rules') {
        const existing = tx
          .select()
          .from(recurringRules)
          .where(eq(recurringRules.id, outboxRow.recordId))
          .get();

        if (!existing) {
          tx.insert(recurringRules)
            .values({
              id: String(payload.id),
              householdId: String(payload.household_id),
              createdByUserId: String(payload.created_by_user_id),
              ownerUserId:
                payload.owner_user_id != null
                  ? String(payload.owner_user_id)
                  : null,
              type: payload.type as typeof recurringRules.$inferInsert.type,
              accountId:
                payload.account_id != null ? String(payload.account_id) : null,
              creditCardId:
                payload.credit_card_id != null
                  ? String(payload.credit_card_id)
                  : null,
              categoryId: String(payload.category_id),
              description: String(payload.description),
              amountCents: Number(payload.amount_cents),
              frequency:
                payload.frequency as typeof recurringRules.$inferInsert.frequency,
              dayOfMonth: Number(payload.day_of_month),
              startMonth: String(payload.start_month),
              endMonth:
                payload.end_month != null ? String(payload.end_month) : null,
              isActive: Boolean(payload.is_active ?? true),
              createdAt: String(payload.created_at),
              updatedAt: String(payload.updated_at),
              deletedAt:
                payload.deleted_at != null ? String(payload.deleted_at) : null,
              hlcTimestamp: incomingHlc,
              fieldHlc: incomingFieldHlc,
              serverSeq: nextSeq,
            })
            .run();
        } else {
          const mergedFieldHlc: FieldHlcMap = { ...existing.fieldHlc };
          const resolveCol = <T>(
            col: string,
            currentVal: T,
            incomingVal: T,
          ): T => {
            const curHlc = existing.fieldHlc[col] ?? existing.hlcTimestamp;
            const incHlc = incomingFieldHlc[col] ?? incomingHlc;
            if (compareHlc(incHlc, curHlc) > 0) {
              mergedFieldHlc[col] = incHlc;
              return incomingVal;
            }
            mergedFieldHlc[col] = curHlc;
            return currentVal;
          };

          const incomingDeletedAt =
            payload.deleted_at != null ? String(payload.deleted_at) : null;
          let deletedAt = existing.deletedAt;
          if (outboxRow.operation === 'RESTORE') {
            deletedAt = resolveCol('deleted_at', existing.deletedAt, null);
          } else if (existing.deletedAt !== null && incomingDeletedAt !== null) {
            deletedAt =
              existing.deletedAt >= incomingDeletedAt
                ? existing.deletedAt
                : incomingDeletedAt;
            mergedFieldHlc.deleted_at = deletedAt;
          } else if (existing.deletedAt !== null || incomingDeletedAt !== null) {
            deletedAt = existing.deletedAt ?? incomingDeletedAt;
            if (deletedAt) mergedFieldHlc.deleted_at = deletedAt;
          }

          tx.update(recurringRules)
            .set({
              ownerUserId: resolveCol(
                'owner_user_id',
                existing.ownerUserId,
                payload.owner_user_id != null
                  ? String(payload.owner_user_id)
                  : null,
              ),
              type: resolveCol(
                'type',
                existing.type,
                payload.type as typeof existing.type,
              ),
              accountId: resolveCol(
                'account_id',
                existing.accountId,
                payload.account_id != null ? String(payload.account_id) : null,
              ),
              creditCardId: resolveCol(
                'credit_card_id',
                existing.creditCardId,
                payload.credit_card_id != null
                  ? String(payload.credit_card_id)
                  : null,
              ),
              categoryId: resolveCol(
                'category_id',
                existing.categoryId,
                String(payload.category_id),
              ),
              description: resolveCol(
                'description',
                existing.description,
                String(payload.description),
              ),
              amountCents: resolveCol(
                'amount_cents',
                existing.amountCents,
                Number(payload.amount_cents),
              ),
              frequency: resolveCol(
                'frequency',
                existing.frequency,
                payload.frequency as typeof existing.frequency,
              ),
              dayOfMonth: resolveCol(
                'day_of_month',
                existing.dayOfMonth,
                Number(payload.day_of_month),
              ),
              startMonth: resolveCol(
                'start_month',
                existing.startMonth,
                String(payload.start_month),
              ),
              endMonth: resolveCol(
                'end_month',
                existing.endMonth,
                payload.end_month != null ? String(payload.end_month) : null,
              ),
              isActive: resolveCol(
                'is_active',
                existing.isActive,
                Boolean(payload.is_active ?? true),
              ),
              updatedAt: String(payload.updated_at),
              deletedAt,
              hlcTimestamp:
                compareHlc(incomingHlc, existing.hlcTimestamp) > 0
                  ? incomingHlc
                  : existing.hlcTimestamp,
              fieldHlc: mergedFieldHlc,
              serverSeq: nextSeq,
            })
            .where(eq(recurringRules.id, existing.id))
            .run();
        }
      } else if (outboxRow.tableName === 'transactions') {
        const existing = tx
          .select()
          .from(transactions)
          .where(eq(transactions.id, outboxRow.recordId))
          .get();

        if (!existing) {
          tx.insert(transactions)
            .values({
              id: String(payload.id),
              householdId: String(payload.household_id),
              createdByUserId: String(payload.created_by_user_id),
              ownerUserId:
                payload.owner_user_id != null
                  ? String(payload.owner_user_id)
                  : null,
              type: payload.type as typeof transactions.$inferInsert.type,
              status: payload.status as typeof transactions.$inferInsert.status,
              amountCents: Number(payload.amount_cents),
              transactionDate: String(payload.transaction_date),
              competenceMonth: String(payload.competence_month),
              description: String(payload.description),
              notes: payload.notes != null ? String(payload.notes) : null,
              accountId:
                payload.account_id != null ? String(payload.account_id) : null,
              transferAccountId:
                payload.transfer_account_id != null
                  ? String(payload.transfer_account_id)
                  : null,
              creditCardId:
                payload.credit_card_id != null
                  ? String(payload.credit_card_id)
                  : null,
              invoiceId:
                payload.invoice_id != null ? String(payload.invoice_id) : null,
              categoryId:
                payload.category_id != null
                  ? String(payload.category_id)
                  : null,
              installmentPlanId:
                payload.installment_plan_id != null
                  ? String(payload.installment_plan_id)
                  : null,
              installmentNumber:
                payload.installment_number != null
                  ? Number(payload.installment_number)
                  : null,
              totalInstallments:
                payload.total_installments != null
                  ? Number(payload.total_installments)
                  : null,
              recurringRuleId:
                payload.recurring_rule_id != null
                  ? String(payload.recurring_rule_id)
                  : null,
              refundedTransactionId:
                payload.refunded_transaction_id != null
                  ? String(payload.refunded_transaction_id)
                  : null,
              isHouseholdContribution: Boolean(
                payload.is_household_contribution ?? false,
              ),
              calendarEventId:
                payload.calendar_event_id != null
                  ? String(payload.calendar_event_id)
                  : null,
              createdAt: String(payload.created_at),
              updatedAt: String(payload.updated_at),
              deletedAt:
                payload.deleted_at != null ? String(payload.deleted_at) : null,
              hlcTimestamp: incomingHlc,
              fieldHlc: incomingFieldHlc,
              serverSeq: nextSeq,
            })
            .run();
        } else {
          const mergedFieldHlc: FieldHlcMap = { ...existing.fieldHlc };
          const resolveCol = <T>(
            col: string,
            currentVal: T,
            incomingVal: T,
          ): T => {
            const curHlc = existing.fieldHlc[col] ?? existing.hlcTimestamp;
            const incHlc = incomingFieldHlc[col] ?? incomingHlc;
            if (compareHlc(incHlc, curHlc) > 0) {
              mergedFieldHlc[col] = incHlc;
              return incomingVal;
            }
            mergedFieldHlc[col] = curHlc;
            return currentVal;
          };

          const incomingDeletedAt =
            payload.deleted_at != null ? String(payload.deleted_at) : null;
          let deletedAt = existing.deletedAt;
          if (outboxRow.operation === 'RESTORE') {
            deletedAt = resolveCol('deleted_at', existing.deletedAt, null);
          } else if (existing.deletedAt !== null && incomingDeletedAt !== null) {
            deletedAt =
              existing.deletedAt >= incomingDeletedAt
                ? existing.deletedAt
                : incomingDeletedAt;
            mergedFieldHlc.deleted_at = deletedAt;
          } else if (existing.deletedAt !== null || incomingDeletedAt !== null) {
            deletedAt = existing.deletedAt ?? incomingDeletedAt;
            if (deletedAt) mergedFieldHlc.deleted_at = deletedAt;
          }

          tx.update(transactions)
            .set({
              ownerUserId: resolveCol(
                'owner_user_id',
                existing.ownerUserId,
                payload.owner_user_id != null
                  ? String(payload.owner_user_id)
                  : null,
              ),
              status: resolveCol(
                'status',
                existing.status,
                payload.status as typeof existing.status,
              ),
              amountCents: resolveCol(
                'amount_cents',
                existing.amountCents,
                Number(payload.amount_cents),
              ),
              transactionDate: resolveCol(
                'transaction_date',
                existing.transactionDate,
                String(payload.transaction_date),
              ),
              competenceMonth: resolveCol(
                'competence_month',
                existing.competenceMonth,
                String(payload.competence_month),
              ),
              description: resolveCol(
                'description',
                existing.description,
                String(payload.description),
              ),
              notes: resolveCol(
                'notes',
                existing.notes,
                payload.notes != null ? String(payload.notes) : null,
              ),
              accountId: resolveCol(
                'account_id',
                existing.accountId,
                payload.account_id != null ? String(payload.account_id) : null,
              ),
              transferAccountId: resolveCol(
                'transfer_account_id',
                existing.transferAccountId,
                payload.transfer_account_id != null
                  ? String(payload.transfer_account_id)
                  : null,
              ),
              categoryId: resolveCol(
                'category_id',
                existing.categoryId,
                payload.category_id != null
                  ? String(payload.category_id)
                  : null,
              ),
              isHouseholdContribution: resolveCol(
                'is_household_contribution',
                existing.isHouseholdContribution,
                Boolean(payload.is_household_contribution ?? false),
              ),
              updatedAt: String(payload.updated_at),
              deletedAt,
              hlcTimestamp:
                compareHlc(incomingHlc, existing.hlcTimestamp) > 0
                  ? incomingHlc
                  : existing.hlcTimestamp,
              fieldHlc: mergedFieldHlc,
              serverSeq: nextSeq,
            })
            .where(eq(transactions.id, existing.id))
            .run();
        }
      }
    }

    setSyncMetaValue(tx, SYNC_META_KEYS.HLC_STATE, JSON.stringify(hlcState));
    setSyncMetaValue(tx, SYNC_META_KEYS.LAST_SERVER_SEQ, String(nextSeq));
  });

  // Acknowledge pushed mutations on sourceDb and update its cursor
  sourceDb.transaction((tx) => {
    for (const row of sortedRows) {
      tx.delete(syncOutbox).where(eq(syncOutbox.seqId, row.seqId)).run();
    }
    setSyncMetaValue(tx, SYNC_META_KEYS.LAST_SERVER_SEQ, String(nextSeq));
  });

  const appliedTables = Array.from(touchedTables);
  for (const table of appliedTables) {
    notifyDatabaseChange(table);
  }

  return {
    pushedCount: sortedRows.length,
    appliedTables,
    lastServerSeq: nextSeq,
  };
}
