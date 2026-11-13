/**
 * @jest-environment node
 */
import { eq } from 'drizzle-orm';
import { resetInFlightToPending } from '@/sync/outboxCoalesce';
import { syncOutbox } from '@/data/schema';
import { InMemorySyncServer } from './inMemorySyncServer';
import {
  createTestClient,
  faultyGateway,
  outboxStatuses,
  seedAccount,
  seedCategories,
  seedExpense,
  spyGateway,
  T0,
  type TestClient,
  USER_A_ID,
  waitFor,
} from './syncTestKit';

describe('TEST-SYNC-G: crash recovery (IN_FLIGHT -> PENDING)', () => {
  let server: InMemorySyncServer;
  let a: TestClient;

  beforeEach(() => {
    server = new InMemorySyncServer({ sortBatch: false });
    a = createTestClient({
      name: 'A',
      userId: USER_A_ID,
      nodeId: 'aaaaaaaa0001',
      clockStartMs: T0,
    });
    seedAccount(a);
    seedCategories(a);
    seedExpense(a);
  });

  afterEach(() => a.close());

  it('resetInFlightToPending re-queues every IN_FLIGHT row and leaves others untouched', () => {
    const rows = a.db.select().from(syncOutbox).all();
    a.db
      .update(syncOutbox)
      .set({ status: 'IN_FLIGHT' })
      .where(eq(syncOutbox.seqId, rows[0].seqId))
      .run();
    a.db
      .update(syncOutbox)
      .set({ status: 'FAILED_PERMANENT' })
      .where(eq(syncOutbox.seqId, rows[1].seqId))
      .run();

    expect(resetInFlightToPending(a.db)).toBe(1);
    expect(outboxStatuses(a.db).sort()).toEqual([
      'FAILED_PERMANENT',
      'PENDING',
      'PENDING',
      'PENDING',
    ]);
    expect(resetInFlightToPending(a.db)).toBe(0);
  });

  it('boot recovery: engine.start() resets IN_FLIGHT rows before doing anything else', async () => {
    a.db.update(syncOutbox).set({ status: 'IN_FLIGHT' }).run();
    a.network.setOnline(false); // observe the recovery without pushing yet

    const engine = a.makeEngine(server.gatewayFor(USER_A_ID));
    const result = await engine.start();

    expect(result?.outcome).toBe('OFFLINE');
    expect(outboxStatuses(a.db)).toEqual(['PENDING', 'PENDING', 'PENDING', 'PENDING']);
    expect(a.status.counts.at(-1)).toEqual([4, 0]);
    engine.stop();
  });

  it('a process killed mid-push recovers on next boot and the server sees each mutation once', async () => {
    const faulty = faultyGateway(server.gatewayFor(USER_A_ID));
    const crashed = a.makeEngine(faulty.gateway);

    faulty.hangNextPush();
    const inFlightCycle = crashed.syncNow();
    await waitFor(
      () =>
        outboxStatuses(a.db).length === 4 &&
        outboxStatuses(a.db).every((s) => s === 'IN_FLIGHT'),
    );

    // "Process dies": nothing acknowledged, rows stuck IN_FLIGHT.
    crashed.stop();
    expect(await server.processedCount()).toBe(0);

    // New process, same SQLite file.
    const rebooted = a.makeEngine(server.gatewayFor(USER_A_ID));
    const result = await rebooted.start();
    expect(result).toMatchObject({ outcome: 'OK', pushed: 4, skippedIdempotent: 0 });
    expect(outboxStatuses(a.db)).toHaveLength(0);
    expect(await server.processedCount()).toBe(4);
    rebooted.stop();

    // Let the dead engine's request settle; it must not resurrect acknowledged rows.
    faulty.releaseHung();
    await inFlightCycle;
    expect(outboxStatuses(a.db)).toHaveLength(0);
  });
});

describe('TEST-SYNC-H: offline suspends sync and retries', () => {
  let server: InMemorySyncServer;
  let a: TestClient;

  beforeEach(() => {
    server = new InMemorySyncServer({ sortBatch: false });
    a = createTestClient({
      name: 'A',
      userId: USER_A_ID,
      nodeId: 'aaaaaaaa0001',
      clockStartMs: T0,
    });
  });

  afterEach(() => a.close());

  it('makes no network calls while offline and syncs as soon as connectivity returns', async () => {
    a.network.setOnline(false);
    seedAccount(a);
    seedCategories(a);
    seedExpense(a);

    const spy = spyGateway(server.gatewayFor(USER_A_ID));
    const engine = a.makeEngine(spy.gateway);

    const started = await engine.start();
    expect(started?.outcome).toBe('OFFLINE');
    expect((await engine.syncNow()).outcome).toBe('OFFLINE');
    expect(spy.pushes).toHaveLength(0);
    expect(spy.pulls).toBe(0);
    expect(a.status.statuses.at(-1)).toBe('OFFLINE');
    expect(a.status.counts.at(-1)).toEqual([4, 0]);

    // Writes made while offline stay queued locally.
    seedAccount(a, '22222222-2222-4222-8222-222222222222', 'Offline extra');
    expect(outboxStatuses(a.db)).toHaveLength(5);
    expect(spy.pushes).toHaveLength(0);

    // Connectivity returns -> NetInfo subscription triggers a sync cycle.
    a.network.setOnline(true);
    await waitFor(() => outboxStatuses(a.db).length === 0);
    expect(spy.pushes.flat()).toHaveLength(5);
    expect(await server.processedCount()).toBe(5);
    expect(a.status.statuses).toContain('SYNCING');
    expect(a.status.statuses.at(-1)).toBe('IDLE');

    engine.stop();
    expect(a.network.listenerCount).toBe(0);
  });

  it('retries after a network failure, but suspends the retry timer while offline', async () => {
    seedAccount(a);
    const faulty = faultyGateway(server.gatewayFor(USER_A_ID));
    const engine = a.makeEngine(faulty.gateway, { retryBaseMs: 20 });
    await engine.start(); // online, push response lost -> NETWORK failure + retry scheduled
    expect(faulty.calls.push).toBe(1);

    // Go offline before the retry fires: the timer must be cancelled.
    a.network.setOnline(false);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(faulty.calls.push).toBe(1);
    expect(a.status.statuses.at(-1)).toBe('OFFLINE');

    // Back online: sync resumes and drains the outbox (re-sent mutation is idempotent).
    a.network.setOnline(true);
    await waitFor(() => outboxStatuses(a.db).length === 0);
    expect(await server.processedCount()).toBe(1);
    engine.stop();
  });

  it('automatic retry fires while online and eventually succeeds', async () => {
    seedAccount(a);
    const faulty = faultyGateway(server.gatewayFor(USER_A_ID));
    faulty.dropNextPushResponse();
    const engine = a.makeEngine(faulty.gateway, { retryBaseMs: 10 });
    await engine.start();

    await waitFor(() => outboxStatuses(a.db).length === 0);
    expect(faulty.calls.push).toBe(2);
    expect(await server.processedCount()).toBe(1);
    engine.stop();
  });
});
