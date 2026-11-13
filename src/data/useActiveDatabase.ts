import { useSessionUIStore } from '@/store/sessionUI';
import { type AppDatabase, getActiveDatabase } from './db';

/**
 * Reactive handle for the encrypted local DB.
 * Subscribes to `dbReady` so screens remount/re-render after `ensureLocalSessionReady`.
 */
export function useActiveDatabase(
  propDb?: AppDatabase | null,
): AppDatabase | null {
  const dbReady = useSessionUIStore((s) => s.dbReady);
  if (propDb !== undefined && propDb !== null) {
    return propDb;
  }
  if (propDb === null) {
    return null;
  }
  if (!dbReady) {
    return null;
  }
  return getActiveDatabase();
}
