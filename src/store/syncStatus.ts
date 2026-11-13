import { create } from 'zustand';

/**
 * Ephemeral UI state for the sync indicator (AGENTS.md: Zustand only for ephemeral UI state).
 */
export type SyncStatus = 'IDLE' | 'SYNCING' | 'OFFLINE' | 'ERROR';

export interface SyncStatusState {
  syncStatus: SyncStatus;
  /** Outbox rows waiting to be pushed (`PENDING` + `IN_FLIGHT`). */
  pendingCount: number;
  /** Outbox rows the server rejected permanently (`FAILED_PERMANENT`). */
  failedCount: number;
  lastError: string | null;
  lastErrorCode: string | null;
  lastSyncedAtMs: number | null;

  setSyncStatus: (status: SyncStatus) => void;
  setOutboxCounts: (pendingCount: number, failedCount: number) => void;
  setSyncError: (code: string, message: string) => void;
  markSynced: (atMs: number) => void;
  resetSyncStatus: () => void;
}

const initialState = {
  syncStatus: 'IDLE' as SyncStatus,
  pendingCount: 0,
  failedCount: 0,
  lastError: null as string | null,
  lastErrorCode: null as string | null,
  lastSyncedAtMs: null as number | null,
};

export const useSyncStatusStore = create<SyncStatusState>((set) => ({
  ...initialState,

  setSyncStatus: (status) => {
    set({
      syncStatus: status,
      ...(status === 'SYNCING' || status === 'IDLE'
        ? { lastError: null, lastErrorCode: null }
        : {}),
    });
  },

  setOutboxCounts: (pendingCount, failedCount) => {
    set({ pendingCount, failedCount });
  },

  setSyncError: (code, message) => {
    set({ syncStatus: 'ERROR', lastError: message, lastErrorCode: code });
  },

  markSynced: (atMs) => {
    set({
      syncStatus: 'IDLE',
      lastSyncedAtMs: atMs,
      lastError: null,
      lastErrorCode: null,
    });
  },

  resetSyncStatus: () => {
    set({ ...initialState });
  },
}));
