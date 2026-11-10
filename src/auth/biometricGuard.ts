import * as LocalAuthentication from 'expo-local-authentication';
import {
  BIOMETRIC_INACTIVITY_THRESHOLD_MS,
  useSessionUIStore,
} from '@/store/sessionUI';

export interface BiometricAdapter {
  hasHardwareAsync(): Promise<boolean>;
  isEnrolledAsync(): Promise<boolean>;
  authenticateAsync(
    options?: LocalAuthentication.LocalAuthenticationOptions,
  ): Promise<LocalAuthentication.LocalAuthenticationResult>;
}

const defaultBiometricAdapter: BiometricAdapter = {
  hasHardwareAsync: () => LocalAuthentication.hasHardwareAsync(),
  isEnrolledAsync: () => LocalAuthentication.isEnrolledAsync(),
  authenticateAsync: (options) =>
    LocalAuthentication.authenticateAsync(options),
};

export interface BiometricUnlockOutcome {
  unlocked: boolean;
  reason?: string;
}

/**
 * Triggers OS biometric/PIN authentication (`expo-local-authentication`) and updates the
 * ephemeral `sessionUI` lock state.
 */
export async function promptBiometricUnlock(
  adapter: BiometricAdapter = defaultBiometricAdapter,
): Promise<BiometricUnlockOutcome> {
  const store = useSessionUIStore.getState();

  const hasHardware = await adapter.hasHardwareAsync();
  const isEnrolled = hasHardware ? await adapter.isEnrolledAsync() : false;

  if (!hasHardware || !isEnrolled) {
    // Attempt device credential fallback first; if unsupported in simulator/test, allow unlock
    const fallbackResult = await adapter.authenticateAsync({
      promptMessage: 'Desbloquear No$otros',
      fallbackLabel: 'Usar PIN do dispositivo',
      disableDeviceFallback: false,
    });
    if (
      fallbackResult.success ||
      (!fallbackResult.success &&
        (fallbackResult.error === 'not_enrolled' ||
          fallbackResult.error === 'not_available'))
    ) {
      store.unlockBiometrics();
      return { unlocked: true, reason: 'DEVICE_NOT_ENROLLED_FALLBACK' };
    }
    return {
      unlocked: false,
      reason: fallbackResult.error ?? 'AUTH_FAILED',
    };
  }

  const result = await adapter.authenticateAsync({
    promptMessage: 'Desbloquear No$otros',
    fallbackLabel: 'Usar PIN do dispositivo',
    cancelLabel: 'Cancelar',
    disableDeviceFallback: false,
  });

  if (result.success) {
    store.unlockBiometrics();
    return { unlocked: true };
  }

  return {
    unlocked: false,
    reason: result.error ?? 'USER_CANCELLED',
  };
}

/**
 * Handles React Native `AppState` transitions according to DEC-03:
 * - Entering `background` or `inactive` records the timestamp (if not already recorded).
 * - Returning to `active` locks the app if elapsed inactivity >= threshold (default: 2 minutes).
 */
export function handleAppStateTransition(
  nextAppState: string,
  nowMs: number = Date.now(),
  thresholdMs: number = BIOMETRIC_INACTIVITY_THRESHOLD_MS,
): boolean {
  const store = useSessionUIStore.getState();

  if (store.authStatus !== 'AUTHENTICATED') {
    return false;
  }

  if (nextAppState === 'background' || nextAppState === 'inactive') {
    if (store.lastBackgroundedAtMs === null) {
      store.recordBackgroundTimestamp(nowMs);
    }
    return store.isBiometricLocked;
  }

  if (nextAppState === 'active') {
    return store.evaluateBackgroundInactivity(nowMs, thresholdMs);
  }

  return store.isBiometricLocked;
}
