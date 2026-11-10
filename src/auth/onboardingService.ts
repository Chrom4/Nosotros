import * as Crypto from 'expo-crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type AppDatabase,
  cryptoShredLocalDatabase,
  type KeyStoreAdapter,
  upsertLocalHousehold,
  upsertLocalHouseholdMember,
} from '@/data';
import type { HouseholdMemberRole } from '@/data/schema';
import { useSessionUIStore } from '@/store/sessionUI';
import {
  generateEightCharInviteCode,
  hashInviteCode,
  isForbiddenError,
  mapOnboardingRpcError,
  normalizeInviteCode,
  validateInviteCode,
} from './inviteCodes';
import { getSupabaseClient } from './supabaseClient';

export interface AuthenticatedUserSession {
  userId: string;
  email: string;
}

export interface HouseholdMembershipSummary {
  householdId: string;
  householdName: string;
  memberId: string;
  role: HouseholdMemberRole;
  displayName: string;
  colorHex: string;
}

/**
 * Abstraction over Supabase Auth + RPC calls so the exact same onboarding/revocation
 * client service runs against Supabase in production and against PGlite in E2E tests.
 */
export interface OnboardingBackendGateway {
  getSession(): Promise<AuthenticatedUserSession | null>;
  signInWithPassword(
    email: string,
    password: string,
  ): Promise<AuthenticatedUserSession>;
  signUpWithPassword(
    email: string,
    password: string,
  ): Promise<AuthenticatedUserSession>;
  signOut(): Promise<void>;

  rpcCreateHouseholdWithFounder(params: {
    householdId: string;
    householdName: string;
    memberId: string;
    displayName: string;
    colorHex: string;
  }): Promise<string>;

  rpcCreatePartnerInvite(params: {
    inviteId: string;
    householdId: string;
    invitedEmail: string;
    inviteTokenHash: string;
    expiresInHours?: number;
  }): Promise<string>;

  rpcAcceptPartnerInvite(params: {
    inviteTokenHash: string;
    memberId: string;
    displayName: string;
    colorHex: string;
  }): Promise<string>;

  rpcRevokeHouseholdMember(params: {
    householdId: string;
    targetUserId: string;
  }): Promise<boolean>;

  rpcAssertActiveHouseholdMember(householdId: string): Promise<string>;

  fetchActiveMembership(): Promise<HouseholdMembershipSummary | null>;
}

export function createSupabaseOnboardingGateway(
  client: SupabaseClient = getSupabaseClient(),
): OnboardingBackendGateway {
  return {
    async getSession() {
      const { data, error } = await client.auth.getSession();
      if (error || !data.session?.user) {
        return null;
      }
      return {
        userId: data.session.user.id,
        email: (data.session.user.email ?? '').toLowerCase(),
      };
    },

    async signInWithPassword(email, password) {
      const { data, error } = await client.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error || !data.user) {
        throw new Error(error?.message ?? 'INVALID_CREDENTIALS');
      }
      return {
        userId: data.user.id,
        email: (data.user.email ?? email).trim().toLowerCase(),
      };
    },

    async signUpWithPassword(email, password) {
      const { data, error } = await client.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error || !data.user) {
        throw new Error(error?.message ?? 'SIGNUP_FAILED');
      }
      return {
        userId: data.user.id,
        email: (data.user.email ?? email).trim().toLowerCase(),
      };
    },

    async signOut() {
      await client.auth.signOut();
    },

    async rpcCreateHouseholdWithFounder(params) {
      const { data, error } = await client.rpc(
        'create_household_with_founder',
        {
          p_household_id: params.householdId,
          p_household_name: params.householdName.trim(),
          p_member_id: params.memberId,
          p_display_name: params.displayName.trim(),
          p_color_hex: params.colorHex,
        },
      );
      if (error) {
        throw new Error(error.message);
      }
      return String(data);
    },

    async rpcCreatePartnerInvite(params) {
      const { data, error } = await client.rpc('create_partner_invite', {
        p_invite_id: params.inviteId,
        p_household_id: params.householdId,
        p_invited_email: params.invitedEmail.trim().toLowerCase(),
        p_invite_token_hash: params.inviteTokenHash,
        p_expires_in_hours: params.expiresInHours ?? 24,
      });
      if (error) {
        throw new Error(error.message);
      }
      return String(data);
    },

    async rpcAcceptPartnerInvite(params) {
      const { data, error } = await client.rpc('accept_partner_invite', {
        p_invite_token_hash: params.inviteTokenHash,
        p_member_id: params.memberId,
        p_display_name: params.displayName.trim(),
        p_color_hex: params.colorHex,
      });
      if (error) {
        throw new Error(error.message);
      }
      return String(data);
    },

    async rpcRevokeHouseholdMember(params) {
      const { data, error } = await client.rpc('revoke_household_member', {
        p_household_id: params.householdId,
        p_target_user_id: params.targetUserId,
      });
      if (error) {
        throw new Error(error.message);
      }
      return Boolean(data);
    },

    async rpcAssertActiveHouseholdMember(householdId) {
      const { data, error } = await client.rpc(
        'assert_active_household_member',
        {
          p_household_id: householdId,
        },
      );
      if (error) {
        throw new Error(error.message);
      }
      return String(data);
    },

    async fetchActiveMembership() {
      const { data: userRes } = await client.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) {
        return null;
      }

      const { data: memberRow, error: memberErr } = await client
        .from('household_members')
        .select('id, household_id, role, display_name, color_hex')
        .eq('user_id', userId)
        .is('revoked_at', null)
        .maybeSingle();

      if (memberErr || !memberRow) {
        return null;
      }

      const { data: householdRow } = await client
        .from('households')
        .select('id, name')
        .eq('id', memberRow.household_id)
        .maybeSingle();

      return {
        householdId: memberRow.household_id as string,
        householdName: (householdRow?.name as string) ?? 'Lar Nosotros',
        memberId: memberRow.id as string,
        role: memberRow.role as HouseholdMemberRole,
        displayName: memberRow.display_name as string,
        colorHex: memberRow.color_hex as string,
      };
    },
  };
}

let activeGateway: OnboardingBackendGateway | null = null;

export function getOnboardingGateway(): OnboardingBackendGateway {
  if (!activeGateway) {
    activeGateway = createSupabaseOnboardingGateway();
  }
  return activeGateway;
}

export function setOnboardingGatewayForTests(
  gateway: OnboardingBackendGateway | null,
): void {
  activeGateway = gateway;
}

/**
 * Executes local crypto-shredding, stops sync, and resets session UI state when
 * a member's access is revoked (`FORBIDDEN`).
 */
export async function handleRevocationOrForbidden(options: {
  db?: AppDatabase | null;
  keyStoreAdapter?: KeyStoreAdapter;
  gateway?: OnboardingBackendGateway;
  notice?: string;
}): Promise<void> {
  const store = useSessionUIStore.getState();
  store.markRevokedAndHalted(options.notice);

  await cryptoShredLocalDatabase({
    db: options.db,
    adapter: options.keyStoreAdapter,
  });

  const gateway = options.gateway ?? getOnboardingGateway();
  try {
    await gateway.signOut();
  } catch {
    // Ignore sign-out errors if offline during local shred
  }
}

/**
 * Verifies with the server whether the user is still an active member of `householdId`.
 * If the server raises `FORBIDDEN`, triggers immediate local crypto-shredding.
 */
export async function verifyActiveMembershipOrShred(options: {
  householdId: string;
  db?: AppDatabase | null;
  keyStoreAdapter?: KeyStoreAdapter;
  gateway?: OnboardingBackendGateway;
}): Promise<{ active: boolean; shredded: boolean }> {
  const gateway = options.gateway ?? getOnboardingGateway();
  try {
    await gateway.rpcAssertActiveHouseholdMember(options.householdId);
    return { active: true, shredded: false };
  } catch (err) {
    if (isForbiddenError(err)) {
      await handleRevocationOrForbidden({
        db: options.db,
        keyStoreAdapter: options.keyStoreAdapter,
        gateway,
      });
      return { active: false, shredded: true };
    }
    throw err;
  }
}

/**
 * Restores the persisted session on app cold start, locks biometrics (DEC-03),
 * and checks whether an existing household membership was revoked.
 */
export async function restoreSessionOnLaunch(options: {
  gateway?: OnboardingBackendGateway;
  db?: AppDatabase | null;
  keyStoreAdapter?: KeyStoreAdapter;
  knownHouseholdId?: string | null;
} = {}): Promise<{
  authenticated: boolean;
  householdId: string | null;
  revoked: boolean;
}> {
  const gateway = options.gateway ?? getOnboardingGateway();
  const store = useSessionUIStore.getState();

  const session = await gateway.getSession();
  if (!session) {
    store.setSession(null);
    return { authenticated: false, householdId: null, revoked: false };
  }

  // If the device previously belonged to a household, verify it hasn't been revoked
  const candidateHouseholdId =
    options.knownHouseholdId ?? store.activeHouseholdId;
  if (candidateHouseholdId) {
    try {
      const check = await verifyActiveMembershipOrShred({
        householdId: candidateHouseholdId,
        db: options.db,
        keyStoreAdapter: options.keyStoreAdapter,
        gateway,
      });
      if (check.shredded) {
        return { authenticated: false, householdId: null, revoked: true };
      }
    } catch {
      // Offline or transient network error: keep local session intact
    }
  }

  const membership = await gateway.fetchActiveMembership().catch(() => null);

  store.setSession(
    {
      userId: session.userId,
      userEmail: session.email,
      activeHouseholdId: membership?.householdId ?? candidateHouseholdId ?? null,
      memberRole: membership?.role ?? store.memberRole ?? null,
    },
    { lockBiometricsOnRestore: true },
  );

  return {
    authenticated: true,
    householdId: membership?.householdId ?? candidateHouseholdId ?? null,
    revoked: false,
  };
}

export async function loginWithEmailPassword(params: {
  email: string;
  password: string;
  gateway?: OnboardingBackendGateway;
}): Promise<AuthenticatedUserSession> {
  const gateway = params.gateway ?? getOnboardingGateway();
  const store = useSessionUIStore.getState();
  store.setAuthError(null);

  try {
    const session = await gateway.signInWithPassword(
      params.email,
      params.password,
    );
    const membership = await gateway.fetchActiveMembership().catch(() => null);
    store.setSession(
      {
        userId: session.userId,
        userEmail: session.email,
        activeHouseholdId: membership?.householdId ?? null,
        memberRole: membership?.role ?? null,
      },
      { lockBiometricsOnRestore: false },
    );
    store.unlockBiometrics();
    return session;
  } catch (err) {
    const mapped = mapOnboardingRpcError(err);
    store.setAuthError(mapped.userMessage);
    throw err;
  }
}

export async function signUpWithEmailPassword(params: {
  email: string;
  password: string;
  gateway?: OnboardingBackendGateway;
}): Promise<AuthenticatedUserSession> {
  const gateway = params.gateway ?? getOnboardingGateway();
  const store = useSessionUIStore.getState();
  store.setAuthError(null);

  try {
    const session = await gateway.signUpWithPassword(
      params.email,
      params.password,
    );
    store.setSession(
      {
        userId: session.userId,
        userEmail: session.email,
        activeHouseholdId: null,
        memberRole: null,
      },
      { lockBiometricsOnRestore: false },
    );
    store.unlockBiometrics();
    return session;
  } catch (err) {
    const mapped = mapOnboardingRpcError(err);
    store.setAuthError(mapped.userMessage);
    throw err;
  }
}

export interface CreateHouseholdOnboardingInput {
  householdName: string;
  displayName: string;
  colorHex?: string;
  householdId?: string;
  memberId?: string;
  db?: AppDatabase | null;
  gateway?: OnboardingBackendGateway;
}

export async function createHouseholdAsFounder(
  input: CreateHouseholdOnboardingInput,
): Promise<{
  householdId: string;
  memberId: string;
}> {
  const gateway = input.gateway ?? getOnboardingGateway();
  const store = useSessionUIStore.getState();

  const householdName = input.householdName.trim();
  const displayName = input.displayName.trim();
  if (!householdName || !displayName) {
    throw new Error('Preencha o nome do lar e como você prefere ser chamado(a).');
  }

  const householdId = input.householdId ?? Crypto.randomUUID();
  const memberId = input.memberId ?? Crypto.randomUUID();
  const colorHex = input.colorHex ?? '#4F46E5';

  const createdHouseholdId = await gateway.rpcCreateHouseholdWithFounder({
    householdId,
    householdName,
    memberId,
    displayName,
    colorHex,
  });

  if (input.db && store.userId) {
    upsertLocalHousehold(input.db, {
      id: createdHouseholdId,
      name: householdName,
      syncEpoch: 1,
    });
    upsertLocalHouseholdMember(input.db, {
      id: memberId,
      householdId: createdHouseholdId,
      userId: store.userId,
      displayName,
      role: 'FOUNDER',
      colorHex,
    });
  }

  store.setHouseholdContext(createdHouseholdId, 'FOUNDER');

  return {
    householdId: createdHouseholdId,
    memberId,
  };
}

export interface IssuePartnerInviteInput {
  householdId: string;
  invitedEmail: string;
  inviteId?: string;
  expiresInHours?: number;
  getRandomBytes?: (byteCount: number) => Uint8Array;
  gateway?: OnboardingBackendGateway;
  db?: AppDatabase | null;
  keyStoreAdapter?: KeyStoreAdapter;
}

export interface IssuedPartnerInvite {
  inviteId: string;
  inviteCode: string;
  inviteTokenHash: string;
  invitedEmail: string;
  expiresInHours: number;
}

export async function issuePartnerInvite(
  input: IssuePartnerInviteInput,
): Promise<IssuedPartnerInvite> {
  const gateway = input.gateway ?? getOnboardingGateway();
  const invitedEmail = input.invitedEmail.trim().toLowerCase();

  if (!invitedEmail || !invitedEmail.includes('@')) {
    throw new Error('Informe um endereço de e-mail válido para o convite.');
  }

  const inviteCode = generateEightCharInviteCode(input.getRandomBytes);
  const inviteTokenHash = hashInviteCode(inviteCode);
  const inviteId = input.inviteId ?? Crypto.randomUUID();
  const expiresInHours = input.expiresInHours ?? 24;

  try {
    const createdInviteId = await gateway.rpcCreatePartnerInvite({
      inviteId,
      householdId: input.householdId,
      invitedEmail,
      inviteTokenHash,
      expiresInHours,
    });

    return {
      inviteId: createdInviteId,
      inviteCode,
      inviteTokenHash,
      invitedEmail,
      expiresInHours,
    };
  } catch (err) {
    if (isForbiddenError(err)) {
      await handleRevocationOrForbidden({
        db: input.db,
        keyStoreAdapter: input.keyStoreAdapter,
        gateway,
      });
    }
    const mapped = mapOnboardingRpcError(err);
    throw new Error(mapped.userMessage);
  }
}

export interface AcceptPartnerInviteInput {
  inviteCode: string;
  displayName: string;
  colorHex?: string;
  householdName?: string;
  memberId?: string;
  db?: AppDatabase | null;
  gateway?: OnboardingBackendGateway;
}

export async function acceptPartnerInviteCode(
  input: AcceptPartnerInviteInput,
): Promise<{
  householdId: string;
  memberId: string;
  normalizedCode: string;
}> {
  const gateway = input.gateway ?? getOnboardingGateway();
  const store = useSessionUIStore.getState();

  const validation = validateInviteCode(input.inviteCode);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new Error('Informe seu nome de exibição para entrar no lar.');
  }

  const normalizedCode = normalizeInviteCode(input.inviteCode);
  const inviteTokenHash = hashInviteCode(normalizedCode);
  const memberId = input.memberId ?? Crypto.randomUUID();
  const colorHex = input.colorHex ?? '#EC4899';

  try {
    const householdId = await gateway.rpcAcceptPartnerInvite({
      inviteTokenHash,
      memberId,
      displayName,
      colorHex,
    });

    if (input.db && store.userId) {
      upsertLocalHousehold(input.db, {
        id: householdId,
        name: input.householdName ?? 'Lar Nosotros',
        syncEpoch: 1,
      });
      upsertLocalHouseholdMember(input.db, {
        id: memberId,
        householdId,
        userId: store.userId,
        displayName,
        role: 'PARTNER',
        colorHex,
      });
    }

    store.setHouseholdContext(householdId, 'PARTNER');

    return {
      householdId,
      memberId,
      normalizedCode,
    };
  } catch (err) {
    const mapped = mapOnboardingRpcError(err);
    throw new Error(mapped.userMessage);
  }
}

export async function revokePartnerAccess(params: {
  householdId: string;
  targetUserId: string;
  gateway?: OnboardingBackendGateway;
}): Promise<boolean> {
  const gateway = params.gateway ?? getOnboardingGateway();
  try {
    return await gateway.rpcRevokeHouseholdMember({
      householdId: params.householdId,
      targetUserId: params.targetUserId,
    });
  } catch (err) {
    const mapped = mapOnboardingRpcError(err);
    throw new Error(mapped.userMessage);
  }
}
