/**
 * @jest-environment node
 */
import { resetLocalSessionState } from '@/auth/localSession';
import {
  DEVICE_NODE_ID_STORAGE_KEY,
  getOrCreateDeviceNodeId,
  getOrCreateSqlCipherKeyHex,
  getSyncMetaValue,
  type KeyStoreAdapter,
  setSyncMetaValue,
  SQLCIPHER_KEY_STORAGE_KEY,
  SYNC_META_KEYS,
  upsertLocalHousehold,
  upsertLocalHouseholdMember,
} from '@/data';
import { findLocalMembershipForUser } from '@/data/repositories/householdRepository';
import { useSessionUIStore } from '@/store/sessionUI';
import { createInMemoryTestDb } from '../data/testDbHelper';

function createMemoryKeyStoreAdapter(): KeyStoreAdapter & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  let seed = 42;
  return {
    store,
    async getItemAsync(key: string) {
      return store.get(key) ?? null;
    },
    async setItemAsync(key: string, value: string) {
      store.set(key, value);
    },
    async deleteItemAsync(key: string) {
      store.delete(key);
    },
    getRandomBytes(byteCount: number) {
      const bytes = new Uint8Array(byteCount);
      for (let i = 0; i < byteCount; i++) {
        seed = (seed * 1103515245 + 12345) & 0xffffffff;
        bytes[i] = (seed >>> 16) & 0xff;
      }
      return bytes;
    },
  };
}

describe('local session building blocks', () => {
  beforeEach(() => {
    useSessionUIStore.getState().resetSessionUI();
  });

  it('hydrates membership from local SQLite for offline fallback', () => {
    const { db, close } = createInMemoryTestDb();
    upsertLocalHousehold(db, { id: 'hh-local', name: 'Casa Local' });
    upsertLocalHouseholdMember(db, {
      id: 'mem-1',
      householdId: 'hh-local',
      userId: 'user-1',
      displayName: 'Founder',
      role: 'FOUNDER',
      colorHex: '#4F46E5',
    });

    const membership = findLocalMembershipForUser(db, 'user-1');
    expect(membership?.householdId).toBe('hh-local');
    expect(membership?.role).toBe('FOUNDER');
    close();
  });

  it('stores HLC device_node_id in sync_meta', () => {
    const { db, close } = createInMemoryTestDb();
    setSyncMetaValue(db, SYNC_META_KEYS.DEVICE_NODE_ID, 'abcdef123456');
    expect(getSyncMetaValue(db, SYNC_META_KEYS.DEVICE_NODE_ID)).toBe(
      'abcdef123456',
    );
    close();
  });

  it('resetLocalSessionState clears dbReady and household', async () => {
    useSessionUIStore.getState().setDbStatus({ ready: true, error: null });
    useSessionUIStore.getState().setHouseholdContext('hh-1', 'FOUNDER');
    await resetLocalSessionState();
    const state = useSessionUIStore.getState();
    expect(state.dbReady).toBe(false);
    expect(state.activeHouseholdId).toBe(null);
    expect(state.memberRole).toBe(null);
  });

  it('key store adapter can mint SQLCipher + node ids', async () => {
    const adapter = createMemoryKeyStoreAdapter();
    const key = await getOrCreateSqlCipherKeyHex(adapter);
    const node = await getOrCreateDeviceNodeId(adapter);
    expect(key).toHaveLength(64);
    expect(node).toHaveLength(12);
    expect(adapter.store.get(SQLCIPHER_KEY_STORAGE_KEY)).toBe(key);
    expect(adapter.store.get(DEVICE_NODE_ID_STORAGE_KEY)).toBe(node);
  });
});
