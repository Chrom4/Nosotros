import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import {
  classifyRpcError,
  type PullChangesRequest,
  type PullChangesResult,
  type PushBatchRequest,
  type PushBatchResult,
  type SyncBackendGateway,
} from '@/sync/syncGateway';
import {
  HOUSEHOLD_ID,
  type ServerFixture,
  USER_A_ID,
  USER_B_ID,
} from './syncTestKit';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');
const DOMAIN_TABLES = [
  'accounts',
  'categories',
  'credit_cards',
  'credit_card_invoices',
  'installment_plans',
  'recurring_rules',
  'transactions',
  'budgets',
];

/**
 * Runs the REAL `sync_push_batch` / `sync_pull_changes` SQL (migrations 0001-0004) inside PGlite,
 * authenticated as a given user via JWT claims, so client scenarios exercise the shipped RPCs.
 */
export class PgliteSyncServer implements ServerFixture {
  private constructor(private readonly pg: PGlite) {}

  static async create(): Promise<PgliteSyncServer> {
    // jest-expo defines global.window without window.location, which confuses Emscripten.
    delete (globalThis as Record<string, unknown>).window;
    const pg = new PGlite();

    await pg.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
      END
      $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated;
      GRANT USAGE ON SCHEMA public TO anon, authenticated;

      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE OR REPLACE FUNCTION auth.uid()
      RETURNS UUID
      LANGUAGE sql
      STABLE
      AS $func$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid;
      $func$;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;

      INSERT INTO auth.users (id, email) VALUES
        ('${USER_A_ID}', 'a@nosotros.app'),
        ('${USER_B_ID}', 'b@nosotros.app');
    `);

    for (const file of [
      '0001_init_schema.sql',
      '0002_rls_policies.sql',
      '0003_invite_rpcs.sql',
      '0004_sync_rpcs.sql',
    ]) {
      await pg.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }

    const server = new PgliteSyncServer(pg);
    await server.reset();
    return server;
  }

  async close(): Promise<void> {
    await this.pg.close();
  }

  async reset(): Promise<void> {
    await this.pg.exec(`
      DELETE FROM public.households;
      INSERT INTO public.households (id, name, sync_epoch)
        VALUES ('${HOUSEHOLD_ID}', 'Casa Nosotros', 1);
      INSERT INTO public.household_members
        (id, household_id, user_id, display_name, role, color_hex) VALUES
        ('aaaa1111-1111-4111-8111-111111111111', '${HOUSEHOLD_ID}', '${USER_A_ID}', 'A', 'FOUNDER', '#4F46E5'),
        ('aaaa2222-2222-4222-8222-222222222222', '${HOUSEHOLD_ID}', '${USER_B_ID}', 'B', 'PARTNER', '#10B981');
    `);
  }

  async setEpoch(epoch: number): Promise<void> {
    await this.pg.query('UPDATE public.households SET sync_epoch = $1', [epoch]);
  }

  async processedCount(): Promise<number> {
    const res = await this.pg.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM public.processed_mutations',
    );
    return res.rows[0].n;
  }

  async getRow(table: string, id: string): Promise<Record<string, unknown> | null> {
    if (!DOMAIN_TABLES.includes(table)) throw new Error(`unknown table ${table}`);
    const res = await this.pg.query<{ r: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS r FROM public.${table} t WHERE t.id = $1::uuid`,
      [id],
    );
    return res.rows[0]?.r ?? null;
  }

  private async rpc<T>(userId: string, sql: string, params: unknown[]): Promise<T> {
    await this.pg.exec(`
      BEGIN;
      SET LOCAL role = 'authenticated';
      SELECT set_config('request.jwt.claim.sub', '${userId}', true);
    `);
    try {
      const res = await this.pg.query<{ r: T }>(sql, params);
      await this.pg.exec('COMMIT;');
      return res.rows[0].r;
    } catch (err) {
      await this.pg.exec('ROLLBACK;');
      const e = err as { message?: string; code?: string };
      throw classifyRpcError({ message: e.message, code: e.code });
    }
  }

  gatewayFor(userId: string): SyncBackendGateway {
    return {
      pushBatch: async (request: PushBatchRequest): Promise<PushBatchResult> => {
        const data = await this.rpc<{
          accepted: number;
          skipped_idempotent: number;
          server_seq_max: number;
        }>(
          userId,
          'SELECT public.sync_push_batch($1::uuid, $2::int, $3::jsonb) AS r',
          [request.householdId, request.syncEpoch, JSON.stringify(request.mutations)],
        );
        return {
          accepted: data.accepted,
          skippedIdempotent: data.skipped_idempotent,
          serverSeqMax: Number(data.server_seq_max),
        };
      },
      pullChanges: async (request: PullChangesRequest): Promise<PullChangesResult> => {
        const data = await this.rpc<{
          sync_epoch: number;
          changes: PullChangesResult['changes'];
          has_more: boolean;
        }>(
          userId,
          'SELECT public.sync_pull_changes($1::uuid, $2::bigint, $3::int) AS r',
          [request.householdId, request.lastServerSeq, request.limit],
        );
        return {
          syncEpoch: data.sync_epoch,
          changes: data.changes.map((c) => ({ ...c, server_seq: Number(c.server_seq) })),
          hasMore: data.has_more,
        };
      },
    };
  }
}
