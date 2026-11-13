import { compareHlc, type FieldHlcMap } from '@/core';
import type { SyncableTableName } from '@/data/schema';
import {
  SyncError,
  type PullChangesRequest,
  type PullChangesResult,
  type PushBatchRequest,
  type PushBatchResult,
  type SyncBackendGateway,
  type WireChange,
  type WireMutation,
} from '@/sync/syncGateway';

interface StoredRow {
  tableName: SyncableTableName;
  recordId: string;
  payload: Record<string, unknown>;
  fieldHlc: FieldHlcMap;
  hlcTimestamp: string;
  deletedAt: string | null;
  serverSeq: number;
  operation: WireMutation['operation'];
}

/**
 * In-memory stand-in for Supabase `sync_push_batch` / `sync_pull_changes`.
 * Implements field-level HLC merge, tombstone precedence and mutation idempotency.
 */
export function createMemorySyncServer(options: {
  householdId: string;
  syncEpoch?: number;
}): SyncBackendGateway & {
  getEpoch: () => number;
  setEpoch: (epoch: number) => void;
  processedCount: () => number;
} {
  let syncEpoch = options.syncEpoch ?? 1;
  let nextSeq = 0;
  const rows = new Map<string, StoredRow>();
  const processed = new Set<string>();

  const keyOf = (table: string, id: string) => `${table}:${id}`;

  function mergeMutation(mutation: WireMutation): number {
    const key = keyOf(mutation.table_name, mutation.record_id);
    const existing = rows.get(key);
    const incomingFieldHlc = mutation.field_hlc as FieldHlcMap;
    const incomingDeleted =
      mutation.payload.deleted_at != null
        ? String(mutation.payload.deleted_at)
        : null;

    if (!existing) {
      nextSeq += 1;
      rows.set(key, {
        tableName: mutation.table_name,
        recordId: mutation.record_id,
        payload: { ...mutation.payload },
        fieldHlc: { ...incomingFieldHlc },
        hlcTimestamp: mutation.hlc_timestamp,
        deletedAt: incomingDeleted,
        serverSeq: nextSeq,
        operation: mutation.operation,
      });
      return nextSeq;
    }

    const mergedPayload = { ...existing.payload };
    const mergedFieldHlc = { ...existing.fieldHlc };
    for (const [col, hlc] of Object.entries(incomingFieldHlc)) {
      if (col === 'deleted_at') continue;
      const current = existing.fieldHlc[col] ?? existing.hlcTimestamp;
      if (compareHlc(hlc, current) > 0) {
        mergedPayload[col] = mutation.payload[col];
        mergedFieldHlc[col] = hlc;
      }
    }

    let deletedAt = existing.deletedAt;
    const incomingDelHlc =
      incomingFieldHlc.deleted_at ?? mutation.hlc_timestamp;
    const currentDelHlc =
      existing.fieldHlc.deleted_at ?? existing.hlcTimestamp;

    if (mutation.operation === 'RESTORE') {
      if (
        existing.deletedAt !== null &&
        compareHlc(incomingDelHlc, currentDelHlc) > 0
      ) {
        deletedAt = null;
        mergedFieldHlc.deleted_at = incomingDelHlc;
        mergedPayload.deleted_at = null;
      }
    } else if (incomingDeleted !== null) {
      if (
        existing.deletedAt === null ||
        compareHlc(incomingDelHlc, currentDelHlc) > 0
      ) {
        deletedAt = incomingDeleted;
        mergedFieldHlc.deleted_at = incomingDelHlc;
        mergedPayload.deleted_at = incomingDeleted;
      }
    }

    nextSeq += 1;
    rows.set(key, {
      ...existing,
      payload: mergedPayload,
      fieldHlc: mergedFieldHlc,
      hlcTimestamp:
        compareHlc(mutation.hlc_timestamp, existing.hlcTimestamp) > 0
          ? mutation.hlc_timestamp
          : existing.hlcTimestamp,
      deletedAt,
      serverSeq: nextSeq,
      operation: mutation.operation,
    });
    return nextSeq;
  }

  return {
    getEpoch: () => syncEpoch,
    setEpoch: (epoch) => {
      syncEpoch = epoch;
    },
    processedCount: () => processed.size,

    async pushBatch(request: PushBatchRequest): Promise<PushBatchResult> {
      if (request.householdId !== options.householdId) {
        throw new SyncError('AUTH', 'FORBIDDEN: household mismatch');
      }
      if (request.syncEpoch !== syncEpoch) {
        throw new SyncError(
          'EPOCH_MISMATCH',
          `EPOCH_MISMATCH: expected ${syncEpoch}`,
        );
      }
      if (request.mutations.length > 100) {
        throw new SyncError('PERMANENT', 'BATCH_TOO_LARGE');
      }

      let accepted = 0;
      let skipped = 0;
      let serverSeqMax = 0;

      for (const mutation of request.mutations) {
        if (processed.has(mutation.mutation_id)) {
          skipped += 1;
          continue;
        }
        serverSeqMax = Math.max(serverSeqMax, mergeMutation(mutation));
        processed.add(mutation.mutation_id);
        accepted += 1;
      }

      return { accepted, skippedIdempotent: skipped, serverSeqMax };
    },

    async pullChanges(request: PullChangesRequest): Promise<PullChangesResult> {
      if (request.householdId !== options.householdId) {
        throw new SyncError('AUTH', 'FORBIDDEN: household mismatch');
      }
      const all = Array.from(rows.values())
        .filter((r) => r.serverSeq > request.lastServerSeq)
        .sort((a, b) => a.serverSeq - b.serverSeq);
      const limit = request.limit;
      const slice = all.slice(0, limit);
      const changes: WireChange[] = slice.map((r) => ({
        table_name: r.tableName,
        record_id: r.recordId,
        server_seq: r.serverSeq,
        operation: r.operation,
        payload: r.payload,
        field_hlc: r.fieldHlc,
        hlc_timestamp: r.hlcTimestamp,
        deleted_at:
          r.deletedAt && r.deletedAt.length >= 24
            ? r.deletedAt.slice(0, 24)
            : r.deletedAt,
      }));
      return {
        syncEpoch,
        changes,
        hasMore: all.length > limit,
      };
    },
  };
}
