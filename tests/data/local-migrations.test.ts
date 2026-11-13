import Database from 'better-sqlite3';
import { applyLocalMigrations, LATEST_LOCAL_SCHEMA_VERSION } from '@/data/migrations/localMigrations';

describe('local SQLite migrations (PRAGMA user_version)', () => {
  it('bootstraps schema to the latest version on a fresh database', () => {
    const sqlite = new Database(':memory:');
    const adapter = {
      execSync: (sql: string) => {
        sqlite.exec(sql);
      },
      getFirstSync: <T>(sql: string) => sqlite.prepare(sql).get() as T,
    };

    const version = applyLocalMigrations(adapter);
    expect(version).toBe(LATEST_LOCAL_SCHEMA_VERSION);

    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('accounts','sync_outbox','sync_meta')",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual([
      'accounts',
      'sync_meta',
      'sync_outbox',
    ]);

    // Idempotent: second open does not bump version again
    expect(applyLocalMigrations(adapter)).toBe(LATEST_LOCAL_SCHEMA_VERSION);
    sqlite.close();
  });
});
