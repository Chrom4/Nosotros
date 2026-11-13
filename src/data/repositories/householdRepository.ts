import { and, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from '../db';
import {
  householdMembers,
  type HouseholdMemberRole,
  type HouseholdMemberRow,
  type HouseholdRow,
  households,
} from '../schema';

export interface CreateLocalHouseholdInput {
  id: string;
  name: string;
  syncEpoch?: number;
  createdAt?: string;
}

export interface UpsertHouseholdMemberInput {
  id: string;
  householdId: string;
  userId: string;
  displayName: string;
  role: HouseholdMemberRole;
  colorHex: string;
  joinedAt?: string;
  revokedAt?: string | null;
}

export function upsertLocalHousehold(
  db: AppDatabase,
  input: CreateLocalHouseholdInput,
): HouseholdRow {
  return db.transaction((tx) => {
    const nowIso = input.createdAt ?? new Date().toISOString();
    tx.insert(households)
      .values({
        id: input.id,
        name: input.name,
        syncEpoch: input.syncEpoch ?? 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: households.id,
        set: {
          name: input.name,
          syncEpoch: input.syncEpoch ?? 1,
          updatedAt: nowIso,
        },
      })
      .run();

    return tx
      .select()
      .from(households)
      .where(eq(households.id, input.id))
      .get()!;
  });
}

export function upsertLocalHouseholdMember(
  db: AppDatabase,
  input: UpsertHouseholdMemberInput,
): HouseholdMemberRow {
  return db.transaction((tx) => {
    const activeMembers = tx
      .select()
      .from(householdMembers)
      .where(
        and(
          eq(householdMembers.householdId, input.householdId),
          isNull(householdMembers.revokedAt),
        ),
      )
      .all();

    const isExistingUser = activeMembers.some(
      (m) => m.id === input.id || m.userId === input.userId,
    );
    if (!input.revokedAt && !isExistingUser && activeMembers.length >= 2) {
      throw new Error(
        'HOUSEHOLD_FULL: Maximum of 2 active members per household exceeded',
      );
    }

    const joinedAt = input.joinedAt ?? new Date().toISOString();
    tx.insert(householdMembers)
      .values({
        id: input.id,
        householdId: input.householdId,
        userId: input.userId,
        displayName: input.displayName,
        role: input.role,
        colorHex: input.colorHex,
        joinedAt,
        revokedAt: input.revokedAt ?? null,
      })
      .onConflictDoUpdate({
        target: householdMembers.id,
        set: {
          displayName: input.displayName,
          role: input.role,
          colorHex: input.colorHex,
          revokedAt: input.revokedAt ?? null,
        },
      })
      .run();

    return tx
      .select()
      .from(householdMembers)
      .where(eq(householdMembers.id, input.id))
      .get()!;
  });
}

export function listActiveHouseholdMembers(
  db: AppDatabase,
  householdId: string,
): HouseholdMemberRow[] {
  return db
    .select()
    .from(householdMembers)
    .where(
      and(
        eq(householdMembers.householdId, householdId),
        isNull(householdMembers.revokedAt),
      ),
    )
    .all();
}

/**
 * Offline hydration: find the active membership row for a user in local SQLite.
 */
export function findLocalMembershipForUser(
  db: AppDatabase,
  userId: string,
): HouseholdMemberRow | null {
  return (
    db
      .select()
      .from(householdMembers)
      .where(
        and(
          eq(householdMembers.userId, userId),
          isNull(householdMembers.revokedAt),
        ),
      )
      .get() ?? null
  );
}
