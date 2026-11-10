import {
  compareHlc,
  computeCorrectedNowMs,
  computeServerTimeOffsetMs,
  isValidHlc,
  mergeRecordLww,
  nextLocalHlc,
  packHlc,
  receiveRemoteHlc,
  unpackHlc,
  type HlcState,
} from '@/core/hlc';

describe('Phase 1 — Hybrid Logical Clock (/src/core/hlc.ts)', () => {
  const nodeA = 'a1b2c3d4e5f6';
  const nodeB = 'f6e5d4c3b2a1';
  const t0 = Date.parse('2026-11-06T18:45:12.345Z');

  it('packs and unpacks canonical 42-character HLC strings accurately', () => {
    const hlc = packHlc(t0, 1, nodeA);
    expect(hlc).toBe('2026-11-06T18:45:12.345Z-0001-a1b2c3d4e5f6');
    expect(hlc).toHaveLength(42);
    expect(isValidHlc(hlc)).toBe(true);

    const unpacked = unpackHlc(hlc);
    expect(unpacked).toEqual({
      lastWallMs: t0,
      counter: 1,
      nodeId: nodeA,
    });
  });

  it('maintains strict monotonicity across rapid same-ms writes and backward clock drift', () => {
    let state: HlcState = { lastWallMs: t0, counter: 0, nodeId: nodeA };
    const generated: string[] = [];

    // 5 mutations within the exact same millisecond
    for (let i = 0; i < 5; i++) {
      const res = nextLocalHlc(state, t0);
      generated.push(res.hlc);
      state = res.nextState;
    }

    // User manually rolls device clock back to year 1999 offline
    const rolledBackMs = Date.parse('1999-01-01T00:00:00.000Z');
    const afterRollback = nextLocalHlc(state, rolledBackMs);
    generated.push(afterRollback.hlc);
    state = afterRollback.nextState;

    // Wall clock advances 10ms forward
    const afterAdvance = nextLocalHlc(state, t0 + 10);
    generated.push(afterAdvance.hlc);

    for (let i = 1; i < generated.length; i++) {
      expect(generated[i] > generated[i - 1]).toBe(true);
      expect(compareHlc(generated[i], generated[i - 1])).toBe(1);
    }

    // Counter resets to 0 once wallMs advances
    expect(unpackHlc(afterAdvance.hlc).counter).toBe(0);
  });

  it('throws on 16-bit logical counter overflow (> 0xffff)', () => {
    const saturated: HlcState = { lastWallMs: t0, counter: 0xffff, nodeId: nodeA };
    expect(() => nextLocalHlc(saturated, t0)).toThrow('HLC logical counter overflow');
  });

  it('advances state correctly when receiving a remote HLC ahead of local clock', () => {
    const localState: HlcState = { lastWallMs: t0, counter: 2, nodeId: nodeA };
    const remoteHlc = packHlc(t0 + 5000, 7, nodeB);

    const updatedState = receiveRemoteHlc(localState, remoteHlc, t0 + 100);
    expect(updatedState.lastWallMs).toBe(t0 + 5000);
    expect(updatedState.counter).toBe(8);
    expect(updatedState.nodeId).toBe(nodeA);
  });

  it('computes server time offset and corrected local time accurately', () => {
    const offset = computeServerTimeOffsetMs(t0 + 2500, t0);
    expect(offset).toBe(2500);
    expect(computeCorrectedNowMs(t0 + 1000, offset)).toBe(t0 + 3500);
  });

  it('merges disjoint and colliding columns deterministically via Field-Level LWW and enforces Tombstone Precedence', () => {
    const hlc1 = packHlc(t0, 1, nodeA);
    const hlc2 = packHlc(t0 + 100, 0, nodeB);
    const hlc3 = packHlc(t0 + 200, 0, nodeA);

    const recordA = {
      id: 'tx-1',
      amountCents: 10000, // Edited at hlc2
      categoryId: 'cat-1', // Original at hlc1
      description: 'Almoço',
      deletedAt: null as string | null,
      hlcTimestamp: hlc2,
      fieldHlc: {
        amountCents: hlc2,
        categoryId: hlc1,
        description: hlc1,
      },
    };

    const recordB = {
      id: 'tx-1',
      amountCents: 8000, // Older at hlc1
      categoryId: 'cat-2', // Edited at hlc3
      description: 'Almoço',
      deletedAt: null as string | null,
      hlcTimestamp: hlc3,
      fieldHlc: {
        amountCents: hlc1,
        categoryId: hlc3,
        description: hlc1,
      },
    };

    const mergedAB = mergeRecordLww(recordA, recordB, [
      'amountCents',
      'categoryId',
      'description',
    ]);
    const mergedBA = mergeRecordLww(recordB, recordA, [
      'amountCents',
      'categoryId',
      'description',
    ]);

    // Commutative convergence: amountCents = 10000 (hlc2 > hlc1), categoryId = 'cat-2' (hlc3 > hlc1)
    expect(mergedAB.amountCents).toBe(10000);
    expect(mergedAB.categoryId).toBe('cat-2');
    expect(mergedBA).toEqual(mergedAB);

    // Tombstone Precedence: if replica A soft-deletes the record, concurrent edit on B cannot resurrect it
    const deletedA = { ...recordA, deletedAt: '2026-11-06T18:45:12.500Z' };
    const mergedWithDelete = mergeRecordLww(deletedA, recordB, [
      'amountCents',
      'categoryId',
      'description',
    ]);
    expect(mergedWithDelete.deletedAt).toBe('2026-11-06T18:45:12.500Z');
  });
});
