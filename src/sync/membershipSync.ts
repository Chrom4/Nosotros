import * as Crypto from 'expo-crypto';
import { getSupabaseClient } from '@/auth/supabaseClient';
import {
  type AppDatabase,
  getActiveDatabase,
  notifyDatabaseChange,
  upsertLocalHousehold,
  upsertLocalHouseholdMember,
} from '@/data';
import type { HouseholdMemberRole } from '@/data/schema';
import { useSessionUIStore } from '@/store/sessionUI';

export async function syncHouseholdMembers(
  targetDb?: AppDatabase | null,
  targetHouseholdId?: string | null,
): Promise<void> {
  const db = targetDb ?? getActiveDatabase();
  const store = useSessionUIStore.getState();
  const householdId = targetHouseholdId ?? store.activeHouseholdId;

  if (!db || !householdId) {
    return;
  }

  try {
    const client = getSupabaseClient();

    // 1. Fetch household info if available
    const { data: householdRow } = await client
      .from('households')
      .select('id, name, sync_epoch')
      .eq('id', householdId)
      .maybeSingle();

    if (householdRow) {
      upsertLocalHousehold(db, {
        id: householdRow.id,
        name: householdRow.name,
        syncEpoch: householdRow.sync_epoch ?? 1,
      });
    }

    // 2. Fetch all active members in the household
    const { data: members, error } = await client
      .from('household_members')
      .select('id, household_id, user_id, display_name, role, color_hex')
      .eq('household_id', householdId)
      .is('revoked_at', null);

    if (!error && Array.isArray(members) && members.length > 0) {
      for (const m of members) {
        upsertLocalHouseholdMember(db, {
          id: m.id,
          householdId: m.household_id,
          userId: m.user_id,
          displayName: m.display_name,
          role: m.role as HouseholdMemberRole,
          colorHex: m.color_hex,
        });
      }
      notifyDatabaseChange('accounts');
      return;
    }
  } catch {
    // Transient network/offline error - fall through to offline guarantee
  }

  // 3. Fallback / offline guarantee: ensure at least the logged-in user exists locally
  if (store.userId) {
    try {
      upsertLocalHousehold(db, {
        id: householdId,
        name: 'Nosso Lar',
        syncEpoch: 1,
      });

      upsertLocalHouseholdMember(db, {
        id: Crypto.randomUUID(),
        householdId,
        userId: store.userId,
        displayName: store.userEmail ? store.userEmail.split('@')[0] : 'Eu',
        role: store.memberRole ?? 'FOUNDER',
        colorHex: '#4F46E5',
      });
      notifyDatabaseChange('accounts');
    } catch {
      // Ignored if member already exists
    }
  }
}
