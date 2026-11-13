/**
 * @jest-environment node
 */
import { eq } from 'drizzle-orm';
import {
  accounts,
  SYNC_META_KEYS,
  syncMeta,
  syncOutbox,
  transactions,
} from '@/data/schema';
import { enqueueOrCoalesceOutbox } from '@/data/repositories';
import {
  type PullChangesResult,
  type SyncBackendGateway,
  SyncError,
} from '@/sync/syncGateway';
import { InMemorySyncServer } from './inMemorySyncServer';
import {
  ACCOUNT_2_ID,
  createTestClient,
  outboxStatuses,
  seedAccount,
  seedCategories,
  seedExpense,
  T0,
  type TestClient,
  USER_A_ID,
  USER_B_ID,
} from './syncTestKit';

describe('Sync engine failure handling', () => {
  let server: InMemorySyncServer;
  let a: TestClient;
  let b: TestClient;

  beforeEach(() => {
    server = new InMemorySyncServer({ sortBatch: false });
    a = createTestClient({
      name: 'A',
      userId: USER_A_ID,
      nodeId: 'aaaaaaaa0001',
      clockStartMs: T0,
    });
    b = createTestClient({
      name: 'B',
      userId: USER_B_ID,
      nodeId: 'bbbbbbbb0002',
      clockStartMs: T0 + 3_600_000,
    });
  });

  afterEach(() => {
    a.close();
    b.close();
  });

  const cursor = (c: TestClient) =>
    c.db
      .select()
      .from(syncMeta)
      .where(eq(syncMeta.key, SYNC_META_KEYS.LAST_SERVER_SEQ))
      .get()?.value ?? '0';

  it('EPOCH_MISMATCH on push halts the engine, keeps the outbox and never touches local data', async () => {
    seedAccount(a);
    seedCategories(a);
    await server.setEpoch(2);

    const engine = a.makeEngine(server.gatewayFor(USER_A_ID));
    const result = await engine.syncNow();

    expect(result.outcome).toBe('HALTED');
    expect(result.error?.code).toBe('EPOCH_MISMATCH');
    expect(outboxStatuses(a.db)).toEqual(['PENDING', 'PENDING', 'PENDING']);
    expect(a.status.errors[0].code).toBe('EPOCH_MISMATCH');
    expect(await server.processedCount()).toBe(0);

    // Halted: further cycles do not hit the network at all.
    const pullsBefore = server.pullCalls;
    expect((await engine.syncNow()).outcome).toBe('HALTED');
    expect(server.pullCalls).toBe(pullsBefore);
  });

  it('EPOCH_MISMATCH on pull applies nothing and does not advance the cursor', async () => {
    seedAccount(b);
    await b.makeEngine(server.gatewayFor(USER_B_ID)).syncNow();
    await server.setEpoch(2); // household was restored from a backup

    const engine = a.makeEngine(server.gatewayFor(USER_A_ID));
    const result = await engine.syncNow();

    expect(result.outcome).toBe('HALTED');
    expect(result.error?.code).toBe('EPOCH_MISMATCH');
    expect(a.db.select().from(accounts).all()).toHaveLength(0);
    expect(cursor(a)).toBe('0');
  });

  it('persists the sync epoch after the first successful pull', async () => {
    seedAccount(b);
    await b.makeEngine(server.gatewayFor(USER_B_ID)).syncNow();

    expect(
      a.db.select().from(syncMeta).where(eq(syncMeta.key, SYNC_META_KEYS.SYNC_EPOCH)).get(),
    ).toBeUndefined();
    const result = await a.makeEngine(server.gatewayFor(USER_A_ID)).syncNow();
    expect(result.outcome).toBe('OK');
    expect(
      a.db.select().from(syncMeta).where(eq(syncMeta.key, SYNC_META_KEYS.SYNC_EPOCH)).get()
        ?.value,
    ).toBe('1');
  });

  it('isolates a poison mutation by bisecting: good rows are acked, the bad one parks as FAILED_PERMANENT', async () => {
    seedAccount(a);
    seedCategories(a);
    seedExpense(a);
    a.db.transaction((tx) => {
      enqueueOrCoalesceOutbox(tx, {
        batchId: 'batch-poison',
        tableName: 'accounts',
        recordId: ACCOUNT_2_ID,
        operation: 'UPSERT',
        payload: { id: ACCOUNT_2_ID, __poison: 'bad row' },
        fieldHlc: {},
        hlcTimestamp: '2026-11-09T12:00:00.000Z-0000-aaaaaaaa0001',
        createdAt: new Date(T0).toISOString(),
      });
    });
    expect(outboxStatuses(a.db)).toHaveLength(5);

    const result = await a.makeEngine(server.gatewayFor(USER_A_ID)).syncNow();

    expect(result.outcome).toBe('OK');
    expect(result.pushed).toBe(4);
    const left = a.db.select().from(syncOutbox).all();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({
      recordId: ACCOUNT_2_ID,
      status: 'FAILED_PERMANENT',
    });
    expect(left[0].lastError).toContain('INVALID_MUTATION');
    expect(a.status.counts.at(-1)).toEqual([0, 1]);
    expect(await server.processedCount()).toBe(4);
  });

  it('transient failures return rows to PENDING and park them after maxRetries', async () => {
    seedAccount(a);
    const failing: SyncBackendGateway = {
      pushBatch: async () => {
        throw new SyncError('TRANSIENT', 'upstream 500');
      },
      pullChanges: async () => {
        throw new SyncError('TRANSIENT', 'upstream 500');
      },
    };
    const engine = a.makeEngine(failing, { maxRetries: 2 });

    expect((await engine.syncNow()).outcome).toBe('ERROR');
    expect(a.db.select().from(syncOutbox).get()).toMatchObject({
      status: 'PENDING',
      retryCount: 1,
    });

    await engine.syncNow();
    expect(a.db.select().from(syncOutbox).get()).toMatchObject({
      status: 'FAILED_PERMANENT',
      retryCount: 2,
    });
  });

  it('network failures never consume retries', async () => {
    seedAccount(a);
    const offlineish: SyncBackendGateway = {
      pushBatch: async () => {
        throw new SyncError('NETWORK', 'Network request failed');
      },
      pullChanges: async () => {
        throw new SyncError('NETWORK', 'Network request failed');
      },
    };
    const engine = a.makeEngine(offlineish, { maxRetries: 1 });
    for (let i = 0; i < 3; i++) {
      expect((await engine.syncNow()).outcome).toBe('OFFLINE');
    }
    expect(a.db.select().from(syncOutbox).get()).toMatchObject({
      status: 'PENDING',
      retryCount: 0,
    });
  });

  it('AUTH failures surface as ERROR, keep the outbox and schedule no retry', async () => {
    seedAccount(a);
    const revoked: SyncBackendGateway = {
      pushBatch: async () => {
        throw new SyncError('AUTH', 'FORBIDDEN: Access revoked');
      },
      pullChanges: async () => {
        throw new SyncError('AUTH', 'FORBIDDEN: Access revoked');
      },
    };
    const engine = a.makeEngine(revoked, { retryBaseMs: 5 });
    const result = await engine.start();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(result?.outcome).toBe('ERROR');
    expect(a.status.errors).toEqual([
      { code: 'AUTH', message: 'FORBIDDEN: Access revoked' },
    ]);
    expect(outboxStatuses(a.db)).toEqual(['PENDING']);
    engine.stop();
  });

  it('applies a pulled page atomically: a failing change rolls back the whole page and the cursor', async () => {
    seedAccount(a);
    seedCategories(a);
    seedExpense(a);
    await a.makeEngine(server.gatewayFor(USER_A_ID)).syncNow();

    // Deliver the transaction BEFORE its account/categories: FK violation locally.
    const real = server.gatewayFor(USER_B_ID);
    const reordered: SyncBackendGateway = {
      pushBatch: real.pushBatch,
      pullChanges: async (request): Promise<PullChangesResult> => {
        const page = await real.pullChanges(request);
        const seqs = page.changes.map((c) => c.server_seq);
        const reversed = [...page.changes].reverse().map((c, i) => ({
          ...c,
          server_seq: seqs[i],
        }));
        return { ...page, changes: reversed };
      },
    };

    const result = await b.makeEngine(reordered).syncNow();

    expect(result.outcome).toBe('ERROR');
    expect(result.error?.message).toContain('Failed to apply remote changes');
    expect(b.db.select().from(accounts).all()).toHaveLength(0);
    expect(b.db.select().from(transactions).all()).toHaveLength(0);
    expect(cursor(b)).toBe('0');
  });
});
