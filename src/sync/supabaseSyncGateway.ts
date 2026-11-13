import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '@/auth/supabaseClient';
import {
  classifyRpcError,
  type PullChangesRequest,
  type PullChangesResult,
  type PushBatchRequest,
  type PushBatchResult,
  SyncError,
  type SyncBackendGateway,
  type WireChange,
} from './syncGateway';

interface PushRpcResponse {
  accepted?: number;
  skipped_idempotent?: number;
  server_seq_max?: number;
}

interface PullRpcResponse {
  sync_epoch?: number;
  changes?: WireChange[];
  has_more?: boolean;
}

/**
 * Supabase-backed gateway. Remote sync goes exclusively through the
 * `sync_push_batch` and `sync_pull_changes` RPCs (no direct table access).
 */
export function createSupabaseSyncGateway(
  getClient: () => SupabaseClient = getSupabaseClient,
): SyncBackendGateway {
  return {
    async pushBatch(request: PushBatchRequest): Promise<PushBatchResult> {
      let result;
      try {
        result = await getClient().rpc('sync_push_batch', {
          p_household_id: request.householdId,
          p_sync_epoch: request.syncEpoch,
          p_mutations: request.mutations,
        });
      } catch (err) {
        throw new SyncError(
          'NETWORK',
          err instanceof Error ? err.message : 'Network request failed',
        );
      }
      if (result.error) {
        throw classifyRpcError(result.error);
      }
      const data = (result.data ?? {}) as PushRpcResponse;
      return {
        accepted: data.accepted ?? 0,
        skippedIdempotent: data.skipped_idempotent ?? 0,
        serverSeqMax: Number(data.server_seq_max ?? 0),
      };
    },

    async pullChanges(request: PullChangesRequest): Promise<PullChangesResult> {
      let result;
      try {
        result = await getClient().rpc('sync_pull_changes', {
          p_household_id: request.householdId,
          p_last_server_seq: request.lastServerSeq,
          p_limit: request.limit,
        });
      } catch (err) {
        throw new SyncError(
          'NETWORK',
          err instanceof Error ? err.message : 'Network request failed',
        );
      }
      if (result.error) {
        throw classifyRpcError(result.error);
      }
      const data = (result.data ?? {}) as PullRpcResponse;
      if (typeof data.sync_epoch !== 'number') {
        throw new SyncError('TRANSIENT', 'Malformed sync_pull_changes response');
      }
      return {
        syncEpoch: data.sync_epoch,
        changes: (data.changes ?? []).map((c) => ({
          ...c,
          server_seq: Number(c.server_seq),
        })),
        hasMore: Boolean(data.has_more),
      };
    },
  };
}
