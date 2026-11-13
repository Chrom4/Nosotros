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
import { logger } from '@/utils/logger';

/**
 * Pulls household + active members from Supabase into local SQLite.
 * Does NOT invent offline placeholder members or generic "Nosso Lar" rows —
 * those must come from create/accept onboarding or a prior successful sync.
 */
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

    const { data: members, error } = await client
      .from('household_members')
      .select('id, household_id, user_id, display_name, role, color_hex')
      .eq('household_id', householdId)
      .is('revoked_at', null);

    if (error) {
      logger.warn('membership sync query failed', { reason: error.message });
      return;
    }

    if (!Array.isArray(members) || members.length === 0) {
      return;
    }

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
  } catch (err) {
    logger.warn('membership sync skipped (offline or transient)', {
      reason: err instanceof Error ? err.message : 'unknown',
    });
  }
}
