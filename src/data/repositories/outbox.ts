import { and, asc, eq } from 'drizzle-orm';
import {
  computeCorrectedNowMs,
  type FieldHlcMap,
  type HlcState,
  nextLocalHlc,
} from '@/core';
import { type AppDatabase, type DbExecutor, notifyDatabaseChange } from '../db';
import {
  type OutboxOperation,
  SYNC_META_KEYS,
  type SyncableTableName,
  syncOutbox,
  type SyncOutboxRow,
  TOPOLOGICAL_TABLE_PRIORITY,
} from '../schema';
import {
  applyRemoteChanges,
  type RemoteChange,
} from './applyRemote';
import { getSyncMetaValue, setSyncMetaValue } from './syncMetaStore';

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

export { getSyncMetaValue, setSyncMetaValue };

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

/**
 * Orders outbox rows for FK-safe replay: table priority first, root categories before
 * child categories, then queue order (`seq_id`).
 */
export function sortOutboxRowsTopologically<T extends SyncOutboxRow>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
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
}

/**
 * Converts an outbox row into the wire/peer change shape consumed by `applyRemoteChange`.
 */
export function outboxRowToRemoteChange(row: SyncOutboxRow): RemoteChange {
  return {
    tableName: row.tableName,
    recordId: row.recordId,
    operation: row.operation,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    fieldHlc: JSON.parse(row.fieldHlcJson) as FieldHlcMap,
    hlcTimestamp: row.hlcTimestamp,
  };
}

export interface PeerSyncSummary {
  pushedCount: number;
  appliedTables: SyncableTableName[];
  lastServerSeq: number;
}

/**
 * Reconciles pending offline mutations from `sourceDb.sync_outbox` into `targetDb`
 * in strict FK topological order (`accounts` -> `categories` root -> `categories` child -> `transactions`),
 * applying HLC field-level LWW and Tombstone Precedence (`deleted_at`) through `applyRemoteChanges`,
 * advancing `HLC_STATE` and `LAST_SERVER_SEQ`, and clearing reconciled `PENDING` outbox rows on `sourceDb`.
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

  const readCursor = (): number =>
    Number(getSyncMetaValue(targetDb, SYNC_META_KEYS.LAST_SERVER_SEQ) ?? '0') ||
    0;

  if (pendingRows.length === 0) {
    return { pushedCount: 0, appliedTables: [], lastServerSeq: readCursor() };
  }

  const sortedRows = sortOutboxRowsTopologically(pendingRows);
  let nextSeq = readCursor();
  const envelopes = sortedRows.map((row) => ({
    change: outboxRowToRemoteChange(row),
    serverSeq: ++nextSeq,
  }));

  let appliedTables: SyncableTableName[] = [];
  targetDb.transaction((tx) => {
    appliedTables = applyRemoteChanges(tx, envelopes, {
      nowMs: options.nowMs,
    });
    setSyncMetaValue(tx, SYNC_META_KEYS.LAST_SERVER_SEQ, String(nextSeq));
  });

  // Acknowledge pushed mutations on sourceDb and update its cursor
  sourceDb.transaction((tx) => {
    for (const row of sortedRows) {
      tx.delete(syncOutbox).where(eq(syncOutbox.seqId, row.seqId)).run();
    }
    setSyncMetaValue(tx, SYNC_META_KEYS.LAST_SERVER_SEQ, String(nextSeq));
  });

  for (const table of appliedTables) {
    notifyDatabaseChange(table);
  }

  return {
    pushedCount: sortedRows.length,
    appliedTables,
    lastServerSeq: nextSeq,
  };
}
