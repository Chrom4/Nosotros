import * as SecureStore from 'expo-secure-store';
import type { HouseholdMemberRole } from '@/data/schema';

export const ACTIVE_HOUSEHOLD_ID_KEY = 'active_household_id_v1';
export const ACTIVE_MEMBER_ROLE_KEY = 'active_member_role_v1';

const VALID_ROLES = new Set<HouseholdMemberRole>(['FOUNDER', 'PARTNER']);

export interface PersistedHouseholdContext {
  householdId: string | null;
  memberRole: HouseholdMemberRole | null;
}

export async function loadPersistedHouseholdContext(): Promise<PersistedHouseholdContext> {
  try {
    const [householdId, roleRaw] = await Promise.all([
      SecureStore.getItemAsync(ACTIVE_HOUSEHOLD_ID_KEY),
      SecureStore.getItemAsync(ACTIVE_MEMBER_ROLE_KEY),
    ]);
    const memberRole =
      roleRaw && VALID_ROLES.has(roleRaw as HouseholdMemberRole)
        ? (roleRaw as HouseholdMemberRole)
        : null;
    return {
      householdId: householdId && householdId.length > 0 ? householdId : null,
      memberRole,
    };
  } catch {
    return { householdId: null, memberRole: null };
  }
}

export async function persistHouseholdContext(
  householdId: string | null,
  memberRole: HouseholdMemberRole | null,
): Promise<void> {
  try {
    if (!householdId) {
      await SecureStore.deleteItemAsync(ACTIVE_HOUSEHOLD_ID_KEY);
      await SecureStore.deleteItemAsync(ACTIVE_MEMBER_ROLE_KEY);
      return;
    }
    await SecureStore.setItemAsync(ACTIVE_HOUSEHOLD_ID_KEY, householdId);
    if (memberRole) {
      await SecureStore.setItemAsync(ACTIVE_MEMBER_ROLE_KEY, memberRole);
    } else {
      await SecureStore.deleteItemAsync(ACTIVE_MEMBER_ROLE_KEY);
    }
  } catch {
    // SecureStore can fail in some test/dev environments; in-memory store remains source of truth
  }
}
