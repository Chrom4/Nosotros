import type { OutboxOperation, SyncableTableName } from '@/data/schema';

/**
 * Failure classes the engine reacts to differently.
 * - `EPOCH_MISMATCH`: household epoch changed (backup restore); surface, never auto-recover.
 * - `AUTH`: unauthenticated or revoked; surface and stop retrying.
 * - `NETWORK`: transport failure; outbox returns to PENDING without consuming a retry.
 * - `PERMANENT`: server rejected the data (constraint/validation); never succeeds on retry.
 * - `TRANSIENT`: any other server failure; bounded retries.
 */
export type SyncErrorCode =
  | 'EPOCH_MISMATCH'
  | 'AUTH'
  | 'NETWORK'
  | 'PERMANENT'
  | 'TRANSIENT';

export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

/** One outbox mutation in `sync_push_batch` wire shape (snake_case). */
export interface WireMutation {
  mutation_id: string;
  batch_id: string;
  table_name: SyncableTableName;
  record_id: string;
  operation: OutboxOperation;
  payload: Record<string, unknown>;
  field_hlc: Record<string, string>;
  hlc_timestamp: string;
}

/** One row change returned by `sync_pull_changes`. */
export interface WireChange {
  table_name: SyncableTableName;
  record_id: string;
  server_seq: number;
  operation: OutboxOperation;
  payload: Record<string, unknown>;
  field_hlc: Record<string, string>;
  hlc_timestamp: string;
  deleted_at: string | null;
}

export interface PushBatchRequest {
  householdId: string;
  syncEpoch: number;
  mutations: WireMutation[];
}

export interface PushBatchResult {
  accepted: number;
  skippedIdempotent: number;
  serverSeqMax: number;
}

export interface PullChangesRequest {
  householdId: string;
  lastServerSeq: number;
  limit: number;
}

export interface PullChangesResult {
  syncEpoch: number;
  changes: WireChange[];
  hasMore: boolean;
}

/**
 * Remote sync boundary. Production uses the Supabase RPCs `sync_push_batch` and
 * `sync_pull_changes` exclusively; tests inject in-memory/PGlite implementations.
 * Implementations must throw `SyncError` for every failure.
 */
export interface SyncBackendGateway {
  pushBatch(request: PushBatchRequest): Promise<PushBatchResult>;
  pullChanges(request: PullChangesRequest): Promise<PullChangesResult>;
}

/**
 * Maps a PostgREST/Postgres error to a `SyncError`. Never includes request payloads.
 */
export function classifyRpcError(error: {
  message?: string;
  code?: string;
}): SyncError {
  const message = error.message ?? 'Unknown sync error';
  const code = error.code ?? '';

  if (message.includes('EPOCH_MISMATCH')) {
    return new SyncError('EPOCH_MISMATCH', message);
  }
  if (
    message.includes('UNAUTHENTICATED') ||
    message.includes('FORBIDDEN') ||
    code === '42501' ||
    code === 'PGRST301'
  ) {
    return new SyncError('AUTH', message);
  }
  if (
    message.includes('INVALID_MUTATION') ||
    message.includes('BATCH_TOO_LARGE') ||
    code.startsWith('22') ||
    code.startsWith('23')
  ) {
    return new SyncError('PERMANENT', message);
  }
  if (
    /network request failed|failed to fetch|fetch failed|timeout|timed out|offline/i.test(
      message,
    )
  ) {
    return new SyncError('NETWORK', message);
  }
  return new SyncError('TRANSIENT', message);
}
