import { type FieldHlcMap, isValidHlc } from '@/core';
import type { RemoteChange } from '@/data/repositories/applyRemote';
import type { SyncOutboxRow } from '@/data/schema';
import type { WireChange, WireMutation } from './syncGateway';

/** Length of the ISO-8601 prefix of a canonical HLC (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
const HLC_ISO_LENGTH = 24;
const ZERO_HLC_SUFFIX = '-0000-000000000000';

/**
 * Locally `deleted_at` is the delete HLC; on the server it is a timestamptz.
 * The wall-clock prefix of the HLC is a valid timestamptz literal.
 */
export function deletedAtToWire(localDeletedAt: unknown): string | null {
  if (localDeletedAt == null) return null;
  const value = String(localDeletedAt);
  return isValidHlc(value) ? value.slice(0, HLC_ISO_LENGTH) : value;
}

/**
 * Restores the local tombstone representation (a canonical HLC) from a server row.
 */
export function deletedAtFromWire(
  serverDeletedAt: string | null,
  fieldHlc: FieldHlcMap,
): string | null {
  if (serverDeletedAt == null) return null;
  const recorded = fieldHlc.deleted_at;
  if (recorded && isValidHlc(recorded)) return recorded;
  return `${new Date(serverDeletedAt).toISOString()}${ZERO_HLC_SUFFIX}`;
}

function normalizeTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

/**
 * Serializes an outbox row for `sync_push_batch`.
 */
export function outboxRowToWireMutation(row: SyncOutboxRow): WireMutation {
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  payload.deleted_at = deletedAtToWire(payload.deleted_at);
  return {
    mutation_id: row.mutationId,
    batch_id: row.batchId,
    table_name: row.tableName,
    record_id: row.recordId,
    operation: row.operation,
    payload,
    field_hlc: JSON.parse(row.fieldHlcJson) as Record<string, string>,
    hlc_timestamp: row.hlcTimestamp,
  };
}

/**
 * Normalizes a `sync_pull_changes` item into the shape `applyRemoteChange` expects:
 * ISO timestamps with `Z`, and `deleted_at` expressed as the delete HLC.
 */
export function wireChangeToRemoteChange(change: WireChange): RemoteChange {
  const fieldHlc = { ...(change.field_hlc ?? {}) } as FieldHlcMap;
  const payload: Record<string, unknown> = { ...change.payload };
  payload.created_at = normalizeTimestamp(payload.created_at);
  payload.updated_at = normalizeTimestamp(payload.updated_at);
  payload.deleted_at = deletedAtFromWire(change.deleted_at, fieldHlc);

  return {
    tableName: change.table_name,
    recordId: change.record_id,
    operation: change.operation,
    payload,
    fieldHlc,
    hlcTimestamp: change.hlc_timestamp,
  };
}
