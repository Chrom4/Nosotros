/**
 * @jest-environment node
 */
import { households, householdMembers } from '@/data/schema';
import { syncHouseholdMembers } from '@/sync/membershipSync';
import { useSessionUIStore } from '@/store/sessionUI';
import { createInMemoryTestDb } from '../data/testDbHelper';

describe('syncHouseholdMembers', () => {
  beforeEach(() => {
    useSessionUIStore.getState().resetSessionUI();
  });

  it('does not invent fake household or member rows when offline', async () => {
    const { db } = createInMemoryTestDb();
    useSessionUIStore.getState().setSession({
      userId: 'user-1',
      userEmail: 'a@b.com',
      activeHouseholdId: 'hh-1',
      memberRole: 'FOUNDER',
    });

    await syncHouseholdMembers(db, 'hh-1');

    expect(db.select().from(households).all()).toHaveLength(0);
    expect(db.select().from(householdMembers).all()).toHaveLength(0);
  });
});
