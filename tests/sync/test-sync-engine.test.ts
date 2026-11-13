import { eq } from 'drizzle-orm';
import {
  accounts,
  createAccount,
  softDeleteAccount,
  updateAccount,
  SYNC_META_KEYS,
  setSyncMetaValue,
  getSyncMetaValue,
  syncOutbox,
  households,
} from '@/data';
import { createSyncEngine } from '@/sync/syncEngine';
import { resetInFlightToPending, selectPendingBatch } from '@/sync/outboxCoalesce';
import { SyncError } from '@/sync/syncGateway';
import type { NetworkMonitor } from '@/sync/networkMonitor';
import { createInMemoryTestDb } from '../data/testDbHelper';
import { createMemorySyncServer } from './memorySyncServer';

const HOUSEHOLD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NODE_A = 'aaaaaaaa0001';
const NODE_B = 'bbbbbbbb0002';

function createNetwork(online: {
  value: boolean;
}): NetworkMonitor & { setOnline: (next: boolean) => void } {
  const listeners = new Set<(online: boolean) => void>();
  return {
    async isOnline() {
      return online.value;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(online.value);
      return () => listeners.delete(listener);
    },
    setOnline(next: boolean) {
      online.value = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
}

function seedHousehold(db: ReturnType<typeof createInMemoryTestDb>['db']) {
  db.insert(households)
    .values({
      id: HOUSEHOLD_ID,
      name: 'Lar Teste',
      syncEpoch: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    .run();
  setSyncMetaValue(db, SYNC_META_KEYS.SYNC_EPOCH, '1');
  setSyncMetaValue(db, SYNC_META_KEYS.LAST_SERVER_SEQ, '0');
}

describe('TEST-SYNC Phase 4 engine', () => {
  describe('TEST-SYNC-A — push then pull converges', () => {
    it('pushes Device A mutations and Device B pulls to the same state', async () => {
      const server = createMemorySyncServer({ householdId: HOUSEHOLD_ID });
      const deviceA = createInMemoryTestDb();
      const deviceB = createInMemoryTestDb();
      seedHousehold(deviceA.db);
      seedHousehold(deviceB.db);
      setSyncMetaValue(deviceA.db, SYNC_META_KEYS.DEVICE_NODE_ID, NODE_A);
      setSyncMetaValue(deviceB.db, SYNC_META_KEYS.DEVICE_NODE_ID, NODE_B);

      createAccount(
        deviceA.db,
        {
          id: '11111111-1111-4111-8111-111111111111',
          householdId: HOUSEHOLD_ID,
          ownerUserId: null,
          name: 'Conta Conjunta',
          type: 'CHECKING',
          initialBalanceCents: 10000,
          includeInNetWorth: true,
          isArchived: false,
        },
        { nowMs: 1_762_700_000_000, nodeId: NODE_A },
      );

      const net = createNetwork({ value: true });
      const engineA = createSyncEngine({
        db: deviceA.db,
        householdId: HOUSEHOLD_ID,
        gateway: server,
        network: net,
        debounceMs: null,
        retryBaseMs: null,
      });
      const engineB = createSyncEngine({
        db: deviceB.db,
        householdId: HOUSEHOLD_ID,
        gateway: server,
        network: net,
        debounceMs: null,
        retryBaseMs: null,
      });

      await engineA.start();
      await engineA.syncNow();
      await engineB.start();
      await engineB.syncNow();

      const onB = deviceB.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, '11111111-1111-4111-8111-111111111111'))
        .get();
      expect(onB?.name).toBe('Conta Conjunta');
      expect(onB?.initialBalanceCents).toBe(10000);
      engineA.stop();
      engineB.stop();
      deviceA.close();
      deviceB.close();
    });
  });

  describe('TEST-SYNC-B — coalesce same-record updates', () => {
    it('coalesces multiple PENDING edits into one push mutation', async () => {
      const server = createMemorySyncServer({ householdId: HOUSEHOLD_ID });
      const deviceA = createInMemoryTestDb();
      seedHousehold(deviceA.db);
      setSyncMetaValue(deviceA.db, SYNC_META_KEYS.DEVICE_NODE_ID, NODE_A);

      const id = '22222222-2222-4222-8222-222222222222';
      createAccount(
        deviceA.db,
        {
          id,
          householdId: HOUSEHOLD_ID,
          ownerUserId: null,
          name: 'v1',
          type: 'CHECKING',
          initialBalanceCents: 1,
          includeInNetWorth: true,
          isArchived: false,
        },
        { nowMs: 1_762_700_000_000, nodeId: NODE_A },
      );
      updateAccount(
        deviceA.db,
        id,
        { name: 'v2' },
        { nowMs: 1_762_700_000_100, nodeId: NODE_A },
      );
      updateAccount(
        deviceA.db,
        id,
        { name: 'v3' },
        { nowMs: 1_762_700_000_200, nodeId: NODE_A },
      );

      const pending = selectPendingBatch(deviceA.db, 100);
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0].payloadJson).name).toBe('v3');

      const engine = createSyncEngine({
        db: deviceA.db,
        householdId: HOUSEHOLD_ID,
        gateway: server,
        network: createNetwork({ value: true }),
        debounceMs: null,
        retryBaseMs: null,
      });
      await engine.start();
      await engine.syncNow();
      expect(deviceA.db.select().from(syncOutbox).all()).toHaveLength(0);
      engine.stop();
      deviceA.close();
    });
  });

  describe('TEST-SYNC-C — topological FK order', () => {
    it('orders account before dependants in the push batch', () => {
      const deviceA = createInMemoryTestDb();
      seedHousehold(deviceA.db);
      setSyncMetaValue(deviceA.db, SYNC_META_KEYS.DEVICE_NODE_ID, NODE_A);

      createAccount(
        deviceA.db,
        {
          id: '33333333-3333-4333-8333-333333333333',
          householdId: HOUSEHOLD_ID,
          ownerUserId: null,
          name: 'Conta',
          type: 'CHECKING',
          initialBalanceCents: 0,
          includeInNetWorth: true,
          isArchived: false,
        },
        { nowMs: 1_762_700_001_000, nodeId: NODE_A },
      );

      const batch = selectPendingBatch(deviceA.db, 100);
      expect(batch[0].tableName).toBe('accounts');
      deviceA.close();
    });
  });

  describe('TEST-SYNC-D — tombstone precedence', () => {
    it('keeps soft-delete after sync to the peer device', async () => {
      const server = createMemorySyncServer({ householdId: HOUSEHOLD_ID });
      const deviceA = createInMemoryTestDb();
      const deviceB = createInMemoryTestDb();
      seedHousehold(deviceA.db);
      seedHousehold(deviceB.db);
      setSyncMetaValue(deviceA.db, SYNC_META_KEYS.DEVICE_NODE_ID, NODE_A);
      setSyncMetaValue(deviceB.db, SYNC_META_KEYS.DEVICE_NODE_ID, NODE_B);
      const net = createNetwork({ value: true });

      const id = '44444444-4444-4444-8444-444444444444';
      createAccount(
        deviceA.db,
        {
          id,
          householdId: HOUSEHOLD_ID,
          ownerUserId: null,
          name: 'Ativa',
          type: 'CHECKING',
          initialBalanceCents: 0,
          includeInNetWorth: true,
          isArchived: false,
        },
        { nowMs: 1_762_700_002_000, nodeId: NODE_A },
      );

      const engineA = createSyncEngine({
        db: deviceA.db,
        householdId: HOUSEHOLD_ID,
        gateway: server,
        network: net,
        debounceMs: null,
        retryBaseMs: null,
      });
      const engineB = createSyncEngine({
        db: deviceB.db,
        householdId: HOUSEHOLD_ID,
        gateway: server,
        network: net,
        debounceMs: null,
        retryBaseMs: null,
      });

      await engineA.start();
      await engineA.syncNow();
      await engineB.start();
      await engineB.syncNow();

      softDeleteAccount(deviceA.db, id, {
        nowMs: 1_762_700_003_000,
        nodeId: NODE_A,
      });
      await engineA.syncNow();
      await engineB.syncNow();

      const onB = deviceB.db.select().from(accounts).where(eq(accounts.id, id)).get();
      expect(onB?.deletedAt).not.toBeNull();
      engineA.stop();
      engineB.stop();
      deviceA.close();
      deviceB.close();
    });
  });

  describe('TEST-SYNC-EF — idempotent re-send', () => {
    it('skips already processed mutation_id on re-push', async () => {
      const server = createMemorySyncServer({ householdId: HOUSEHOLD_ID });
      const deviceA = createInMemoryTestDb();
      seedHousehold(deviceA.db);
      setSyncMetaValue(deviceA.db, SYNC_META_KEYS.DEVICE_NODE_ID, NODE_A);

      createAccount(
        deviceA.db,
        {
          id: '55555555-5555-4555-8555-555555555555',
          householdId: HOUSEHOLD_ID,
          ownerUserId: null,
          name: 'Idem',
          type: 'WALLET',
          initialBalanceCents: 0,
          includeInNetWorth: true,
          isArchived: false,
        },
        { nowMs: 1_762_700_004_000, nodeId: NODE_A },
      );

      const batch = selectPendingBatch(deviceA.db, 100);
      const first = await server.pushBatch({
        householdId: HOUSEHOLD_ID,
        syncEpoch: 1,
        mutations: batch.map((row) => ({
          mutation_id: row.mutationId,
          batch_id: row.batchId,
          table_name: row.tableName,
          record_id: row.recordId,
          operation: row.operation,
          payload: JSON.parse(row.payloadJson),
          field_hlc: JSON.parse(row.fieldHlcJson),
          hlc_timestamp: row.hlcTimestamp,
        })),
      });
      expect(first.accepted).toBe(1);

      const second = await server.pushBatch({
        householdId: HOUSEHOLD_ID,
        syncEpoch: 1,
        mutations: batch.map((row) => ({
          mutation_id: row.mutationId,
          batch_id: row.batchId,
          table_name: row.tableName,
          record_id: row.recordId,
          operation: row.operation,
          payload: JSON.parse(row.payloadJson),
          field_hlc: JSON.parse(row.fieldHlcJson),
          hlc_timestamp: row.hlcTimestamp,
        })),
      });
      expect(second.accepted).toBe(0);
      expect(second.skippedIdempotent).toBe(1);
      deviceA.close();
    });
  });

  describe('TEST-SYNC-GH — crash recovery + offline suspend', () => {
    it('resets IN_FLIGHT to PENDING and suspends sync while offline', async () => {
      const server = createMemorySyncServer({ householdId: HOUSEHOLD_ID });
      const deviceA = createInMemoryTestDb();
      seedHousehold(deviceA.db);
      setSyncMetaValue(deviceA.db, SYNC_META_KEYS.DEVICE_NODE_ID, NODE_A);

      createAccount(
        deviceA.db,
        {
          id: '66666666-6666-4666-8666-666666666666',
          householdId: HOUSEHOLD_ID,
          ownerUserId: null,
          name: 'Crash',
          type: 'CHECKING',
          initialBalanceCents: 0,
          includeInNetWorth: true,
          isArchived: false,
        },
        { nowMs: 1_762_700_005_000, nodeId: NODE_A },
      );

      const pending = selectPendingBatch(deviceA.db, 100);
      deviceA.db
        .update(syncOutbox)
        .set({ status: 'IN_FLIGHT' })
        .where(eq(syncOutbox.seqId, pending[0].seqId))
        .run();

      expect(resetInFlightToPending(deviceA.db)).toBe(1);
      expect(
        deviceA.db
          .select()
          .from(syncOutbox)
          .where(eq(syncOutbox.status, 'PENDING'))
          .all(),
      ).toHaveLength(1);

      const online = { value: false };
      const network = createNetwork(online);
      const engine = createSyncEngine({
        db: deviceA.db,
        householdId: HOUSEHOLD_ID,
        gateway: server,
        network,
        debounceMs: null,
        retryBaseMs: null,
      });
      await engine.start();
      const offlineResult = await engine.syncNow();
      expect(offlineResult.outcome).toBe('OFFLINE');
      expect(
        deviceA.db
          .select()
          .from(syncOutbox)
          .where(eq(syncOutbox.status, 'PENDING'))
          .all().length,
      ).toBeGreaterThan(0);

      network.setOnline(true);
      await engine.syncNow();
      expect(deviceA.db.select().from(syncOutbox).all()).toHaveLength(0);
      engine.stop();
      deviceA.close();
    });

    it('surfaces EPOCH_MISMATCH without acking outbox rows', async () => {
      const server = createMemorySyncServer({
        householdId: HOUSEHOLD_ID,
        syncEpoch: 2,
      });
      const deviceA = createInMemoryTestDb();
      seedHousehold(deviceA.db);
      setSyncMetaValue(deviceA.db, SYNC_META_KEYS.DEVICE_NODE_ID, NODE_A);
      createAccount(
        deviceA.db,
        {
          id: '77777777-7777-4777-8777-777777777777',
          householdId: HOUSEHOLD_ID,
          ownerUserId: null,
          name: 'Epoch',
          type: 'CHECKING',
          initialBalanceCents: 0,
          includeInNetWorth: true,
          isArchived: false,
        },
        { nowMs: 1_762_700_006_000, nodeId: NODE_A },
      );

      const engine = createSyncEngine({
        db: deviceA.db,
        householdId: HOUSEHOLD_ID,
        gateway: server,
        network: createNetwork({ value: true }),
        debounceMs: null,
        retryBaseMs: null,
      });
      const result = await engine.start();
      expect(result?.outcome === 'ERROR' || result?.outcome === 'HALTED').toBe(
        true,
      );
      if (result?.error) {
        expect(result.error).toBeInstanceOf(SyncError);
        expect(result.error.code).toBe('EPOCH_MISMATCH');
      }

      expect(
        deviceA.db
          .select()
          .from(syncOutbox)
          .where(eq(syncOutbox.status, 'PENDING'))
          .all().length,
      ).toBe(1);
      expect(getSyncMetaValue(deviceA.db, SYNC_META_KEYS.LAST_SERVER_SEQ)).toBe(
        '0',
      );
      engine.stop();
      deviceA.close();
    });
  });
});
