import { create } from 'zustand';
import type { HouseholdMemberRole } from '@/data/schema';
import { persistHouseholdContext } from './householdPersistence';

/**
 * DEC-03: Biometric lock threshold after background inactivity (default: 2 minutes).
 */
export const BIOMETRIC_INACTIVITY_THRESHOLD_MS = 2 * 60 * 1000;

export type AuthStatus = 'INITIALIZING' | 'UNAUTHENTICATED' | 'AUTHENTICATED';

export interface EphemeralSessionPayload {
  userId: string;
  userEmail: string;
  activeHouseholdId?: string | null;
  memberRole?: HouseholdMemberRole | null;
}

export interface DbStatusPayload {
  ready: boolean;
  error?: string | null;
}

export interface SessionUIState {
  authStatus: AuthStatus;
  userId: string | null;
  userEmail: string | null;
  activeHouseholdId: string | null;
  memberRole: HouseholdMemberRole | null;
  isBiometricLocked: boolean;
  lastBackgroundedAtMs: number | null;
  isSyncHalted: boolean;
  revocationNotice: string | null;
  authError: string | null;
  /** True after ensureLocalSessionReady successfully opened SQLCipher. */
  dbReady: boolean;
  /** Visible vault open error (key/file), if any. */
  dbError: string | null;

  setSession: (
    session: EphemeralSessionPayload | null,
    options?: { lockBiometricsOnRestore?: boolean },
  ) => void;
  setHouseholdContext: (
    householdId: string | null,
    role: HouseholdMemberRole | null,
  ) => void;
  setDbStatus: (status: DbStatusPayload) => void;
  lockBiometrics: () => void;
  unlockBiometrics: () => void;
  recordBackgroundTimestamp: (timestampMs: number) => void;
  evaluateBackgroundInactivity: (
    nowMs: number,
    thresholdMs?: number,
  ) => boolean;
  markRevokedAndHalted: (notice?: string) => void;
  setAuthError: (error: string | null) => void;
  resetSessionUI: () => void;
}

const initialState = {
  authStatus: 'INITIALIZING' as AuthStatus,
  userId: null,
  userEmail: null,
  activeHouseholdId: null,
  memberRole: null,
  isBiometricLocked: true,
  lastBackgroundedAtMs: null,
  isSyncHalted: false,
  revocationNotice: null,
  authError: null,
  dbReady: false,
  dbError: null,
};

export const useSessionUIStore = create<SessionUIState>((set, get) => ({
  ...initialState,

  setSession: (session, options) => {
    if (!session) {
      set({
        authStatus: 'UNAUTHENTICATED',
        userId: null,
        userEmail: null,
        activeHouseholdId: null,
        memberRole: null,
        isBiometricLocked: false,
        lastBackgroundedAtMs: null,
        authError: null,
        dbReady: false,
        dbError: null,
      });
      void persistHouseholdContext(null, null);
      return;
    }

    const shouldLock = options?.lockBiometricsOnRestore ?? false;
    const nextHouseholdId =
      session.activeHouseholdId !== undefined
        ? session.activeHouseholdId
        : get().activeHouseholdId;
    const nextRole =
      session.memberRole !== undefined
        ? session.memberRole
        : get().memberRole;

    set((state) => ({
      authStatus: 'AUTHENTICATED',
      userId: session.userId,
      userEmail: session.userEmail.trim().toLowerCase(),
      activeHouseholdId: nextHouseholdId,
      memberRole: nextRole,
      isBiometricLocked: shouldLock ? true : state.isBiometricLocked,
      isSyncHalted: false,
      revocationNotice: null,
      authError: null,
    }));

    if (session.activeHouseholdId !== undefined) {
      void persistHouseholdContext(nextHouseholdId, nextRole);
    }
  },

  setHouseholdContext: (householdId, role) => {
    set({
      activeHouseholdId: householdId,
      memberRole: role,
    });
    void persistHouseholdContext(householdId, role);
  },

  setDbStatus: (status) => {
    set({
      dbReady: status.ready,
      dbError: status.error ?? null,
    });
  },

  lockBiometrics: () => {
    set({ isBiometricLocked: true });
  },

  unlockBiometrics: () => {
    set({
      isBiometricLocked: false,
      lastBackgroundedAtMs: null,
    });
  },

  recordBackgroundTimestamp: (timestampMs) => {
    set({ lastBackgroundedAtMs: timestampMs });
  },

  evaluateBackgroundInactivity: (
    nowMs,
    thresholdMs = BIOMETRIC_INACTIVITY_THRESHOLD_MS,
  ) => {
    const { authStatus, lastBackgroundedAtMs } = get();
    if (authStatus !== 'AUTHENTICATED') {
      return false;
    }
    if (lastBackgroundedAtMs === null) {
      return get().isBiometricLocked;
    }

    const elapsedMs = nowMs - lastBackgroundedAtMs;
    if (elapsedMs >= thresholdMs) {
      set({
        isBiometricLocked: true,
        lastBackgroundedAtMs: null,
      });
      return true;
    }

    set({ lastBackgroundedAtMs: null });
    return get().isBiometricLocked;
  },

  markRevokedAndHalted: (
    notice = 'Seu acesso ao lar foi revogado. Os dados locais foram apagados por segurança.',
  ) => {
    set({
      authStatus: 'UNAUTHENTICATED',
      userId: null,
      userEmail: null,
      activeHouseholdId: null,
      memberRole: null,
      isBiometricLocked: false,
      lastBackgroundedAtMs: null,
      isSyncHalted: true,
      revocationNotice: notice,
      authError: null,
      dbReady: false,
      dbError: null,
    });
    void persistHouseholdContext(null, null);
  },

  setAuthError: (error) => {
    set({ authError: error });
  },

  resetSessionUI: () => {
    set({ ...initialState });
    void persistHouseholdContext(null, null);
  },
}));
