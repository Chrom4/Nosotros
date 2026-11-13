import {
  sortOutboxRowsTopologically,
  type SyncOutboxRow,
  TOPOLOGICAL_TABLE_PRIORITY,
} from '@/data';

export { TOPOLOGICAL_TABLE_PRIORITY };

/**
 * Orders outbox rows so FK parents are always pushed before dependants
 * (accounts -> categories root -> categories child -> cards -> ... -> transactions).
 * Uses the exact priority table shared with the local peer reconcile.
 */
export function sortOutboxTopologically<T extends SyncOutboxRow>(
  rows: readonly T[],
): T[] {
  return sortOutboxRowsTopologically(rows);
}
