import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../db';
import { syncMeta } from '../schema';

/**
 * Reads a `sync_meta` value (`null` when the key does not exist).
 */
export function getSyncMetaValue(tx: DbExecutor, key: string): string | null {
  const row = tx.select().from(syncMeta).where(eq(syncMeta.key, key)).get();
  return row ? row.value : null;
}

/**
 * Upserts a `sync_meta` key/value pair.
 */
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
