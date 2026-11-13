import * as SecureStore from 'expo-secure-store';

export const BIOMETRICS_ENABLED_KEY = 'device_biometrics_enabled_v1';

export interface DevicePreferencesAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

const defaultAdapter: DevicePreferencesAdapter = {
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
};

/**
 * DEC-03 preference: whether background inactivity should lock behind biometrics.
 * Defaults to enabled when unset.
 */
export async function getBiometricsEnabled(
  adapter: DevicePreferencesAdapter = defaultAdapter,
): Promise<boolean> {
  const raw = await adapter.getItemAsync(BIOMETRICS_ENABLED_KEY);
  if (raw === null) {
    return true;
  }
  return raw === '1' || raw.toLowerCase() === 'true';
}

export async function setBiometricsEnabled(
  enabled: boolean,
  adapter: DevicePreferencesAdapter = defaultAdapter,
): Promise<void> {
  await adapter.setItemAsync(BIOMETRICS_ENABLED_KEY, enabled ? '1' : '0');
}
