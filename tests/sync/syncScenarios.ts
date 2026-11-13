import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/data/db';
import {
  createCreditCard,
  listTransactionsByCompetenceMonth,
  restoreTransaction,
  softDeleteTransaction,
  updateAccount,
  updateTransaction,
} from '@/data/repositories';
import {
  accounts,
  categories,
  creditCards,
  SYNC_META_KEYS,
  syncMeta,
  syncOutbox,
  transactions,
} from '@/data/schema';
import {
  ACCOUNT_1_ID,
  ACCOUNT_2_ID,
  CARD_1_ID,
  CATEGORY_CHILD_ID,
  CATEGORY_ROOT_ID,
  createTestClient,
  faultyGateway,
  HOUSEHOLD_ID,
  seedAccount,
  seedCategories,
  seedExpense,
  type ServerFixture,
  spyGateway,
  T0,
  type TestClient,
  TX_1_ID,
  USER_A_ID,
  USER_B_ID,
} from './syncTestKit';

type Omit_<T, K extends string> = Omit<T, K>;

/** Domain state minus device-local bookkeeping (cursor, HLC row stamps, updated_at). */
function dumpDomain(db: AppDatabase) {
  const strip = <T extends Record<string, unknown>>(rows: T[]) =>
    rows
      .map((row) => {
        const copy: Record<string, unknown> = { ...row };
        delete copy.serverSeq;
        delete copy.hlcTimestamp;
        delete copy.fieldHlc;
        delete copy.updatedAt;
        return copy as Omit_<T, 'serverSeq' | 'hlcTimestamp' | 'fieldHlc' | 'updatedAt'>;
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    accounts: strip(db.select().from(accounts).all()),
    categories: strip(db.select().from(categories).all()),
    creditCards: strip(db.select().from(creditCards).all()),
    transactions: strip(db.select().from(transactions).all()),
  };
}

function cursorOf(db: AppDatabase): number {
  const row = db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, SYNC_META_KEYS.LAST_SERVER_SEQ))
    .get();
  return row ? Number(row.value) : 0;
}

function pendingOutbox(db: AppDatabase) {
  return db.select().from(syncOutbox).all();
}

/**
 * TEST-SYNC-A, B, C, D, EF — executed against any `ServerFixture` (in-memory and real SQL).
 */
export function registerServerScenarios(
  label: string,
  getServer: () => ServerFixture,
): void {
  describe(`${label}: Phase 4 sync scenarios`, () => {
    let a: TestClient;
    let b: TestClient;

    beforeEach(async () => {
      await getServer().reset();
      a = createTestClient({
        name: 'A',
        userId: USER_A_ID,
        nodeId: 'aaaaaaaa0001',
        clockStartMs: T0,
      });
      // Device B's wall clock runs one hour ahead of A.
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

    const engineFor = (c: TestClient, overrides = {}) =>
      c.makeEngine(getServer().gatewayFor(c.userId), overrides);

    it('TEST-SYNC-A: basic push then pull converges two clients', async () => {
      seedAccount(a);
      seedCategories(a);
      seedExpense(a);
      expect(pendingOutbox(a.db)).toHaveLength(4);

      const engineA = engineFor(a);
      const engineB = engineFor(b);

      const resultA = await engineA.syncNow();
      expect(resultA).toMatchObject({ outcome: 'OK', pushed: 4 });
      expect(pendingOutbox(a.db)).toHaveLength(0);
      expect(await getServer().processedCount()).toBe(4);

      const resultB = await engineB.syncNow();
      expect(resultB).toMatchObject({ outcome: 'OK', pushed: 0, pulled: 4 });
      expect(dumpDomain(b.db)).toEqual(dumpDomain(a.db));
      expect(cursorOf(b.db)).toBeGreaterThan(0);
      expect(cursorOf(b.db)).toBe(cursorOf(a.db));

      // Reverse direction: B edits, A converges.
      updateAccount(
        b.db,
        ACCOUNT_1_ID,
        { name: 'Renomeada pelo B' },
        { nowMs: b.tick() },
      );
      await engineB.syncNow();
      await engineA.syncNow();
      expect(dumpDomain(a.db)).toEqual(dumpDomain(b.db));
      expect(
        a.db.select().from(accounts).where(eq(accounts.id, ACCOUNT_1_ID)).get()
          ?.name,
      ).toBe('Renomeada pelo B');

      // Nothing left to do.
      const idle = await engineA.syncNow();
      expect(idle).toMatchObject({ outcome: 'OK', pushed: 0, pulled: 0 });
    });

    it('TEST-SYNC-A: pulls in pages and advances the cursor per page transaction', async () => {
      seedAccount(a);
      seedAccount(a, ACCOUNT_2_ID, 'Poupança');
      seedCategories(a);
      seedExpense(a);
      await engineFor(a).syncNow();

      const spy = spyGateway(getServer().gatewayFor(b.userId));
      const engineB = b.makeEngine(spy.gateway, { pullPageSize: 2 });
      const result = await engineB.syncNow();

      expect(result).toMatchObject({ outcome: 'OK', pulled: 5 });
      expect(spy.pulls).toBe(3); // 2 + 2 + 1
      expect(dumpDomain(b.db)).toEqual(dumpDomain(a.db));
    });

    it('TEST-SYNC-B: coalesces same-record updates into one mutation', async () => {
      seedAccount(a);
      updateAccount(a.db, ACCOUNT_1_ID, { name: 'Segunda' }, { nowMs: a.tick() });
      updateAccount(a.db, ACCOUNT_1_ID, { name: 'Terceira' }, { nowMs: a.tick() });

      const rows = pendingOutbox(a.db).filter((r) => r.recordId === ACCOUNT_1_ID);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].payloadJson).name).toBe('Terceira');

      const spy = spyGateway(getServer().gatewayFor(a.userId));
      await a.makeEngine(spy.gateway).syncNow();
      expect(spy.pushes.flat()).toHaveLength(1);
      expect(await getServer().processedCount()).toBe(1);

      await engineFor(b).syncNow();
      expect(
        b.db.select().from(accounts).where(eq(accounts.id, ACCOUNT_1_ID)).get()
          ?.name,
      ).toBe('Terceira');
    });

    it('TEST-SYNC-B: does not coalesce into an IN_FLIGHT row', async () => {
      seedAccount(a);
      a.db
        .update(syncOutbox)
        .set({ status: 'IN_FLIGHT' })
        .where(eq(syncOutbox.recordId, ACCOUNT_1_ID))
        .run();

      updateAccount(a.db, ACCOUNT_1_ID, { name: 'Depois do envio' }, { nowMs: a.tick() });
      const rows = pendingOutbox(a.db).filter((r) => r.recordId === ACCOUNT_1_ID);
      expect(rows.map((r) => r.status).sort()).toEqual(['IN_FLIGHT', 'PENDING']);
    });

    it('TEST-SYNC-C: pushes parents before dependants (account -> card -> transaction)', async () => {
      // Queue order is deliberately NOT topological:
      // account1, categories, transaction, card, account2
      seedAccount(a);
      seedCategories(a);
      seedExpense(a);
      createCreditCard(
        a.db,
        {
          id: CARD_1_ID,
          householdId: HOUSEHOLD_ID,
          ownerUserId: USER_A_ID,
          defaultPaymentAccountId: ACCOUNT_1_ID,
          name: 'Cartão',
          limitCents: 300_000,
          closingDay: 10,
          dueDay: 17,
          isArchived: false,
        },
        { nowMs: a.tick() },
      );
      seedAccount(a, ACCOUNT_2_ID, 'Conta nova');

      const spy = spyGateway(getServer().gatewayFor(a.userId));
      const result = await a.makeEngine(spy.gateway).syncNow();
      expect(result).toMatchObject({ outcome: 'OK', pushed: 6 });

      const tables = spy.pushes.flat().map((m) => m.table_name);
      expect(tables).toEqual([
        'accounts',
        'accounts',
        'categories',
        'categories',
        'credit_cards',
        'transactions',
      ]);
      // Root category precedes its child.
      const categoryIds = spy.pushes
        .flat()
        .filter((m) => m.table_name === 'categories')
        .map((m) => m.record_id);
      expect(categoryIds).toEqual([CATEGORY_ROOT_ID, CATEGORY_CHILD_ID]);

      await engineFor(b).syncNow();
      expect(dumpDomain(b.db)).toEqual(dumpDomain(a.db));
    });

    it('TEST-SYNC-C: sorts globally before slicing, so small batches never split parent from child', async () => {
      seedAccount(a);
      seedCategories(a);
      seedExpense(a);
      seedAccount(a, ACCOUNT_2_ID, 'Conta nova');

      const spy = spyGateway(getServer().gatewayFor(a.userId));
      const result = await a.makeEngine(spy.gateway, { batchSize: 2 }).syncNow();

      expect(result).toMatchObject({ outcome: 'OK', pushed: 5 });
      expect(spy.pushes.map((p) => p.length)).toEqual([2, 2, 1]);
      expect(spy.pushes.flat().map((m) => m.table_name)).toEqual([
        'accounts',
        'accounts',
        'categories',
        'categories',
        'transactions',
      ]);
    });

    describe('TEST-SYNC-D: Tombstone Precedence', () => {
      async function seedSharedTransaction() {
        seedAccount(a);
        seedCategories(a);
        seedExpense(a);
        const engineA = engineFor(a);
        const engineB = engineFor(b);
        await engineA.syncNow();
        await engineB.syncNow();
        expect(dumpDomain(b.db)).toEqual(dumpDomain(a.db));
        return { engineA, engineB };
      }

      const activeCount = (c: TestClient) =>
        listTransactionsByCompetenceMonth(c.db, HOUSEHOLD_ID, '2026-11').length;

      it('delete wins over a LATER concurrent field edit (delete delivered first)', async () => {
        const { engineA, engineB } = await seedSharedTransaction();

        softDeleteTransaction(a.db, TX_1_ID, { nowMs: a.tick() });
        updateTransaction(
          b.db,
          TX_1_ID,
          { description: 'Editada pelo B', amountCents: 99_999 },
          { nowMs: b.tick() },
        );

        await engineA.syncNow();
        await engineB.syncNow();
        await engineA.syncNow();

        for (const c of [a, b]) {
          const row = c.db
            .select()
            .from(transactions)
            .where(eq(transactions.id, TX_1_ID))
            .get()!;
          expect(row.deletedAt).not.toBeNull();
          // Field-level merge still applies to the tombstoned row.
          expect(row.description).toBe('Editada pelo B');
          expect(row.amountCents).toBe(99_999);
          expect(activeCount(c)).toBe(0);
        }
        expect(dumpDomain(a.db)).toEqual(dumpDomain(b.db));
        const serverRow = await getServer().getRow('transactions', TX_1_ID);
        expect(serverRow?.deleted_at).not.toBeNull();
      });

      it('delete wins over a LATER concurrent field edit (edit delivered first)', async () => {
        const { engineA, engineB } = await seedSharedTransaction();

        softDeleteTransaction(a.db, TX_1_ID, { nowMs: a.tick() });
        updateTransaction(
          b.db,
          TX_1_ID,
          { description: 'Editada pelo B' },
          { nowMs: b.tick() },
        );

        await engineB.syncNow();
        await engineA.syncNow();
        await engineB.syncNow();

        expect(dumpDomain(a.db)).toEqual(dumpDomain(b.db));
        for (const c of [a, b]) {
          expect(activeCount(c)).toBe(0);
          expect(
            c.db.select().from(transactions).where(eq(transactions.id, TX_1_ID)).get()
              ?.description,
          ).toBe('Editada pelo B');
        }
      });

      it('a NEWER restore lifts the tombstone on every device', async () => {
        const { engineA, engineB } = await seedSharedTransaction();

        softDeleteTransaction(a.db, TX_1_ID, { nowMs: a.tick() });
        await engineA.syncNow();
        await engineB.syncNow();
        expect(activeCount(b)).toBe(0);

        restoreTransaction(b.db, TX_1_ID, { nowMs: b.tick() });
        await engineB.syncNow();
        await engineA.syncNow();

        expect(activeCount(a)).toBe(1);
        expect(activeCount(b)).toBe(1);
        expect(dumpDomain(a.db)).toEqual(dumpDomain(b.db));
      });

      it.each([
        ['delete delivered first', 'A'],
        ['restore delivered first', 'B'],
      ])(
        'an OLDER restore never beats a newer delete (%s)',
        async (_name, first) => {
          const { engineA, engineB } = await seedSharedTransaction();

          // B's wall clock is ahead, so make A's delete the newer event by delaying it.
          restoreTransaction(b.db, TX_1_ID, { nowMs: T0 + 3_700_000 });
          softDeleteTransaction(a.db, TX_1_ID, { nowMs: T0 + 3_800_000 });

          const order = first === 'A' ? [engineA, engineB] : [engineB, engineA];
          await order[0].syncNow();
          await order[1].syncNow();
          await engineA.syncNow();
          await engineB.syncNow();

          expect(activeCount(a)).toBe(0);
          expect(activeCount(b)).toBe(0);
          expect(dumpDomain(a.db)).toEqual(dumpDomain(b.db));
        },
      );
    });

    it('TEST-SYNC-EF: re-sending after a lost acknowledgement is idempotent', async () => {
      seedAccount(a);
      seedCategories(a);
      seedExpense(a);

      const faulty = faultyGateway(getServer().gatewayFor(a.userId));
      const engineA = a.makeEngine(faulty.gateway);

      faulty.dropNextPushResponse();
      const first = await engineA.syncNow();
      expect(first.outcome).toBe('OFFLINE'); // response lost -> client treats as network failure
      expect(pendingOutbox(a.db)).toHaveLength(4);
      expect(pendingOutbox(a.db).every((r) => r.status === 'PENDING')).toBe(true);
      // Server already applied everything.
      expect(await getServer().processedCount()).toBe(4);

      const second = await engineA.syncNow();
      expect(second).toMatchObject({ outcome: 'OK', pushed: 0, skippedIdempotent: 4 });
      expect(pendingOutbox(a.db)).toHaveLength(0);
      expect(await getServer().processedCount()).toBe(4);

      await engineFor(b).syncNow();
      expect(dumpDomain(b.db)).toEqual(dumpDomain(a.db));
      expect(b.db.select().from(transactions).all()).toHaveLength(1);
    });

    it('TEST-SYNC-EF: replaying old mutations never reverts newer data', async () => {
      seedAccount(a);
      const spy = spyGateway(getServer().gatewayFor(a.userId));
      const engineA = a.makeEngine(spy.gateway);
      await engineA.syncNow();
      const creation = spy.pushes[0][0];

      updateAccount(a.db, ACCOUNT_1_ID, { name: 'Nome novo' }, { nowMs: a.tick() });
      await engineA.syncNow();

      const server = getServer().gatewayFor(a.userId);

      // Same mutation_id: skipped by the idempotency ledger.
      const sameId = await server.pushBatch({
        householdId: HOUSEHOLD_ID,
        syncEpoch: 1,
        mutations: [creation],
      });
      expect(sameId).toMatchObject({ accepted: 0, skippedIdempotent: 1 });

      // Fresh mutation_id but stale per-field HLCs: accepted, yet nothing is overwritten.
      const staleContent = await server.pushBatch({
        householdId: HOUSEHOLD_ID,
        syncEpoch: 1,
        mutations: [
          { ...creation, mutation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        ],
      });
      expect(staleContent).toMatchObject({ accepted: 1, skippedIdempotent: 0 });

      await engineFor(b).syncNow();
      expect(
        b.db.select().from(accounts).where(eq(accounts.id, ACCOUNT_1_ID)).get()
          ?.name,
      ).toBe('Nome novo');
      expect((await getServer().getRow('accounts', ACCOUNT_1_ID))?.name).toBe(
        'Nome novo',
      );
    });
  });
}
