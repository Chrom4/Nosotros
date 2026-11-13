import { useEffect } from 'react';
import { getActiveDatabase } from '@/data';
import { useSessionUIStore } from '@/store/sessionUI';
import { logger } from '@/utils/logger';
import { startSyncEngine, stopSyncEngine } from './syncEngine';

/**
 * Runs the sync engine while the user is authenticated, the vault is open and a
 * household is active; stops it (and clears the indicator) otherwise.
 */
export function useSyncEngineLifecycle(): void {
  const authStatus = useSessionUIStore((s) => s.authStatus);
  const dbReady = useSessionUIStore((s) => s.dbReady);
  const isSyncHalted = useSessionUIStore((s) => s.isSyncHalted);
  const householdId = useSessionUIStore((s) => s.activeHouseholdId);

  useEffect(() => {
    if (authStatus !== 'AUTHENTICATED' || !dbReady || !householdId || isSyncHalted) {
      return;
    }
    const db = getActiveDatabase();
    if (!db) return;

    let cancelled = false;
    startSyncEngine({ db, householdId }).catch((err: unknown) => {
      if (!cancelled) {
        logger.warn('sync engine failed to start', {
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    });

    return () => {
      cancelled = true;
      stopSyncEngine();
    };
  }, [authStatus, dbReady, householdId, isSyncHalted]);
}
