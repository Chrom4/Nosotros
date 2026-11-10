/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import {
  acceptPartnerInviteCode,
  assertAnonClientKey,
  createHouseholdAsFounder,
  createSecureStoreAuthStorage,
  generateEightCharInviteCode,
  handleAppStateTransition,
  hashInviteCode,
  issuePartnerInvite,
  loginWithEmailPassword,
  mapOnboardingRpcError,
  type OnboardingBackendGateway,
  promptBiometricUnlock,
  restoreSessionOnLaunch,
  revokePartnerAccess,
  type SecureAuthStorageBackend,
  sha256Hex,
  validateInviteCode,
  verifyActiveMembershipOrShred,
} from '@/auth';
import {
  accounts,
  categories,
  createAccount,
  createCategory,
  createTransaction,
  getOrCreateDeviceNodeId,
  getOrCreateSqlCipherKeyHex,
  householdMembers,
  households,
  type KeyStoreAdapter,
  SQLCIPHER_KEY_STORAGE_KEY,
  syncOutbox,
  transactions,
} from '@/data';
import {
  BIOMETRIC_INACTIVITY_THRESHOLD_MS,
  useSessionUIStore,
} from '@/store/sessionUI';
import { createInMemoryTestDb, type InMemoryTestDb } from '../data/testDbHelper';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');

const USER_A = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'founder@nosotros.app',
};
const USER_B = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'partner@nosotros.app',
};
const USER_C = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'third@nosotros.app',
};

const HOUSEHOLD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_A_ID = 'aaaa1111-1111-4111-8111-111111111111';
const MEMBER_B_ID = 'aaaa2222-2222-4222-8222-222222222222';
const MEMBER_C_ID = 'aaaa3333-3333-4333-8333-333333333333';
const INVITE_B_ID = 'bbbb1111-1111-4111-8111-111111111111';
const INVITE_C_ID = 'bbbb2222-2222-4222-8222-222222222222';

function createMemorySecureBackend(): SecureAuthStorageBackend & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    async getItemAsync(key: string) {
      return store.get(key) ?? null;
    },
    async setItemAsync(key: string, value: string) {
      store.set(key, value);
    },
    async deleteItemAsync(key: string) {
      store.delete(key);
    },
  };
}

function createMemoryKeyStoreAdapter(): KeyStoreAdapter & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  let seed = 17;
  return {
    store,
    async getItemAsync(key: string) {
      return store.get(key) ?? null;
    },
    async setItemAsync(key: string, value: string) {
      store.set(key, value);
    },
    async deleteItemAsync(key: string) {
      store.delete(key);
    },
    getRandomBytes(byteCount: number) {
      const arr = new Uint8Array(byteCount);
      for (let i = 0; i < byteCount; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        arr[i] = seed & 0xff;
      }
      return arr;
    },
  };
}

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

function createPgliteOnboardingGateway(
  pg: PGlite,
  activeUserRef: { current: { id: string; email: string } | null },
): OnboardingBackendGateway {
  return {
    async getSession() {
      if (!activeUserRef.current) {
        return null;
      }
      return {
        userId: activeUserRef.current.id,
        email: activeUserRef.current.email,
      };
    },
    async signInWithPassword(email) {
      const normalized = email.trim().toLowerCase();
      const matched = [USER_A, USER_B, USER_C].find(
        (u) => u.email === normalized,
      );
      if (!matched) {
        throw new Error('INVALID_CREDENTIALS');
      }
      activeUserRef.current = matched;
      return { userId: matched.id, email: matched.email };
    },
    async signUpWithPassword(email) {
      const normalized = email.trim().toLowerCase();
      const matched = [USER_A, USER_B, USER_C].find(
        (u) => u.email === normalized,
      );
      if (!matched) {
        throw new Error('SIGNUP_FAILED');
      }
      activeUserRef.current = matched;
      return { userId: matched.id, email: matched.email };
    },
    async signOut() {
      activeUserRef.current = null;
    },
    async rpcCreateHouseholdWithFounder(params) {
      const u = activeUserRef.current!;
      const res = await execAsUser<{ create_household_with_founder: string }>(
        pg,
        u.id,
        u.email,
        `SELECT public.create_household_with_founder(
          '${params.householdId}'::uuid,
          '${params.householdName.replace(/'/g, "''")}',
          '${params.memberId}'::uuid,
          '${params.displayName.replace(/'/g, "''")}',
          '${params.colorHex}'
        );`,
      );
      return res.rows[0].create_household_with_founder;
    },
    async rpcCreatePartnerInvite(params) {
      const u = activeUserRef.current!;
      const res = await execAsUser<{ create_partner_invite: string }>(
        pg,
        u.id,
        u.email,
        `SELECT public.create_partner_invite(
          '${params.inviteId}'::uuid,
          '${params.householdId}'::uuid,
          '${params.invitedEmail}',
          '${params.inviteTokenHash}',
          ${params.expiresInHours ?? 24}
        );`,
      );
      return res.rows[0].create_partner_invite;
    },
    async rpcAcceptPartnerInvite(params) {
      const u = activeUserRef.current!;
      const res = await execAsUser<{ accept_partner_invite: string }>(
        pg,
        u.id,
        u.email,
        `SELECT public.accept_partner_invite(
          '${params.inviteTokenHash}',
          '${params.memberId}'::uuid,
          '${params.displayName.replace(/'/g, "''")}',
          '${params.colorHex}'
        );`,
      );
      return res.rows[0].accept_partner_invite;
    },
    async rpcRevokeHouseholdMember(params) {
      const u = activeUserRef.current!;
      const res = await execAsUser<{ revoke_household_member: boolean }>(
        pg,
        u.id,
        u.email,
        `SELECT public.revoke_household_member(
          '${params.householdId}'::uuid,
          '${params.targetUserId}'::uuid
        );`,
      );
      return res.rows[0].revoke_household_member;
    },
    async rpcAssertActiveHouseholdMember(householdId) {
      const u = activeUserRef.current!;
      const res = await execAsUser<{ assert_active_household_member: string }>(
        pg,
        u.id,
        u.email,
        `SELECT public.assert_active_household_member('${householdId}'::uuid);`,
      );
      return res.rows[0].assert_active_household_member;
    },
    async fetchActiveMembership() {
      const u = activeUserRef.current;
      if (!u) {
        return null;
      }
      const res = await execAsUser<{
        id: string;
        household_id: string;
        role: 'FOUNDER' | 'PARTNER';
        display_name: string;
        color_hex: string;
      }>(
        pg,
        u.id,
        u.email,
        `SELECT id, household_id, role, display_name, color_hex
         FROM public.household_members
         WHERE user_id = '${u.id}' AND revoked_at IS NULL
         LIMIT 1;`,
      );
      if (res.rows.length === 0) {
        return null;
      }
      const row = res.rows[0];
      return {
        householdId: row.household_id,
        householdName: 'Casa Nosotros',
        memberId: row.id,
        role: row.role,
        displayName: row.display_name,
        colorHex: row.color_hex,
      };
    },
  };
}

describe('Phase 5 — Auth, Couple Onboarding, Biometric Lock & Crypto-Shredding', () => {
  beforeEach(() => {
    useSessionUIStore.getState().resetSessionUI();
  });

  describe('T5.1 — Supabase SecureStore Auth Storage & Service Role Guard', () => {
    it('persists, restores, and removes both small and chunked (>1800 chars) session tokens in SecureStore', async () => {
      const backend = createMemorySecureBackend();
      const storage = createSecureStoreAuthStorage(backend);

      // Small token
      await storage.setItem('sb-auth-token', '{"access_token":"short-jwt"}');
      expect(await storage.getItem('sb-auth-token')).toBe(
        '{"access_token":"short-jwt"}',
      );

      // Large (>1800 chars) session payload requiring multi-key chunking
      const largeSession = JSON.stringify({
        access_token: 'x'.repeat(2400),
        refresh_token: 'y'.repeat(1200),
      });
      await storage.setItem('sb-auth-token', largeSession);
      expect(backend.store.get('sb-auth-token__chunks')).toBe('3');
      expect(await storage.getItem('sb-auth-token')).toBe(largeSession);

      // Removal cleans up all chunks
      await storage.removeItem('sb-auth-token');
      expect(await storage.getItem('sb-auth-token')).toBeNull();
      expect(backend.store.size).toBe(0);
    });

    it('blocks any service_role key or JWT from being initialized on the client', () => {
      expect(() => assertAnonClientKey('eyJ-anon-public-key')).not.toThrow();

      expect(() =>
        assertAnonClientKey('supabase_service_role_secret_key'),
      ).toThrow(/SECURITY_VIOLATION/);

      // Craft a fake JWT with {"role":"service_role"}
      const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
        'base64url',
      );
      const payload = Buffer.from(
        '{"role":"service_role","iss":"supabase"}',
      ).toString('base64url');
      const fakeServiceRoleJwt = `${header}.${payload}.signature`;

      expect(() => assertAnonClientKey(fakeServiceRoleJwt)).toThrow(
        /SECURITY_VIOLATION/,
      );
    });
  });

  describe('T5.2 — 8-Character Invite Generation, Validation, SHA-256 & Error Mapping', () => {
    it('generates 8-char uppercase alphanumeric codes and validates formatting', () => {
      const deterministicBytes = () =>
        new Uint8Array([0, 1, 2, 3, 4, 5, 30, 31]);
      const code = generateEightCharInviteCode(deterministicBytes);

      expect(code).toHaveLength(8);
      expect(validateInviteCode(code)).toEqual({
        valid: true,
        normalized: code,
      });

      // Lowercase + hyphenated input normalizes cleanly
      const spaced = `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`;
      expect(validateInviteCode(spaced)).toEqual({
        valid: true,
        normalized: code,
      });

      // Invalid length or symbols rejected
      expect(validateInviteCode('ABC12').valid).toBe(false);
      expect(validateInviteCode('ABCD$123').valid).toBe(false);
    });

    it('computes standard FIPS 180-4 SHA-256 hex digests for invite tokens', () => {
      // Known NIST SHA-256 test vector for "abc"
      expect(sha256Hex('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );

      const digest1 = hashInviteCode('abcd-2345');
      const digest2 = hashInviteCode('ABCD2345');
      expect(digest1).toBe(digest2);
      expect(digest1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('maps HOUSEHOLD_FULL, INVALID_OR_EXPIRED_INVITE, and FORBIDDEN to user-facing messages', () => {
      const fullErr = mapOnboardingRpcError(
        new Error(
          'HOUSEHOLD_FULL: Maximum of 2 active members allowed per household.',
        ),
      );
      expect(fullErr.code).toBe('HOUSEHOLD_FULL');
      expect(fullErr.userMessage).toContain('2 membros ativos');

      const expiredErr = mapOnboardingRpcError(
        new Error('INVALID_OR_EXPIRED_INVITE'),
      );
      expect(expiredErr.code).toBe('INVALID_OR_EXPIRED_INVITE');

      const forbiddenErr = mapOnboardingRpcError(
        new Error('FORBIDDEN: Access revoked'),
      );
      expect(forbiddenErr.code).toBe('FORBIDDEN');
    });
  });

  describe('T5.3 — Biometric Gate (Cold Start + 2-Minute Background Inactivity DEC-03)', () => {
    it('locks on cold start, unlocks on biometric success, and re-locks only after >= 2 minutes in background', async () => {
      const store = useSessionUIStore.getState();

      // 1. Cold start session restore locks biometrics
      store.setSession(
        {
          userId: USER_A.id,
          userEmail: USER_A.email,
          activeHouseholdId: HOUSEHOLD_ID,
          memberRole: 'FOUNDER',
        },
        { lockBiometricsOnRestore: true },
      );
      expect(useSessionUIStore.getState().isBiometricLocked).toBe(true);

      // 2. Failed biometric prompt keeps gate locked
      const failedUnlock = await promptBiometricUnlock({
        hasHardwareAsync: async () => true,
        isEnrolledAsync: async () => true,
        authenticateAsync: async () => ({
          success: false,
          error: 'user_cancel',
        }),
      });
      expect(failedUnlock.unlocked).toBe(false);
      expect(useSessionUIStore.getState().isBiometricLocked).toBe(true);

      // 3. Successful biometric prompt unlocks gate
      const passedUnlock = await promptBiometricUnlock({
        hasHardwareAsync: async () => true,
        isEnrolledAsync: async () => true,
        authenticateAsync: async () => ({ success: true }),
      });
      expect(passedUnlock.unlocked).toBe(true);
      expect(useSessionUIStore.getState().isBiometricLocked).toBe(false);

      // 4. App goes to background at t = 1_000_000 and resumes after 90 seconds (< 2 min): remains unlocked
      const t0 = 1_000_000;
      handleAppStateTransition('background', t0);
      expect(useSessionUIStore.getState().lastBackgroundedAtMs).toBe(t0);

      const lockedAfter90s = handleAppStateTransition('active', t0 + 90_000);
      expect(lockedAfter90s).toBe(false);
      expect(useSessionUIStore.getState().isBiometricLocked).toBe(false);

      // 5. App goes to background at t = 2_000_000 and resumes after 2 minutes (120_000 ms >= threshold): locks biometrics!
      const t1 = 2_000_000;
      handleAppStateTransition('background', t1);
      const lockedAfter2Min = handleAppStateTransition(
        'active',
        t1 + BIOMETRIC_INACTIVITY_THRESHOLD_MS,
      );
      expect(lockedAfter2Min).toBe(true);
      expect(useSessionUIStore.getState().isBiometricLocked).toBe(true);
    });
  });

  describe('T5.4 — E2E Couple Pairing (2 Users), 3rd Join Blocked (HOUSEHOLD_FULL) & Revocation Crypto-Shredding', () => {
    let pg: PGlite;
    let deviceADb: InMemoryTestDb;
    let deviceBDb: InMemoryTestDb;
    let deviceBKeyStore: ReturnType<typeof createMemoryKeyStoreAdapter>;
    const activeUserRef: { current: { id: string; email: string } | null } = {
      current: null,
    };
    let gateway: OnboardingBackendGateway;

    beforeAll(async () => {
      delete (globalThis as Record<string, unknown>).window;
      pg = new PGlite();

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
          ('${USER_A.id}', '${USER_A.email}'),
          ('${USER_B.id}', '${USER_B.email}'),
          ('${USER_C.id}', '${USER_C.email}');
      `);

      for (const file of [
        '0001_init_schema.sql',
        '0002_rls_policies.sql',
        '0003_invite_rpcs.sql',
      ]) {
        const sqlContent = fs.readFileSync(
          path.join(MIGRATIONS_DIR, file),
          'utf8',
        );
        await pg.exec(sqlContent);
      }

      deviceADb = createInMemoryTestDb();
      deviceBDb = createInMemoryTestDb();
      deviceBKeyStore = createMemoryKeyStoreAdapter();
      gateway = createPgliteOnboardingGateway(pg, activeUserRef);
    });

    afterAll(async () => {
      deviceADb.close();
      deviceBDb.close();
      await pg.close();
    });

    it('completes 2-user pairing via 8-char invite code, blocks 3rd member with HOUSEHOLD_FULL, and crypto-shreds Device B on revocation', async () => {
      // 1. User A (Founder) signs in on Device A and creates Household + generates 8-char invite for User B
      await loginWithEmailPassword({
        email: USER_A.email,
        password: 'password123',
        gateway,
      });

      const created = await createHouseholdAsFounder({
        householdId: HOUSEHOLD_ID,
        memberId: MEMBER_A_ID,
        householdName: 'Casa Nosotros',
        displayName: 'Diogo',
        colorHex: '#4F46E5',
        db: deviceADb.db,
        gateway,
      });
      expect(created.householdId).toBe(HOUSEHOLD_ID);

      const issuedInvite = await issuePartnerInvite({
        householdId: HOUSEHOLD_ID,
        invitedEmail: USER_B.email,
        inviteId: INVITE_B_ID,
        getRandomBytes: () => new Uint8Array([2, 4, 6, 8, 10, 12, 14, 16]),
        gateway,
      });
      expect(issuedInvite.inviteCode).toHaveLength(8);
      expect(issuedInvite.inviteTokenHash).toBe(
        hashInviteCode(issuedInvite.inviteCode),
      );

      // 2. User B (Partner) initializes Device B encryption keys, signs in, and accepts the 8-char invite
      const initialCipherKeyB =
        await getOrCreateSqlCipherKeyHex(deviceBKeyStore);
      const initialNodeIdB = await getOrCreateDeviceNodeId(deviceBKeyStore);
      expect(initialCipherKeyB).toMatch(/^[0-9a-f]{64}$/);
      expect(initialNodeIdB).toMatch(/^[0-9a-f]{12}$/);

      await loginWithEmailPassword({
        email: USER_B.email,
        password: 'password123',
        gateway,
      });

      const accepted = await acceptPartnerInviteCode({
        inviteCode: issuedInvite.inviteCode,
        displayName: 'Ana',
        colorHex: '#EC4899',
        memberId: MEMBER_B_ID,
        db: deviceBDb.db,
        gateway,
      });
      expect(accepted.householdId).toBe(HOUSEHOLD_ID);
      expect(useSessionUIStore.getState().activeHouseholdId).toBe(HOUSEHOLD_ID);
      expect(useSessionUIStore.getState().memberRole).toBe('PARTNER');

      // 3. Device B creates local financial records (account, category, transaction + outbox)
      const accountB = createAccount(deviceBDb.db, {
        id: 'cccc1111-1111-4111-8111-111111111111',
        householdId: HOUSEHOLD_ID,
        ownerUserId: USER_B.id,
        name: 'Conta Pessoal Ana',
        type: 'CHECKING',
        initialBalanceCents: 350000,
        includeInNetWorth: true,
        isArchived: false,
      });
      const categoryB = createCategory(deviceBDb.db, {
        id: 'dddd1111-1111-4111-8111-111111111111',
        householdId: HOUSEHOLD_ID,
        parentId: null,
        name: 'Supermercado',
        kind: 'EXPENSE',
        colorHex: '#10B981',
        iconName: 'shopping-cart',
      });
      createTransaction(deviceBDb.db, {
        id: 'eeee1111-1111-4111-8111-111111111111',
        householdId: HOUSEHOLD_ID,
        createdByUserId: USER_B.id,
        ownerUserId: null,
        type: 'EXPENSE',
        status: 'CLEARED',
        amountCents: 42000,
        transactionDate: '2026-11-09',
        competenceMonth: '2026-11',
        description: 'Compras da Semana',
        notes: null,
        accountId: accountB.id,
        transferAccountId: null,
        creditCardId: null,
        invoiceId: null,
        categoryId: categoryB.id,
        installmentPlanId: null,
        installmentNumber: null,
        totalInstallments: null,
        recurringRuleId: null,
        refundedTransactionId: null,
        isHouseholdContribution: true,
        calendarEventId: null,
      });

      expect(deviceBDb.db.select().from(transactions).all()).toHaveLength(1);
      expect(deviceBDb.db.select().from(syncOutbox).all().length).toBeGreaterThan(
        0,
      );

      // 4. Attempting to invite a 3rd member fails with HOUSEHOLD_FULL UX error
      await loginWithEmailPassword({
        email: USER_A.email,
        password: 'password123',
        gateway,
      });

      await expect(
        issuePartnerInvite({
          householdId: HOUSEHOLD_ID,
          invitedEmail: USER_C.email,
          inviteId: INVITE_C_ID,
          gateway,
        }),
      ).rejects.toThrow(/HOUSEHOLD_FULL/);

      // Even if a 3rd user attempts to join local SQLite, householdRepository blocks with HOUSEHOLD_FULL
      await expect(
        acceptPartnerInviteCode({
          inviteCode: issuedInvite.inviteCode,
          displayName: 'Terceiro',
          memberId: MEMBER_C_ID,
          db: deviceBDb.db,
          gateway,
        }),
      ).rejects.toThrow();

      // 5. User A (Founder) revokes User B's membership
      const revoked = await revokePartnerAccess({
        householdId: HOUSEHOLD_ID,
        targetUserId: USER_B.id,
        gateway,
      });
      expect(revoked).toBe(true);

      // 6. User B opens the app / runs membership sync check -> receives FORBIDDEN -> triggers local crypto-shredding!
      activeUserRef.current = USER_B;
      const launchCheck = await restoreSessionOnLaunch({
        gateway,
        db: deviceBDb.db,
        keyStoreAdapter: deviceBKeyStore,
        knownHouseholdId: HOUSEHOLD_ID,
      });

      expect(launchCheck.revoked).toBe(true);
      expect(launchCheck.authenticated).toBe(false);

      // Verify ephemeral store reflects revocation and sync halt
      const stateAfterRevoke = useSessionUIStore.getState();
      expect(stateAfterRevoke.authStatus).toBe('UNAUTHENTICATED');
      expect(stateAfterRevoke.isSyncHalted).toBe(true);
      expect(stateAfterRevoke.revocationNotice).toContain('revogado');

      // Verify SQLCipher key was shredded from SecureStore
      expect(
        await deviceBKeyStore.getItemAsync(SQLCIPHER_KEY_STORAGE_KEY),
      ).toBeNull();

      // Verify all local SQLite tables on Device B were wiped to 0 rows
      expect(deviceBDb.db.select().from(transactions).all()).toHaveLength(0);
      expect(deviceBDb.db.select().from(accounts).all()).toHaveLength(0);
      expect(deviceBDb.db.select().from(categories).all()).toHaveLength(0);
      expect(deviceBDb.db.select().from(householdMembers).all()).toHaveLength(
        0,
      );
      expect(deviceBDb.db.select().from(households).all()).toHaveLength(0);
      expect(deviceBDb.db.select().from(syncOutbox).all()).toHaveLength(0);

      // Meanwhile, verify direct sync guard also triggers shred if called directly
      activeUserRef.current = USER_B;
      const syncGuard = await verifyActiveMembershipOrShred({
        householdId: HOUSEHOLD_ID,
        db: deviceBDb.db,
        keyStoreAdapter: deviceBKeyStore,
        gateway,
      });
      expect(syncGuard).toEqual({ active: false, shredded: true });
    });
  });
});
