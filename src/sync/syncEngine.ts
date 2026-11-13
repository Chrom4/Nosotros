import { eq } from 'drizzle-orm';
import {
  type AppDatabase,
  applyRemoteChanges,
  getSyncMetaValue,
  households,
  notifyDatabaseChange,
  setSyncMetaValue,
  subscribeToDatabaseChanges,
  SYNC_META_KEYS,
  type SyncableTableName,
  type SyncOutboxRow,
} from '@/data';
import { useSyncStatusStore } from '@/store/syncStatus';
import { logger } from '@/utils/logger';
import type { NetworkMonitor } from './networkMonitor';
import {
  ackOutboxRows,
  countOutbox,
  failOutboxRowsPermanently,
  MAX_PUSH_BATCH_SIZE,
  markOutboxInFlight,
  releaseOutboxRows,
  resetInFlightToPending,
  selectPendingBatch,
} from './outboxCoalesce';
import {
  type SyncBackendGateway,
  SyncError,
  type WireChange,
} from './syncGateway';
import {
  outboxRowToWireMutation,
  wireChangeToRemoteChange,
} from './wireFormat';

export const PULL_PAGE_SIZE = 500;
export const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 15_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const DEFAULT_DEBOUNCE_MS = 1_500;

export { resetInFlightToPending };

export type SyncOutcome = 'OK' | 'OFFLINE' | 'ERROR' | 'HALTED';

export interface SyncCycleResult {
  outcome: SyncOutcome;
  /** Mutations acknowledged by the server in this cycle. */
  pushed: number;
  /** Mutations the server had already processed (idempotent re-send). */
  skippedIdempotent: number;
  /** Remote changes applied locally in this cycle. */
  pulled: number;
  error?: SyncError;
}

/**
 * Status sink for the UI indicator (defaults to the Zustand store).
 */
export interface SyncStatusReporter {
  setStatus(status: 'IDLE' | 'SYNCING' | 'OFFLINE'): void;
  setCounts(pending: number, failed: number): void;
  setError(code: string, message: string): void;
  markSynced(atMs: number): void;
}

export function createStoreStatusReporter(): SyncStatusReporter {
  return {
    setStatus: (status) => useSyncStatusStore.getState().setSyncStatus(status),
    setCounts: (pending, failed) =>
      useSyncStatusStore.getState().setOutboxCounts(pending, failed),
    setError: (code, message) =>
      useSyncStatusStore.getState().setSyncError(code, message),
    markSynced: (atMs) => useSyncStatusStore.getState().markSynced(atMs),
  };
}

export interface SyncEngineOptions {
  db: AppDatabase;
  householdId: string;
  gateway: SyncBackendGateway;
  network: NetworkMonitor;
  status?: SyncStatusReporter;
  /** Push batch size (hard-capped at 100). */
  batchSize?: number;
  pullPageSize?: number;
  /** Transient failures per mutation before it parks as `FAILED_PERMANENT`. */
  maxRetries?: number;
  /** Base for exponential retry backoff; `null` disables automatic retries. */
  retryBaseMs?: number | null;
  /** Delay before syncing after local writes; `null` disables write-triggered sync. */
  debounceMs?: number | null;
  nowMs?: () => number;
}

export interface SyncEngine {
  /** Boots the engine (crash recovery, network wiring) and runs the first cycle when online. */
  start(): Promise<SyncCycleResult | null>;
  stop(): void;
  /** Runs one push+pull cycle now (coalesces concurrent calls). */
  syncNow(): Promise<SyncCycleResult>;
  isRunning(): boolean;
}

function toSyncError(err: unknown): SyncError {
  if (err instanceof SyncError) return err;
  return new SyncError(
    'TRANSIENT',
    err instanceof Error ? err.message : 'Unknown sync failure',
  );
}

function readEpoch(db: AppDatabase, householdId: string): number | null {
  const stored = getSyncMetaValue(db, SYNC_META_KEYS.SYNC_EPOCH);
  if (stored !== null) {
    const parsed = Number(stored);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  const household = db
    .select()
    .from(households)
    .where(eq(households.id, householdId))
    .get();
  return household ? household.syncEpoch : null;
}

function readCursor(db: AppDatabase): number {
  return (
    Number(getSyncMetaValue(db, SYNC_META_KEYS.LAST_SERVER_SEQ) ?? '0') || 0
  );
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { db, householdId, gateway, network } = options;
  const status = options.status ?? createStoreStatusReporter();
  const batchSize = Math.min(
    options.batchSize ?? MAX_PUSH_BATCH_SIZE,
    MAX_PUSH_BATCH_SIZE,
  );
  const pullPageSize = options.pullPageSize ?? PULL_PAGE_SIZE;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs =
    options.retryBaseMs === undefined
      ? DEFAULT_RETRY_BASE_MS
      : options.retryBaseMs;
  const debounceMs =
    options.debounceMs === undefined ? DEFAULT_DEBOUNCE_MS : options.debounceMs;
  const nowMs = options.nowMs ?? Date.now;

  let started = false;
  let online = true;
  let halted = false;
  let applyingRemote = false;
  let rerunRequested = false;
  let inFlightCycle: Promise<SyncCycleResult> | null = null;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeNetwork: (() => void) | null = null;
  let unsubscribeDb: (() => void) | null = null;

  function refreshCounts(): void {
    const counts = countOutbox(db);
    status.setCounts(counts.pending + counts.inFlight, counts.failedPermanent);
  }

  function clearTimers(): void {
    if (retryTimer) clearTimeout(retryTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    retryTimer = null;
    debounceTimer = null;
  }

  function scheduleRetry(): void {
    if (retryBaseMs === null || !started || !online || halted) return;
    if (retryTimer) clearTimeout(retryTimer);
    const delay = Math.min(retryBaseMs * 2 ** retryAttempt, MAX_RETRY_DELAY_MS);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void syncNow();
    }, delay);
  }

  /** Pushes `rows` (already `PENDING`); isolates poison rows by bisecting permanent failures. */
  async function pushRows(
    rows: SyncOutboxRow[],
    totals: { pushed: number; skipped: number },
  ): Promise<void> {
    markOutboxInFlight(db, rows);

    const epoch = readEpoch(db, householdId) ?? 1;
    try {
      const result = await gateway.pushBatch({
        householdId,
        syncEpoch: epoch,
        mutations: rows.map(outboxRowToWireMutation),
      });
      ackOutboxRows(db, rows);
      totals.pushed += result.accepted;
      totals.skipped += result.skippedIdempotent;
      return;
    } catch (err) {
      const syncError = toSyncError(err);

      if (syncError.code === 'PERMANENT') {
        if (rows.length === 1) {
          failOutboxRowsPermanently(db, rows, syncError.message);
          return;
        }
        const mid = Math.ceil(rows.length / 2);
        const second = rows.slice(mid);
        try {
          await pushRows(rows.slice(0, mid), totals);
        } catch (inner) {
          releaseOutboxRows(db, second, {
            error: toSyncError(inner).message,
            countRetry: false,
            maxRetries,
          });
          throw inner;
        }
        await pushRows(second, totals);
        return;
      }

      releaseOutboxRows(db, rows, {
        error: syncError.message,
        countRetry: syncError.code === 'TRANSIENT',
        maxRetries,
      });
      throw syncError;
    }
  }

  async function pushPending(totals: {
    pushed: number;
    skipped: number;
  }): Promise<void> {
    for (;;) {
      const batch = selectPendingBatch(db, batchSize);
      if (batch.length === 0) return;
      await pushRows(batch, totals);
      refreshCounts();
    }
  }

  function applyPage(changes: WireChange[], epoch: number): number {
    const ordered = [...changes].sort((a, b) => a.server_seq - b.server_seq);
    const envelopes = ordered.map((c) => ({
      change: wireChangeToRemoteChange(c),
      serverSeq: c.server_seq,
    }));
    const maxSeq = ordered[ordered.length - 1].server_seq;

    let touched: SyncableTableName[] = [];
    try {
      // Single SQLite transaction: domain merges + HLC state + cursor advance, all or nothing.
      db.transaction((tx) => {
        touched = applyRemoteChanges(tx, envelopes, { nowMs: nowMs() });
        setSyncMetaValue(tx, SYNC_META_KEYS.LAST_SERVER_SEQ, String(maxSeq));
        setSyncMetaValue(tx, SYNC_META_KEYS.SYNC_EPOCH, String(epoch));
      });
    } catch (err) {
      throw new SyncError(
        'TRANSIENT',
        `Failed to apply remote changes: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    applyingRemote = true;
    try {
      for (const table of touched) notifyDatabaseChange(table);
    } finally {
      applyingRemote = false;
    }
    return ordered.length;
  }

  async function pullAll(): Promise<number> {
    let pulled = 0;
    let cursor = readCursor(db);
    for (;;) {
      const page = await gateway.pullChanges({
        householdId,
        lastServerSeq: cursor,
        limit: pullPageSize,
      });

      const localEpoch = readEpoch(db, householdId);
      if (localEpoch !== null && localEpoch !== page.syncEpoch) {
        throw new SyncError(
          'EPOCH_MISMATCH',
          `Local sync epoch ${localEpoch} differs from server epoch ${page.syncEpoch}`,
        );
      }

      if (page.changes.length === 0) {
        if (localEpoch === null) {
          setSyncMetaValue(
            db,
            SYNC_META_KEYS.SYNC_EPOCH,
            String(page.syncEpoch),
          );
        }
        return pulled;
      }

      pulled += applyPage(page.changes, page.syncEpoch);
      cursor = readCursor(db);
      if (!page.hasMore) return pulled;
    }
  }

  async function runCycle(): Promise<SyncCycleResult> {
    const result: SyncCycleResult = {
      outcome: 'OK',
      pushed: 0,
      skippedIdempotent: 0,
      pulled: 0,
    };

    if (halted) return { ...result, outcome: 'HALTED' };
    if (!online) {
      status.setStatus('OFFLINE');
      return { ...result, outcome: 'OFFLINE' };
    }

    status.setStatus('SYNCING');
    const totals = { pushed: 0, skipped: 0 };
    try {
      // Without a known epoch, learn it from the server before pushing.
      if (readEpoch(db, householdId) === null) {
        result.pulled += await pullAll();
      }
      await pushPending(totals);
      result.pulled += await pullAll();
      result.pushed = totals.pushed;
      result.skippedIdempotent = totals.skipped;

      retryAttempt = 0;
      refreshCounts();
      status.markSynced(nowMs());
      return result;
    } catch (err) {
      const syncError = toSyncError(err);
      result.pushed = totals.pushed;
      result.skippedIdempotent = totals.skipped;
      result.error = syncError;
      refreshCounts();
      logger.warn('sync cycle failed', { code: syncError.code });

      if (syncError.code === 'NETWORK') {
        status.setStatus('OFFLINE');
        result.outcome = 'OFFLINE';
        scheduleRetry();
      } else if (syncError.code === 'EPOCH_MISMATCH') {
        // Never auto-recover: applying data across epochs would corrupt local state.
        halted = true;
        status.setError(syncError.code, syncError.message);
        result.outcome = 'HALTED';
      } else if (syncError.code === 'AUTH') {
        status.setError(syncError.code, syncError.message);
        result.outcome = 'ERROR';
      } else {
        status.setError(syncError.code, syncError.message);
        result.outcome = 'ERROR';
        scheduleRetry();
      }
      return result;
    }
  }

  function syncNow(): Promise<SyncCycleResult> {
    if (inFlightCycle) {
      rerunRequested = true;
      return inFlightCycle;
    }
    inFlightCycle = (async () => {
      let result: SyncCycleResult;
      do {
        rerunRequested = false;
        result = await runCycle();
      } while (rerunRequested && result.outcome === 'OK');
      return result;
    })().finally(() => {
      inFlightCycle = null;
    });
    return inFlightCycle;
  }

  function onNetworkChange(isOnline: boolean): void {
    online = isOnline;
    if (!isOnline) {
      // Suspend: no timers, no requests until connectivity returns.
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      status.setStatus('OFFLINE');
      return;
    }
    retryAttempt = 0;
    void syncNow();
  }

  function onLocalWrite(): void {
    if (applyingRemote || !started) return;
    // The notification fires inside the writer's transaction: count once it has settled.
    queueMicrotask(refreshCounts);
    if (debounceMs === null || !online || halted) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void syncNow();
    }, debounceMs);
  }

  return {
    async start() {
      if (started) return null;
      started = true;
      halted = false;

      const recovered = resetInFlightToPending(db);
      if (recovered > 0) {
        logger.info('sync outbox crash recovery', { recovered });
      }
      refreshCounts();

      try {
        online = await network.isOnline();
      } catch {
        online = true;
      }
      unsubscribeNetwork = network.subscribe(onNetworkChange);
      unsubscribeDb = subscribeToDatabaseChanges(onLocalWrite);

      if (!online) {
        status.setStatus('OFFLINE');
        return {
          outcome: 'OFFLINE',
          pushed: 0,
          skippedIdempotent: 0,
          pulled: 0,
        };
      }
      status.setStatus('IDLE');
      return syncNow();
    },

    stop() {
      started = false;
      clearTimers();
      unsubscribeNetwork?.();
      unsubscribeDb?.();
      unsubscribeNetwork = null;
      unsubscribeDb = null;
    },

    syncNow,

    isRunning: () => started,
  };
}

// ---------------------------------------------------------------------------
// App-level lifecycle (singleton)
// ---------------------------------------------------------------------------

export interface StartSyncEngineOptions
  extends Omit<SyncEngineOptions, 'gateway' | 'network'> {
  gateway?: SyncBackendGateway;
  network?: NetworkMonitor;
}

let activeEngine: SyncEngine | null = null;

/**
 * Starts (or restarts) the app-wide sync engine. Defaults to the Supabase RPC gateway and
 * NetInfo connectivity; both are loaded lazily so tests never touch native modules.
 */
export async function startSyncEngine(
  options: StartSyncEngineOptions,
): Promise<SyncEngine> {
  stopSyncEngine();

  const gateway =
    options.gateway ??
    (await import('./supabaseSyncGateway')).createSupabaseSyncGateway();
  const network =
    options.network ??
    (await import('./netInfoMonitor')).createNetInfoMonitor();

  const engine = createSyncEngine({ ...options, gateway, network });
  activeEngine = engine;
  await engine.start();
  return engine;
}

export function stopSyncEngine(): void {
  if (!activeEngine) return;
  activeEngine.stop();
  activeEngine = null;
  useSyncStatusStore.getState().resetSyncStatus();
}

export function getActiveSyncEngine(): SyncEngine | null {
  return activeEngine;
}
