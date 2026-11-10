/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');
const WORKFLOW_PATH = path.resolve(
  __dirname,
  '../../.github/workflows/supabase-keepalive.yml',
);

const USER_A_ID = '11111111-1111-4111-8111-111111111111';
const USER_A_EMAIL = 'founder@nosotros.app';

const USER_B_ID = '22222222-2222-4222-8222-222222222222';
const USER_B_EMAIL = 'partner@nosotros.app';

const USER_C_ID = '33333333-3333-4333-8333-333333333333';
const USER_C_EMAIL = 'external@nosotros.app';

const HOUSEHOLD_AB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_A_ID = 'aaaa1111-1111-4111-8111-111111111111';
const MEMBER_B_ID = 'aaaa2222-2222-4222-8222-222222222222';
const MEMBER_C_ID = 'aaaa3333-3333-4333-8333-333333333333';

const INVITE_B_ID = 'bbbb1111-1111-4111-8111-111111111111';
const INVITE_B_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const ACCOUNT_AB_ID = 'cccc1111-1111-4111-8111-111111111111';
const CATEGORY_AB_ID = 'dddd1111-1111-4111-8111-111111111111';
const TX_AB_ID = 'eeee1111-1111-4111-8111-111111111111';
const BUDGET_AB_ID = 'ffff1111-1111-4111-8111-111111111111';
const MUTATION_AB_ID = '99991111-1111-4111-8111-111111111111';

/**
 * Helper to execute SQL inside an authenticated JWT session for a specific user.
 */
async function execAsUser<T = Record<string, unknown>>(
  pg: PGlite,
  userId: string,
  email: string,
  sqlText: string,
): Promise<{ rows: T[] }> {
  const claimsJson = JSON.stringify({
    sub: userId,
    email,
    role: 'authenticated',
  });

  await pg.exec(`
    BEGIN;
    SET LOCAL role = 'authenticated';
    SELECT set_config('request.jwt.claim.sub', '${userId}', true);
    SELECT set_config('request.jwt.claims', '${claimsJson}', true);
  `);

  try {
    const res = await pg.query<T>(sqlText);
    await pg.exec('COMMIT;');
    return { rows: res.rows };
  } catch (err) {
    await pg.exec('ROLLBACK;');
    throw err;
  }
}

describe('Phase 3 — Supabase Schema, RLS, Pairing RPCs & Keep-Alive (TEST-SEC-01)', () => {
  let pg: PGlite;

  beforeAll(async () => {
    // jest-expo defines global.window without window.location, which confuses Emscripten's ENVIRONMENT_IS_WEB detection
    delete (globalThis as Record<string, unknown>).window;
    pg = new PGlite();

    // Bootstrap Supabase-compatible auth schema and roles in PGlite
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

      CREATE OR REPLACE FUNCTION auth.jwt()
      RETURNS JSONB
      LANGUAGE sql
      STABLE
      AS $func$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
          '{}'::jsonb
        );
      $func$;

      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
      GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated;

      INSERT INTO auth.users (id, email) VALUES
        ('${USER_A_ID}', '${USER_A_EMAIL}'),
        ('${USER_B_ID}', '${USER_B_EMAIL}'),
        ('${USER_C_ID}', '${USER_C_EMAIL}');
    `);

    // Apply all Phase 3 migrations in order
    const migrationFiles = [
      '0001_init_schema.sql',
      '0002_rls_policies.sql',
      '0003_invite_rpcs.sql',
    ];

    for (const file of migrationFiles) {
      const sqlContent = fs.readFileSync(
        path.join(MIGRATIONS_DIR, file),
        'utf8',
      );
      await pg.exec(sqlContent);
    }
  });

  afterAll(async () => {
    await pg.close();
  });

  it('provisions all 12 domain/sync tables with RLS enabled and global_sync_seq', async () => {
    const expectedTables = [
      'accounts',
      'budgets',
      'categories',
      'credit_card_invoices',
      'credit_cards',
      'household_invites',
      'household_members',
      'households',
      'installment_plans',
      'processed_mutations',
      'recurring_rules',
      'transactions',
    ];

    const res = await pg.query<{ tablename: string; rowsecurity: boolean }>(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    expect(res.rows.map((r) => r.tablename)).toEqual(expectedTables);
    for (const row of res.rows) {
      expect(row.rowsecurity).toBe(true);
    }

    const seqRes = await pg.query<{ relname: string }>(`
      SELECT relname FROM pg_class WHERE relkind = 'S' AND relname = 'global_sync_seq';
    `);
    expect(seqRes.rows).toHaveLength(1);
  });

  it('GATE-3.1 (TEST-SEC-01): pairs User A (FOUNDER) and User B (PARTNER) without RLS recursion, while External User C reads 0 rows and cannot write to Household AB', async () => {
    // 1. User A creates Household AB as FOUNDER
    const createRes = await execAsUser<{ create_household_with_founder: string }>(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `SELECT public.create_household_with_founder(
        '${HOUSEHOLD_AB_ID}'::uuid,
        'Casa Nosotros',
        '${MEMBER_A_ID}'::uuid,
        'Diogo',
        '#4F46E5'
      );`,
    );
    expect(createRes.rows[0].create_household_with_founder).toBe(
      HOUSEHOLD_AB_ID,
    );

    // 2. User A generates partner invite for User B
    const inviteRes = await execAsUser<{ create_partner_invite: string }>(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `SELECT public.create_partner_invite(
        '${INVITE_B_ID}'::uuid,
        '${HOUSEHOLD_AB_ID}'::uuid,
        '${USER_B_EMAIL}',
        '${INVITE_B_HASH}',
        24
      );`,
    );
    expect(inviteRes.rows[0].create_partner_invite).toBe(INVITE_B_ID);

    // 3. External User C cannot accept an invite addressed to User B's email
    await expect(
      execAsUser(
        pg,
        USER_C_ID,
        USER_C_EMAIL,
        `SELECT public.accept_partner_invite(
          '${INVITE_B_HASH}',
          '${MEMBER_C_ID}'::uuid,
          'Intruso',
          '#EF4444'
        );`,
      ),
    ).rejects.toThrow(/INVALID_OR_EXPIRED_INVITE/);

    // 4. User B accepts the invite and pairs as PARTNER
    const acceptRes = await execAsUser<{ accept_partner_invite: string }>(
      pg,
      USER_B_ID,
      USER_B_EMAIL,
      `SELECT public.accept_partner_invite(
        '${INVITE_B_HASH}',
        '${MEMBER_B_ID}'::uuid,
        'Parceira',
        '#EC4899'
      );`,
    );
    expect(acceptRes.rows[0].accept_partner_invite).toBe(HOUSEHOLD_AB_ID);

    // 5. User A inserts financial data into Household AB
    await execAsUser(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `INSERT INTO public.accounts (id, household_id, owner_user_id, name, type, initial_balance_cents, hlc_timestamp)
       VALUES ('${ACCOUNT_AB_ID}', '${HOUSEHOLD_AB_ID}', NULL, 'Conta Conjunta', 'CHECKING', 500000, '2026-11-06T12:00:00.000Z-0001-nodeA');`,
    );
    await execAsUser(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `INSERT INTO public.categories (id, household_id, name, kind, color_hex, icon_name, hlc_timestamp)
       VALUES ('${CATEGORY_AB_ID}', '${HOUSEHOLD_AB_ID}', 'Moradia', 'EXPENSE', '#10B981', 'home', '2026-11-06T12:00:00.000Z-0002-nodeA');`,
    );
    await execAsUser(
      pg,
      USER_B_ID,
      USER_B_EMAIL,
      `INSERT INTO public.transactions (
         id, household_id, created_by_user_id, owner_user_id, type, status, amount_cents,
         transaction_date, competence_month, description, account_id, category_id, hlc_timestamp
       ) VALUES (
         '${TX_AB_ID}', '${HOUSEHOLD_AB_ID}', '${USER_B_ID}', NULL, 'EXPENSE', 'CLEARED', 150000,
         '2026-11-06', '2026-11', 'Aluguel', '${ACCOUNT_AB_ID}', '${CATEGORY_AB_ID}', '2026-11-06T12:01:00.000Z-0001-nodeB'
       );`,
    );
    await execAsUser(
      pg,
      USER_B_ID,
      USER_B_EMAIL,
      `INSERT INTO public.budgets (id, household_id, owner_user_id, category_id, competence_month, limit_cents, hlc_timestamp)
       VALUES ('${BUDGET_AB_ID}', '${HOUSEHOLD_AB_ID}', NULL, '${CATEGORY_AB_ID}', '2026-11', 250000, '2026-11-06T12:02:00.000Z-0001-nodeB');`,
    );
    await execAsUser(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `INSERT INTO public.processed_mutations (mutation_id, household_id, user_id)
       VALUES ('${MUTATION_AB_ID}', '${HOUSEHOLD_AB_ID}', '${USER_A_ID}');`,
    );

    // 6. Both User A and User B see all rows in Household AB without infinite recursion on household_members
    const membersSeenByB = await execAsUser(
      pg,
      USER_B_ID,
      USER_B_EMAIL,
      `SELECT id, role FROM public.household_members WHERE household_id = '${HOUSEHOLD_AB_ID}' ORDER BY role;`,
    );
    expect(membersSeenByB.rows).toHaveLength(2);

    const txSeenByA = await execAsUser(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `SELECT id, amount_cents FROM public.transactions WHERE household_id = '${HOUSEHOLD_AB_ID}';`,
    );
    expect(txSeenByA.rows).toHaveLength(1);

    // 7. External User C queries every table and reads 0 rows from Household AB
    const tablesToVerify = [
      'households',
      'household_members',
      'household_invites',
      'accounts',
      'categories',
      'credit_cards',
      'credit_card_invoices',
      'installment_plans',
      'recurring_rules',
      'transactions',
      'budgets',
      'processed_mutations',
    ];

    for (const table of tablesToVerify) {
      const resC = await execAsUser(
        pg,
        USER_C_ID,
        USER_C_EMAIL,
        `SELECT * FROM public.${table};`,
      );
      expect(resC.rows).toHaveLength(0);
    }

    // 8. External User C cannot insert data into Household AB (blocked by RLS WITH CHECK)
    await expect(
      execAsUser(
        pg,
        USER_C_ID,
        USER_C_EMAIL,
        `INSERT INTO public.accounts (id, household_id, name, type, initial_balance_cents, hlc_timestamp)
         VALUES ('cccc9999-9999-4999-8999-999999999999', '${HOUSEHOLD_AB_ID}', 'Conta Invasora', 'WALLET', 100, '2026-11-06T12:05:00.000Z-0001-nodeC');`,
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it('GATE-3.2: rejects inserting a 3rd active member with HOUSEHOLD_FULL and blocks non-owner permission updates via BEFORE UPDATE trigger', async () => {
    // 1. Attempting to issue a new invite when 2 active members exist fails with HOUSEHOLD_FULL
    await expect(
      execAsUser(
        pg,
        USER_A_ID,
        USER_A_EMAIL,
        `SELECT public.create_partner_invite(
          'bbbb2222-2222-4222-8222-222222222222'::uuid,
          '${HOUSEHOLD_AB_ID}'::uuid,
          '${USER_C_EMAIL}',
          'hash_3rd_member',
          24
        );`,
      ),
    ).rejects.toThrow(/HOUSEHOLD_FULL/);

    // 2. Direct insertion into household_members (even as superuser) fails via trg_max_two_members
    await expect(
      pg.query(`
        INSERT INTO public.household_members (id, household_id, user_id, display_name, role, color_hex)
        VALUES ('${MEMBER_C_ID}', '${HOUSEHOLD_AB_ID}', '${USER_C_ID}', 'Terceiro Membro', 'PARTNER', '#F59E0B');
      `),
    ).rejects.toThrow(/HOUSEHOLD_FULL/);

    // 3. Partner (User B) can update their own display_name/color_hex
    await execAsUser(
      pg,
      USER_B_ID,
      USER_B_EMAIL,
      `UPDATE public.household_members SET display_name = 'Parceira Atualizada' WHERE id = '${MEMBER_B_ID}';`,
    );

    // 4. Partner (User B) is blocked by BEFORE UPDATE trigger from escalating role to FOUNDER
    await expect(
      execAsUser(
        pg,
        USER_B_ID,
        USER_B_EMAIL,
        `UPDATE public.household_members SET role = 'FOUNDER' WHERE id = '${MEMBER_B_ID}';`,
      ),
    ).rejects.toThrow(
      /FORBIDDEN: Only the household FOUNDER \(owner\) can modify member permissions or revoke access/,
    );

    // 5. Partner (User B) is blocked from revoking FOUNDER (User A) either via UPDATE or RPC
    await expect(
      execAsUser(
        pg,
        USER_B_ID,
        USER_B_EMAIL,
        `UPDATE public.household_members SET revoked_at = NOW() WHERE id = '${MEMBER_A_ID}';`,
      ),
    ).rejects.toThrow(
      /FORBIDDEN: Only the household FOUNDER \(owner\) can modify member permissions or revoke access/,
    );

    await expect(
      execAsUser(
        pg,
        USER_B_ID,
        USER_B_EMAIL,
        `SELECT public.revoke_household_member('${HOUSEHOLD_AB_ID}'::uuid, '${USER_A_ID}'::uuid);`,
      ),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it('GATE-3.3: revoking a member sets revoked_at, preserves historical FKs, returns FORBIDDEN on protected RPCs, and cuts RLS visibility to 0 rows', async () => {
    // 1. Founder (User A) revokes Partner (User B)
    const revokeRes = await execAsUser<{ revoke_household_member: boolean }>(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `SELECT public.revoke_household_member('${HOUSEHOLD_AB_ID}'::uuid, '${USER_B_ID}'::uuid);`,
    );
    expect(revokeRes.rows[0].revoke_household_member).toBe(true);

    // 2. Historical transaction created by User B remains intact in Household AB for User A
    const txAfterRevoke = await execAsUser<{
      id: string;
      created_by_user_id: string;
    }>(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `SELECT id, created_by_user_id FROM public.transactions WHERE id = '${TX_AB_ID}';`,
    );
    expect(txAfterRevoke.rows).toHaveLength(1);
    expect(txAfterRevoke.rows[0].created_by_user_id).toBe(USER_B_ID);

    // 3. Revoked User B receives FORBIDDEN on protected RPCs
    await expect(
      execAsUser(
        pg,
        USER_B_ID,
        USER_B_EMAIL,
        `SELECT public.assert_active_household_member('${HOUSEHOLD_AB_ID}'::uuid);`,
      ),
    ).rejects.toThrow(/FORBIDDEN: Access revoked or user not in household/);

    await expect(
      execAsUser(
        pg,
        USER_B_ID,
        USER_B_EMAIL,
        `SELECT public.revoke_household_member('${HOUSEHOLD_AB_ID}'::uuid, '${USER_A_ID}'::uuid);`,
      ),
    ).rejects.toThrow(/FORBIDDEN/);

    // 4. Revoked User B reads 0 rows from Household AB via RLS
    const txSeenByRevokedB = await execAsUser(
      pg,
      USER_B_ID,
      USER_B_EMAIL,
      `SELECT * FROM public.transactions WHERE household_id = '${HOUSEHOLD_AB_ID}';`,
    );
    expect(txSeenByRevokedB.rows).toHaveLength(0);
  });

  it('GATE-3.4: EXPLAIN confirms InitPlan caching and index-backed RLS evaluation', async () => {
    // 1. Verify InitPlan inside the RLS helper query evaluation
    const explainHelper = await execAsUser<{ 'QUERY PLAN': string }>(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `EXPLAIN (COSTS OFF)
       SELECT hm.household_id
       FROM public.household_members hm
       WHERE hm.user_id = (SELECT auth.uid())
         AND hm.revoked_at IS NULL;`,
    );
    const helperPlanText = explainHelper.rows
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    expect(helperPlanText).toContain('InitPlan');

    // 2. Verify representative RLS policy query on transactions uses get_my_active_household_ids()
    const explainTx = await execAsUser<{ 'QUERY PLAN': string }>(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `EXPLAIN (VERBOSE, COSTS OFF)
       SELECT * FROM public.transactions WHERE household_id = '${HOUSEHOLD_AB_ID}';`,
    );
    const txPlanText = explainTx.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(txPlanText).toContain('get_my_active_household_ids');

    // 3. Verify RLS policy with (SELECT auth.uid()) on processed_mutations uses InitPlan
    const explainMutations = await execAsUser<{ 'QUERY PLAN': string }>(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `EXPLAIN (COSTS OFF)
       INSERT INTO public.processed_mutations (mutation_id, household_id, user_id)
       VALUES ('99992222-2222-4222-8222-222222222222', '${HOUSEHOLD_AB_ID}', '${USER_A_ID}');`,
    );
    const mutationsPlanText = explainMutations.rows
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    expect(mutationsPlanText).toContain('InitPlan');
  });

  it('GATE-3.5: validates keep-alive workflow (cron <= 5 days) and keepalive_ping() RPC', async () => {
    expect(fs.existsSync(WORKFLOW_PATH)).toBe(true);
    const workflowYaml = fs.readFileSync(WORKFLOW_PATH, 'utf8');

    // Verify 5-day cron schedule and no leaked service_role key
    expect(workflowYaml).toContain("cron: '0 6 */5 * *'");
    expect(workflowYaml).not.toContain('service_role');

    // Verify keepalive_ping() RPC works for authenticated role
    const pingRes = await execAsUser<{ keepalive_ping: number }>(
      pg,
      USER_A_ID,
      USER_A_EMAIL,
      `SELECT public.keepalive_ping();`,
    );
    expect(pingRes.rows[0].keepalive_ping).toBe(1);
  });
});
