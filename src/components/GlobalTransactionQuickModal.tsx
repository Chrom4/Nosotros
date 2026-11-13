import { and, eq, isNull } from 'drizzle-orm';
import React from 'react';
import { TransactionQuickModal } from './TransactionQuickModal';
import {
  accounts,
  categories,
  householdMembers,
  useActiveDatabase,
  useReactiveQuery,
} from '@/data';
import { useSessionUIStore } from '@/store/sessionUI';

/**
 * Single app-wide instance of the quick transaction modal (mounted under tabs).
 * Screens should only call `openQuickModal` / `closeQuickModal` from the store.
 */
export function GlobalTransactionQuickModal() {
  const householdId = useSessionUIStore((s) => s.activeHouseholdId);
  const currentUserId = useSessionUIStore((s) => s.userId);
  const db = useActiveDatabase();

  const { data: accountRows } = useReactiveQuery(
    () =>
      db && householdId
        ? db
            .select()
            .from(accounts)
            .where(
              and(
                eq(accounts.householdId, householdId),
                isNull(accounts.deletedAt),
              ),
            )
        : null,
    [db, householdId],
    ['accounts'],
  );

  const { data: categoryRows } = useReactiveQuery(
    () =>
      db && householdId
        ? db
            .select()
            .from(categories)
            .where(
              and(
                eq(categories.householdId, householdId),
                isNull(categories.deletedAt),
              ),
            )
        : null,
    [db, householdId],
    ['categories'],
  );

  const { data: memberRows } = useReactiveQuery(
    () =>
      db && householdId
        ? db
            .select()
            .from(householdMembers)
            .where(
              and(
                eq(householdMembers.householdId, householdId),
                isNull(householdMembers.revokedAt),
              ),
            )
        : null,
    [db, householdId],
  );

  return (
    <TransactionQuickModal
      db={db}
      householdId={householdId}
      currentUserId={currentUserId}
      accounts={accountRows}
      categories={categoryRows}
      members={memberRows}
    />
  );
}
