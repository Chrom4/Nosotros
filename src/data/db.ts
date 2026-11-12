import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { ensureLocalSchema } from './localSchemaDdl';
import * as schema from './schema';

export const SQLCIPHER_KEY_STORAGE_KEY = 'local_sqlcipher_key_v1';
export const DEVICE_NODE_ID_STORAGE_KEY = 'local_device_node_id_v1';
export const DEFAULT_DB_NAME = 'nosotros.db';

const HEX_256_BIT_REGEX = /^[0-9a-f]{64}$/i;
const HEX_NODE_ID_REGEX = /^[0-9a-f]{12}$/i;

export type AppDatabase = BaseSQLiteDatabase<'sync', unknown, typeof schema>;
export type AppTransaction = Parameters<
  Parameters<AppDatabase['transaction']>[0]
>[0];
export type DbExecutor = AppDatabase | AppTransaction;

export interface KeyStoreAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync?(key: string): Promise<void>;
  getRandomBytes(byteCount: number): Uint8Array;
}

const defaultKeyStoreAdapter: KeyStoreAdapter = {
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
  getRandomBytes: (byteCount) => Crypto.getRandomBytes(byteCount),
};

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex.toLowerCase();
}

/**
 * Loads or generates the 256-bit (32-byte / 64-hex-char) SQLCipher key in `expo-secure-store`.
 * Never logs the key in production or development.
 */
export async function getOrCreateSqlCipherKeyHex(
  adapter: KeyStoreAdapter = defaultKeyStoreAdapter,
): Promise<string> {
  const existing = await adapter.getItemAsync(SQLCIPHER_KEY_STORAGE_KEY);
  if (existing && HEX_256_BIT_REGEX.test(existing)) {
    return existing.toLowerCase();
  }

  const randomBytes = adapter.getRandomBytes(32);
  if (randomBytes.length !== 32) {
    throw new Error('Failed to generate 256-bit SQLCipher key');
  }

  const keyHex = bytesToHex(randomBytes);
  await adapter.setItemAsync(SQLCIPHER_KEY_STORAGE_KEY, keyHex);
  return keyHex;
}

/**
 * Loads or generates the 12-character hex `nodeId` used by this device's HLC clock.
 */
export async function getOrCreateDeviceNodeId(
  adapter: KeyStoreAdapter = defaultKeyStoreAdapter,
): Promise<string> {
  const existing = await adapter.getItemAsync(DEVICE_NODE_ID_STORAGE_KEY);
  if (existing && HEX_NODE_ID_REGEX.test(existing)) {
    return existing.toLowerCase();
  }

  const randomBytes = adapter.getRandomBytes(6);
  if (randomBytes.length !== 6) {
    throw new Error('Failed to generate 48-bit device node ID');
  }

  const nodeId = bytesToHex(randomBytes);
  await adapter.setItemAsync(DEVICE_NODE_ID_STORAGE_KEY, nodeId);
  return nodeId;
}

let cachedExpoDb: ExpoSQLiteDatabase<typeof schema> | null = null;
let cachedRawSqlite: SQLite.SQLiteDatabase | null = null;
let injectedTestDb: AppDatabase | null = null;

export type DatabaseChangeListener = (
  tableName: schema.SyncableTableName,
) => void;

const dbChangeListeners = new Set<DatabaseChangeListener>();

export function subscribeToDatabaseChanges(
  listener: DatabaseChangeListener,
): () => void {
  dbChangeListeners.add(listener);
  return () => {
    dbChangeListeners.delete(listener);
  };
}

export function notifyDatabaseChange(
  tableName: schema.SyncableTableName,
): void {
  for (const listener of dbChangeListeners) {
    listener(tableName);
  }
}

export function getActiveDatabase(): AppDatabase | null {
  return injectedTestDb ?? (cachedExpoDb as unknown as AppDatabase | null);
}

export function setActiveDatabaseForTests(db: AppDatabase | null): void {
  injectedTestDb = db;
}

/**
 * Opens and configures the encrypted local SQLite database with SQLCipher (`PRAGMA key`),
 * WAL journal mode, and strict foreign keys.
 */
export async function openEncryptedDatabase(
  dbName: string = DEFAULT_DB_NAME,
  adapter: KeyStoreAdapter = defaultKeyStoreAdapter,
): Promise<{
  db: ExpoSQLiteDatabase<typeof schema>;
  sqlite: SQLite.SQLiteDatabase;
}> {
  if (cachedExpoDb && cachedRawSqlite) {
    return { db: cachedExpoDb, sqlite: cachedRawSqlite };
  }

  const keyHex = await getOrCreateSqlCipherKeyHex(adapter);
  const sqlite = SQLite.openDatabaseSync(dbName, {
    enableChangeListener: true,
  });

  sqlite.execSync(`PRAGMA key = "x'${keyHex}'";`);
  sqlite.execSync('PRAGMA journal_mode = WAL;');
  sqlite.execSync('PRAGMA foreign_keys = ON;');
  ensureLocalSchema(sqlite);

  const db = drizzle(sqlite, { schema });
  cachedExpoDb = db;
  cachedRawSqlite = sqlite;

  return { db, sqlite };
}

export function resetCachedDatabaseForTests(): void {
  cachedExpoDb = null;
  cachedRawSqlite = null;
  injectedTestDb = null;
  dbChangeListeners.clear();
}

/**
 * Truncates all local domain and sync tables in reverse foreign-key order
 * within a single atomic SQLite transaction (used during revocation / crypto-shredding).
 */
export function wipeAllLocalTables(db: AppDatabase): void {
  db.transaction((tx) => {
    tx.delete(schema.transactions).run();
    tx.delete(schema.budgets).run();
    tx.delete(schema.recurringRules).run();
    tx.delete(schema.installmentPlans).run();
    tx.delete(schema.creditCardInvoices).run();
    tx.delete(schema.creditCards).run();
    tx.delete(schema.categories).run();
    tx.delete(schema.accounts).run();
    tx.delete(schema.householdMembers).run();
    tx.delete(schema.households).run();
    tx.delete(schema.syncOutbox).run();
    tx.delete(schema.syncMeta).run();
  });
}

export interface CryptoShredOptions {
  db?: AppDatabase | null;
  dbName?: string;
  adapter?: KeyStoreAdapter;
}

/**
 * Performs local crypto-shredding upon household revocation (`FORBIDDEN`):
 * 1. Truncates all local SQLite tables if a database handle is open.
 * 2. Overwrites and deletes the 256-bit SQLCipher key and device node ID in SecureStore.
 * 3. Closes the cached SQLite connection and removes the encrypted database file.
 */
export async function cryptoShredLocalDatabase(
  options: CryptoShredOptions = {},
): Promise<void> {
  const adapter = options.adapter ?? defaultKeyStoreAdapter;
  const dbName = options.dbName ?? DEFAULT_DB_NAME;
  const targetDb = options.db ?? cachedExpoDb;

  if (targetDb) {
    wipeAllLocalTables(targetDb);
  }

  // Overwrite keys with fresh entropy before deleting from SecureStore
  const randomOverwriteKey = bytesToHex(adapter.getRandomBytes(32));
  const randomOverwriteNode = bytesToHex(adapter.getRandomBytes(6));
  await adapter.setItemAsync(SQLCIPHER_KEY_STORAGE_KEY, randomOverwriteKey);
  await adapter.setItemAsync(DEVICE_NODE_ID_STORAGE_KEY, randomOverwriteNode);

  if (adapter.deleteItemAsync) {
    await adapter.deleteItemAsync(SQLCIPHER_KEY_STORAGE_KEY);
    await adapter.deleteItemAsync(DEVICE_NODE_ID_STORAGE_KEY);
  }

  if (cachedRawSqlite) {
    try {
      cachedRawSqlite.closeSync();
    } catch {
      // Ignore close errors during shred
    }
  }

  cachedExpoDb = null;
  cachedRawSqlite = null;

  if (typeof SQLite.deleteDatabaseSync === 'function') {
    try {
      SQLite.deleteDatabaseSync(dbName);
    } catch {
      // Ignore if file does not exist or in test environment
    }
  }
}
