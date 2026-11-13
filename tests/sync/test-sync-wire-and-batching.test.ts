/**
 * @jest-environment node
 */
import { classifyRpcError } from '@/sync/syncGateway';
import {
  deletedAtFromWire,
  deletedAtToWire,
  wireChangeToRemoteChange,
} from '@/sync/wireFormat';
import { InMemorySyncServer } from './inMemorySyncServer';
import {
  createTestClient,
  outboxStatuses,
  seedAccount,
  spyGateway,
  T0,
  USER_A_ID,
} from './syncTestKit';

const HLC = '2026-11-09T12:00:00.123Z-0003-aaaaaaaa0001';

describe('wire format', () => {
  it('maps the local delete HLC to a timestamptz literal and back', () => {
    expect(deletedAtToWire(HLC)).toBe('2026-11-09T12:00:00.123Z');
    expect(deletedAtToWire(null)).toBeNull();
    expect(deletedAtFromWire('2026-11-09T12:00:00.123+00:00', { deleted_at: HLC })).toBe(HLC);
    expect(deletedAtFromWire('2026-11-09T12:00:00.123+00:00', {})).toBe(
      '2026-11-09T12:00:00.123Z-0000-000000000000',
    );
    expect(deletedAtFromWire(null, { deleted_at: HLC })).toBeNull();
  });

  it('normalizes server timestamps on pull', () => {
    const change = wireChangeToRemoteChange({
      table_name: 'accounts',
      record_id: 'r1',
      server_seq: 7,
      operation: 'UPSERT',
      payload: {
        created_at: '2026-11-09T12:00:00.123456+00:00',
        updated_at: '2026-11-09T12:00:00+00:00',
      },
      field_hlc: {},
      hlc_timestamp: HLC,
      deleted_at: null,
    });
    expect(change.payload.created_at).toBe('2026-11-09T12:00:00.123Z');
    expect(change.payload.updated_at).toBe('2026-11-09T12:00:00.000Z');
    expect(change.payload.deleted_at).toBeNull();
  });
});

describe('error classification', () => {
  it.each([
    [{ message: 'EPOCH_MISMATCH: client 1 differs' }, 'EPOCH_MISMATCH'],
    [{ message: 'FORBIDDEN: revoked' }, 'AUTH'],
    [{ message: 'UNAUTHENTICATED' }, 'AUTH'],
    [{ message: 'insert violates fk', code: '23503' }, 'PERMANENT'],
    [{ message: 'INVALID_MUTATION: x' }, 'PERMANENT'],
    [{ message: 'TypeError: Network request failed' }, 'NETWORK'],
    [{ message: 'upstream exploded', code: '57P01' }, 'TRANSIENT'],
  ])('%j -> %s', (input, code) => {
    expect(classifyRpcError(input).code).toBe(code);
  });
});

describe('push batching', () => {
  it('never sends more than 100 mutations per call', async () => {
    const server = new InMemorySyncServer({ sortBatch: false });
    const a = createTestClient({
      name: 'A',
      userId: USER_A_ID,
      nodeId: 'aaaaaaaa0001',
      clockStartMs: T0,
    });
    for (let i = 0; i < 250; i++) {
      const id = `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`;
      seedAccount(a, id, `Conta ${i}`);
    }
    const spy = spyGateway(server.gatewayFor(USER_A_ID));
    const result = await a
      .makeEngine(spy.gateway, { batchSize: 500 }) // hard-capped at 100
      .syncNow();

    expect(result).toMatchObject({ outcome: 'OK', pushed: 250 });
    expect(spy.pushes.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(outboxStatuses(a.db)).toHaveLength(0);
    a.close();
  });
});
