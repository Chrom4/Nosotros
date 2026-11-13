import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

export interface SecureAuthStorageBackend {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

const defaultSecureBackend: SecureAuthStorageBackend = {
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
};

const CHUNK_SIZE = 1800;
const CHUNK_COUNT_SUFFIX = '__chunks';

/**
 * Supabase Auth storage adapter persisted in `expo-secure-store`.
 * Transparently chunks values larger than 1800 characters to respect platform Keychain/Keystore limits.
 */
export function createSecureStoreAuthStorage(
  backend: SecureAuthStorageBackend = defaultSecureBackend,
) {
  return {
    async getItem(key: string): Promise<string | null> {
      const chunkCountRaw = await backend.getItemAsync(
        `${key}${CHUNK_COUNT_SUFFIX}`,
      );
      if (!chunkCountRaw) {
        return backend.getItemAsync(key);
      }

      const chunkCount = Number.parseInt(chunkCountRaw, 10);
      if (!Number.isInteger(chunkCount) || chunkCount <= 0) {
        return backend.getItemAsync(key);
      }

      const parts: string[] = [];
      for (let i = 0; i < chunkCount; i++) {
        const part = await backend.getItemAsync(`${key}__chunk_${i}`);
        if (part === null) {
          return null;
        }
        parts.push(part);
      }
      return parts.join('');
    },

    async setItem(key: string, value: string): Promise<void> {
      if (value.length <= CHUNK_SIZE) {
        await backend.setItemAsync(key, value);
        await backend.deleteItemAsync(`${key}${CHUNK_COUNT_SUFFIX}`);
        return;
      }

      const totalChunks = Math.ceil(value.length / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const slice = value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await backend.setItemAsync(`${key}__chunk_${i}`, slice);
      }
      await backend.setItemAsync(
        `${key}${CHUNK_COUNT_SUFFIX}`,
        String(totalChunks),
      );
      await backend.deleteItemAsync(key);
    },

    async removeItem(key: string): Promise<void> {
      const chunkCountRaw = await backend.getItemAsync(
        `${key}${CHUNK_COUNT_SUFFIX}`,
      );
      if (chunkCountRaw) {
        const chunkCount = Number.parseInt(chunkCountRaw, 10);
        if (Number.isInteger(chunkCount) && chunkCount > 0) {
          for (let i = 0; i < chunkCount; i++) {
            await backend.deleteItemAsync(`${key}__chunk_${i}`);
          }
        }
        await backend.deleteItemAsync(`${key}${CHUNK_COUNT_SUFFIX}`);
      }
      await backend.deleteItemAsync(key);
    },
  };
}

function decodeBase64UrlSegment(segment: string): string {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded =
      normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    if (typeof atob === 'function') {
      return atob(padded);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf8');
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Hard requirement (Phase 5 / AGENTS.md §5.1):
 * Never allow a `service_role` key to be initialized in the mobile client.
 */
export function assertAnonClientKey(supabaseKey: string): void {
  if (!supabaseKey || supabaseKey.trim() === '') {
    throw new Error('SUPABASE_CONFIG_ERROR: Missing Supabase anon key');
  }

  if (/service_role/i.test(supabaseKey)) {
    throw new Error(
      'SECURITY_VIOLATION: service_role key is strictly forbidden in the mobile client',
    );
  }

  const parts = supabaseKey.split('.');
  if (parts.length === 3) {
    const payloadText = decodeBase64UrlSegment(parts[1]);
    if (/"role"\s*:\s*"service_role"/i.test(payloadText)) {
      throw new Error(
        'SECURITY_VIOLATION: service_role JWT is strictly forbidden in the mobile client',
      );
    }
  }
}

export interface CreateSupabaseClientConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  storageBackend?: SecureAuthStorageBackend;
}

let cachedSupabaseClient: SupabaseClient | null = null;

export function createAppSupabaseClient(
  config: CreateSupabaseClientConfig = {},
): SupabaseClient {
  const url =
    config.supabaseUrl ??
    process.env.EXPO_PUBLIC_SUPABASE_URL ??
    'https://placeholder.supabase.co';
  const anonKey =
    config.supabaseAnonKey ??
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
    'public-anon-placeholder-key';

  const isPlaceholderConfig =
    url === 'https://placeholder.supabase.co' ||
    anonKey === 'public-anon-placeholder-key';

  const isDev =
    typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';

  if (isPlaceholderConfig && !isDev) {
    throw new Error(
      'SUPABASE_CONFIG_ERROR: EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set in production builds',
    );
  }

  assertAnonClientKey(anonKey);

  const storage = createSecureStoreAuthStorage(config.storageBackend);

  return createClient(url, anonKey, {
    auth: {
      storage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
}

export function getSupabaseClient(): SupabaseClient {
  if (!cachedSupabaseClient) {
    cachedSupabaseClient = createAppSupabaseClient();
  }
  return cachedSupabaseClient;
}

export function setSupabaseClientForTests(client: SupabaseClient | null): void {
  cachedSupabaseClient = client;
}
