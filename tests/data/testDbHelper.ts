import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import type { AppDatabase } from '@/data/db';
import * as schema from '@/data/schema';

export interface InMemoryTestDb {
  db: AppDatabase;
  raw: Database.Database;
  close: () => void;
}

/**
 * Creates a fresh in-memory SQLite instance using `better-sqlite3`, enables foreign keys,
 * and applies the official Drizzle migrations from `/src/data/migrations`.
 */
export function createInMemoryTestDb(): InMemoryTestDb {
  const raw = new Database(':memory:');
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  const db = drizzle(raw, { schema });
  const migrationsFolder = path.resolve(
    __dirname,
    '../../src/data/migrations',
  );
  migrate(db, { migrationsFolder });

  return {
    db: db as unknown as AppDatabase,
    raw,
    close: () => raw.close(),
  };
}
