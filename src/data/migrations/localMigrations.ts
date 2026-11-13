import { LOCAL_SCHEMA_DDL } from '../localSchemaDdl';

/**
 * Incremental local SQLite migrations keyed by `PRAGMA user_version`.
 * Version 1 bootstraps the full IF NOT EXISTS schema (legacy installs).
 * Add new numbered SQL strings here for forward-only schema changes.
 */
export const LOCAL_MIGRATIONS: readonly {
  version: number;
  name: string;
  sql: string;
}[] = [
  {
    version: 1,
    name: 'bootstrap_domain_and_outbox',
    sql: LOCAL_SCHEMA_DDL,
  },
];

export const LATEST_LOCAL_SCHEMA_VERSION =
  LOCAL_MIGRATIONS[LOCAL_MIGRATIONS.length - 1]?.version ?? 0;

export interface SqliteMigrator {
  execSync(sql: string): void;
  getFirstSync?: <T>(sql: string) => T;
}

/**
 * Applies pending local migrations using `PRAGMA user_version`.
 * Safe to call on every open: already-applied versions are skipped.
 */
function readUserVersion(sqlite: SqliteMigrator): number {
  if (typeof sqlite.getFirstSync === 'function') {
    const row = sqlite.getFirstSync<{ user_version: number }>(
      'PRAGMA user_version',
    );
    if (typeof row?.user_version === 'number') {
      return row.user_version;
    }
  }
  return 0;
}

export function applyLocalMigrations(sqlite: SqliteMigrator): number {
  let current = readUserVersion(sqlite);

  for (const migration of LOCAL_MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    sqlite.execSync('BEGIN');
    try {
      sqlite.execSync(migration.sql);
      sqlite.execSync(`PRAGMA user_version = ${migration.version}`);
      sqlite.execSync('COMMIT');
      current = migration.version;
    } catch (err) {
      try {
        sqlite.execSync('ROLLBACK');
      } catch {
        // Ignore rollback errors on already-aborted transactions
      }
      throw err;
    }
  }

  return current;
}
