import { asc, eq, inArray } from 'drizzle-orm';
import {
  type AppDatabase,
  enqueueOrCoalesceOutbox,
  syncOutbox,
  type SyncOutboxRow,
} from '@/data';
import { sortOutboxTopologically } from './topoSort';

/**
 * Local coalescing (merge of same-record PENDING mutations) lives in the repository layer
 * and runs inside every domain write transaction; re-exported for engine consumers.
 */
export { enqueueOrCoalesceOutbox };

/** Server contract: `sync_push_batch` accepts at most 100 mutations per call. */
export const MAX_PUSH_BATCH_SIZE = 100;

export interface OutboxCounts {
  pending: number;
  inFlight: number;
  failedPermanent: number;
}

/**
 * Selects the next push batch: all `PENDING` rows in FK topological order, capped at `limit`.
 * Sorting happens before slicing so parents never land in a later batch than their dependants.
 */
export function selectPendingBatch(
  db: AppDatabase,
  limit: number = MAX_PUSH_BATCH_SIZE,
): SyncOutboxRow[] {
  const pending = db
    .select()
    .from(syncOutbox)
    .where(eq(syncOutbox.status, 'PENDING'))
    .orderBy(asc(syncOutbox.seqId))
    .all();
  return sortOutboxTopologically(pending).slice(0, limit);
}

/**
 * Atomically claims the batch by flipping it to `IN_FLIGHT`.
 */
export function markOutboxInFlight(
  db: AppDatabase,
  rows: readonly SyncOutboxRow[],
): void {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    tx.update(syncOutbox)
      .set({ status: 'IN_FLIGHT' })
      .where(
        inArray(
          syncOutbox.seqId,
          rows.map((r) => r.seqId),
        ),
      )
      .run();
  });
}

/**
 * Acknowledges pushed mutations by removing them from the outbox
 * (the outbox is a transient queue, not a domain table).
 */
export function ackOutboxRows(
  db: AppDatabase,
  rows: readonly SyncOutboxRow[],
): void {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    tx.delete(syncOutbox)
      .where(
        inArray(
          syncOutbox.seqId,
          rows.map((r) => r.seqId),
        ),
      )
      .run();
  });
}

/**
 * Returns claimed rows to `PENDING`; rows that exhausted `maxRetries` become `FAILED_PERMANENT`.
 */
export function releaseOutboxRows(
  db: AppDatabase,
  rows: readonly SyncOutboxRow[],
  options: { error: string; countRetry: boolean; maxRetries: number },
): void {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    for (const row of rows) {
      const retryCount = row.retryCount + (options.countRetry ? 1 : 0);
      tx.update(syncOutbox)
        .set({
          status:
            options.countRetry && retryCount >= options.maxRetries
              ? 'FAILED_PERMANENT'
              : 'PENDING',
          retryCount,
          lastError: options.error,
        })
        .where(eq(syncOutbox.seqId, row.seqId))
        .run();
    }
  });
}

/**
 * Parks rows the server will never accept (`FAILED_PERMANENT`), keeping them for diagnostics.
 */
export function failOutboxRowsPermanently(
  db: AppDatabase,
  rows: readonly SyncOutboxRow[],
  error: string,
): void {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    for (const row of rows) {
      tx.update(syncOutbox)
        .set({
          status: 'FAILED_PERMANENT',
          retryCount: row.retryCount + 1,
          lastError: error,
        })
        .where(eq(syncOutbox.seqId, row.seqId))
        .run();
    }
  });
}

/**
 * Crash recovery: anything left `IN_FLIGHT` by a previous process is re-queued as `PENDING`.
 * Safe because the server de-duplicates by `mutation_id`.
 */
export function resetInFlightToPending(db: AppDatabase): number {
  const stuck = db
    .select()
    .from(syncOutbox)
    .where(eq(syncOutbox.status, 'IN_FLIGHT'))
    .all();
  if (stuck.length === 0) return 0;
  db.transaction((tx) => {
    tx.update(syncOutbox)
      .set({ status: 'PENDING' })
      .where(eq(syncOutbox.status, 'IN_FLIGHT'))
      .run();
  });
  return stuck.length;
}

export function countOutbox(db: AppDatabase): OutboxCounts {
  const rows = db.select({ status: syncOutbox.status }).from(syncOutbox).all();
  const counts: OutboxCounts = { pending: 0, inFlight: 0, failedPermanent: 0 };
  for (const { status } of rows) {
    if (status === 'PENDING') counts.pending += 1;
    else if (status === 'IN_FLIGHT') counts.inFlight += 1;
    else counts.failedPermanent += 1;
  }
  return counts;
}
