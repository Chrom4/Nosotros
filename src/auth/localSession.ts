import {
  type AppDatabase,
  findLocalMembershipForUser,
  getOrCreateDeviceNodeId,
  type KeyStoreAdapter,
  openEncryptedDatabase,
  setSyncMetaValue,
  SYNC_META_KEYS,
} from '@/data';
import type { HouseholdMemberRole } from '@/data/schema';
import {
  loadPersistedHouseholdContext,
  persistHouseholdContext,
} from '@/store/householdPersistence';
import { useSessionUIStore } from '@/store/sessionUI';
import { syncHouseholdMembers } from '@/sync/membershipSync';
import { logger } from '@/utils/logger';
import {
  getOnboardingGateway,
  type OnboardingBackendGateway,
} from './onboardingService';

export interface EnsureLocalSessionReadyOptions {
  gateway?: OnboardingBackendGateway;
  keyStoreAdapter?: KeyStoreAdapter;
  dbName?: string;
  /** When true, skip remote membership fetch (offline-only hydration). */
  offlineOnly?: boolean;
}

export interface LocalSessionReadyResult {
  db: AppDatabase;
  householdId: string | null;
  memberRole: HouseholdMemberRole | null;
}

/**
 * Opens SQLCipher, ensures HLC `device_node_id` in `sync_meta`, hydrates
 * household context from SecureStore / local SQLite (offline fallback), then
 * optionally refreshes membership when online. Marks `dbReady` on success.
 */
export async function ensureLocalSessionReady(
  options: EnsureLocalSessionReadyOptions = {},
): Promise<LocalSessionReadyResult> {
  const store = useSessionUIStore.getState();
  store.setDbStatus({ ready: false, error: null });

  try {
    const { db } = await openEncryptedDatabase(
      options.dbName,
      options.keyStoreAdapter,
    );

    const nodeId = await getOrCreateDeviceNodeId(options.keyStoreAdapter);
    setSyncMetaValue(db, SYNC_META_KEYS.DEVICE_NODE_ID, nodeId);

    const persisted = await loadPersistedHouseholdContext();
    let householdId =
      store.activeHouseholdId ?? persisted.householdId ?? null;
    let memberRole = store.memberRole ?? persisted.memberRole ?? null;

    if (store.userId) {
      const localMembership = findLocalMembershipForUser(db, store.userId);
      if (localMembership) {
        if (!householdId) {
          householdId = localMembership.householdId;
        }
        if (!memberRole) {
          memberRole = localMembership.role;
        }
      }
    }

    if (!options.offlineOnly) {
      const gateway = options.gateway ?? getOnboardingGateway();
      try {
        const membership = await gateway.fetchActiveMembership();
        if (membership) {
          householdId = membership.householdId;
          memberRole = membership.role;
        }
      } catch {
        // Offline / transient: keep SecureStore + SQLite hydration
      }

      if (householdId) {
        try {
          await syncHouseholdMembers(db, householdId);
        } catch (err) {
          logger.warn('membership sync skipped during session ready', {
            reason: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    }

    store.setHouseholdContext(householdId, memberRole);
    await persistHouseholdContext(householdId, memberRole);
    store.setDbStatus({ ready: true, error: null });

    return { db, householdId, memberRole };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Falha ao abrir o cofre criptografado local.';
    store.setDbStatus({ ready: false, error: message });
    logger.warn('ensureLocalSessionReady failed', { reason: message });
    throw err instanceof Error ? err : new Error(message);
  }
}

/**
 * Clears dbReady / household persistence after crypto-shred or sign-out.
 */
export async function resetLocalSessionState(): Promise<void> {
  const store = useSessionUIStore.getState();
  store.setDbStatus({ ready: false, error: null });
  store.setHouseholdContext(null, null);
  await persistHouseholdContext(null, null);
}
