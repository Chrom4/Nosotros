import { eq } from 'drizzle-orm';
import {
  createAccount,
  createBaseTransaction,
  createCategory,
  setSyncMetaValue,
  upsertLocalHousehold,
} from '@/data/repositories';
import { SYNC_META_KEYS, syncOutbox } from '@/data/schema';
import type { AppDatabase } from '@/data/db';
import type { NetworkMonitor } from '@/sync/networkMonitor';
import {
  createSyncEngine,
  type SyncEngine,
  type SyncEngineOptions,
  type SyncStatusReporter,
} from '@/sync/syncEngine';
import {
  type SyncBackendGateway,
  SyncError,
  type WireMutation,
} from '@/sync/syncGateway';
import { createInMemoryTestDb, type InMemoryTestDb } from '../data/testDbHelper';

export const HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';
export const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const USER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const ACCOUNT_1_ID = '22222222-2222-4222-8222-222222222221';
export const ACCOUNT_2_ID = '22222222-2222-4222-8222-222222222222';
export const CATEGORY_ROOT_ID = '33333333-3333-4333-8333-333333333331';
export const CATEGORY_CHILD_ID = '33333333-3333-4333-8333-333333333332';
export const CARD_1_ID = '44444444-4444-4444-8444-444444444441';
export const TX_1_ID = '66666666-6666-4666-8666-666666666601';
export const TX_2_ID = '66666666-6666-4666-8666-666666666602';

/** Fixed base so every HLC in a scenario is deterministic. */
export const T0 = 1_762_700_000_000;

export class FakeNetwork implements NetworkMonitor {
  private listeners = new Set<(online: boolean) => void>();

  constructor(private online = true) {}

  async isOnline(): Promise<boolean> {
    return this.online;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setOnline(online: boolean): void {
    this.online = online;
    for (const listener of [...this.listeners]) listener(online);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

export interface RecordingStatus extends SyncStatusReporter {
  statuses: string[];
  counts: Array<[number, number]>;
  errors: Array<{ code: string; message: string }>;
}

export function createRecordingStatus(): RecordingStatus {
  const recorder: RecordingStatus = {
    statuses: [],
    counts: [],
    errors: [],
    setStatus: (s) => {
      recorder.statuses.push(s);
    },
    setCounts: (p, f) => {
      recorder.counts.push([p, f]);
    },
    setError: (code, message) => {
      recorder.statuses.push('ERROR');
      recorder.errors.push({ code, message });
    },
    markSynced: () => {
      recorder.statuses.push('IDLE');
    },
  };
  return recorder;
}

export interface TestClient {
  name: string;
  userId: string;
  nodeId: string;
  harness: InMemoryTestDb;
  db: AppDatabase;
  network: FakeNetwork;
  status: RecordingStatus;
  /** Current HLC wall clock in ms; `tick()` returns a strictly increasing value. */
  tick: () => number;
  makeEngine: (
    gateway: SyncBackendGateway,
    overrides?: Partial<SyncEngineOptions>,
  ) => SyncEngine;
  close: () => void;
}

/**
 * A simulated device: its own in-memory SQLite (real Drizzle migrations), network switch,
 * status recorder and a deterministic clock.
 */
export function createTestClient(params: {
  name: string;
  userId: string;
  nodeId: string;
  clockStartMs: number;
  syncEpoch?: number;
}): TestClient {
  const harness = createInMemoryTestDb();
  upsertLocalHousehold(harness.db, {
    id: HOUSEHOLD_ID,
    name: 'Casa Nosotros',
    syncEpoch: params.syncEpoch ?? 1,
  });
  setSyncMetaValue(harness.db, SYNC_META_KEYS.DEVICE_NODE_ID, params.nodeId);

  let clock = params.clockStartMs;
  const network = new FakeNetwork(true);
  const status = createRecordingStatus();

  const client: TestClient = {
    name: params.name,
    userId: params.userId,
    nodeId: params.nodeId,
    harness,
    db: harness.db,
    network,
    status,
    tick: () => {
      clock += 1000;
      return clock;
    },
    makeEngine: (gateway, overrides = {}) =>
      createSyncEngine({
        db: harness.db,
        householdId: HOUSEHOLD_ID,
        gateway,
        network,
        status,
        retryBaseMs: null,
        debounceMs: null,
        nowMs: () => clock + 500,
        ...overrides,
      }),
    close: () => harness.close(),
  };
  return client;
}

export function seedAccount(
  client: TestClient,
  id: string = ACCOUNT_1_ID,
  name = 'Conta Corrente',
) {
  return createAccount(
    client.db,
    {
      id,
      householdId: HOUSEHOLD_ID,
      ownerUserId: client.userId,
      name,
      type: 'CHECKING',
      initialBalanceCents: 100_000,
      includeInNetWorth: true,
      isArchived: false,
    },
    { nowMs: client.tick(), nodeId: client.nodeId },
  );
}

export function seedCategories(client: TestClient) {
  createCategory(
    client.db,
    {
      id: CATEGORY_ROOT_ID,
      householdId: HOUSEHOLD_ID,
      parentId: null,
      name: 'Alimentação',
      kind: 'EXPENSE',
      colorHex: '#10B981',
      iconName: 'utensils',
    },
    { nowMs: client.tick(), nodeId: client.nodeId },
  );
  createCategory(
    client.db,
    {
      id: CATEGORY_CHILD_ID,
      householdId: HOUSEHOLD_ID,
      parentId: CATEGORY_ROOT_ID,
      name: 'Supermercado',
      kind: 'EXPENSE',
      colorHex: '#10B981',
      iconName: 'shopping-cart',
    },
    { nowMs: client.tick(), nodeId: client.nodeId },
  );
}

export function seedExpense(
  client: TestClient,
  id: string = TX_1_ID,
  accountId: string = ACCOUNT_1_ID,
) {
  return createBaseTransaction(
    client.db,
    {
      id,
      householdId: HOUSEHOLD_ID,
      createdByUserId: client.userId,
      ownerUserId: null,
      type: 'EXPENSE',
      amountCents: 12_345,
      transactionDate: '2026-11-09',
      description: 'Feira',
      accountId,
      categoryId: CATEGORY_CHILD_ID,
    },
    { nowMs: client.tick(), nodeId: client.nodeId },
  );
}

export function outboxStatuses(db: AppDatabase): string[] {
  return db
    .select()
    .from(syncOutbox)
    .all()
    .map((r) => r.status);
}

export function outboxRowsFor(db: AppDatabase, recordId: string) {
  return db
    .select()
    .from(syncOutbox)
    .where(eq(syncOutbox.recordId, recordId))
    .all();
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Server abstraction so the same scenarios run against the in-memory and PGlite backends. */
export interface ServerFixture {
  /** Gateway authenticated as `userId`. */
  gatewayFor(userId: string): SyncBackendGateway;
  reset(): Promise<void>;
  getRow(
    table: string,
    id: string,
  ): Promise<Record<string, unknown> | null>;
  processedCount(): Promise<number>;
  setEpoch(epoch: number): Promise<void>;
}

export interface GatewaySpy {
  gateway: SyncBackendGateway;
  pushes: WireMutation[][];
  pulls: number;
}

/** Records every push batch (in wire order) and pull call passing through a gateway. */
export function spyGateway(inner: SyncBackendGateway): GatewaySpy {
  const spy: GatewaySpy = {
    pushes: [],
    pulls: 0,
    gateway: {
      pushBatch: async (request) => {
        spy.pushes.push(request.mutations);
        return inner.pushBatch(request);
      },
      pullChanges: async (request) => {
        spy.pulls += 1;
        return inner.pullChanges(request);
      },
    },
  };
  return spy;
}

export interface FaultInjector {
  gateway: SyncBackendGateway;
  /** Next push reaches the server but the response is "lost" (client sees a network error). */
  dropNextPushResponse(): void;
  /** Next push never settles (simulates the process dying mid-request). */
  hangNextPush(): void;
  /** Releases a hung push by rejecting it. */
  releaseHung(): void;
  calls: { push: number; pull: number };
}

export function faultyGateway(inner: SyncBackendGateway): FaultInjector {
  let dropResponse = false;
  let hang = false;
  let releaseHung: (() => void) | null = null;
  const injector: FaultInjector = {
    calls: { push: 0, pull: 0 },
    dropNextPushResponse: () => {
      dropResponse = true;
    },
    hangNextPush: () => {
      hang = true;
    },
    releaseHung: () => releaseHung?.(),
    gateway: {
      pushBatch: async (request) => {
        injector.calls.push += 1;
        if (hang) {
          hang = false;
          await new Promise<void>((_, reject) => {
            releaseHung = () =>
              reject(new SyncError('NETWORK', 'Network request failed'));
          });
        }
        const result = await inner.pushBatch(request);
        if (dropResponse) {
          dropResponse = false;
          throw new SyncError('NETWORK', 'Network request failed');
        }
        return result;
      },
      pullChanges: async (request) => {
        injector.calls.pull += 1;
        return inner.pullChanges(request);
      },
    },
  };
  return injector;
}
