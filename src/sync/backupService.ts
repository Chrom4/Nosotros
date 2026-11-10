import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/data/db';
import * as schema from '@/data/schema';
import {
  encryptBackup,
  decryptBackupToString,
} from './backupCrypto';

export interface BackupDataSnapshot {
  version: number;
  exportedAt: string;
  householdId: string;
  syncEpoch: number;
  data: {
    households: (typeof schema.households.$inferSelect)[];
    householdMembers: (typeof schema.householdMembers.$inferSelect)[];
    accounts: (typeof schema.accounts.$inferSelect)[];
    categories: (typeof schema.categories.$inferSelect)[];
    creditCards: (typeof schema.creditCards.$inferSelect)[];
    creditCardInvoices: (typeof schema.creditCardInvoices.$inferSelect)[];
    installmentPlans: (typeof schema.installmentPlans.$inferSelect)[];
    recurringRules: (typeof schema.recurringRules.$inferSelect)[];
    transactions: (typeof schema.transactions.$inferSelect)[];
    budgets: (typeof schema.budgets.$inferSelect)[];
  };
}

export interface CreateBackupResult {
  filename: string;
  envelope: Uint8Array;
  snapshot: BackupDataSnapshot;
}

export interface RestoreBackupResult {
  success: boolean;
  householdId: string;
  previousSyncEpoch: number;
  newSyncEpoch: number;
  recordCounts: {
    accounts: number;
    categories: number;
    creditCards: number;
    creditCardInvoices: number;
    installmentPlans: number;
    recurringRules: number;
    transactions: number;
    budgets: number;
  };
}

/**
 * Extracts a complete domain data snapshot for the given household.
 */
export async function createDatabaseSnapshot(
  db: AppDatabase,
  householdId: string,
): Promise<BackupDataSnapshot> {
  const [household] = await db
    .select()
    .from(schema.households)
    .where(eq(schema.households.id, householdId));

  if (!household) {
    throw new Error(`HOUSEHOLD_NOT_FOUND: Household ${householdId} not found in local DB`);
  }

  const members = await db
    .select()
    .from(schema.householdMembers)
    .where(eq(schema.householdMembers.householdId, householdId));

  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.householdId, householdId));

  const categories = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.householdId, householdId));

  const cards = await db
    .select()
    .from(schema.creditCards)
    .where(eq(schema.creditCards.householdId, householdId));

  const invoices = await db
    .select()
    .from(schema.creditCardInvoices)
    .where(eq(schema.creditCardInvoices.householdId, householdId));

  const installments = await db
    .select()
    .from(schema.installmentPlans)
    .where(eq(schema.installmentPlans.householdId, householdId));

  const recurring = await db
    .select()
    .from(schema.recurringRules)
    .where(eq(schema.recurringRules.householdId, householdId));

  const txs = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.householdId, householdId));

  const budgets = await db
    .select()
    .from(schema.budgets)
    .where(eq(schema.budgets.householdId, householdId));

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    householdId,
    syncEpoch: household.syncEpoch,
    data: {
      households: [household],
      householdMembers: members,
      accounts,
      categories,
      creditCards: cards,
      creditCardInvoices: invoices,
      installmentPlans: installments,
      recurringRules: recurring,
      transactions: txs,
      budgets,
    },
  };
}

/**
 * Creates an encrypted backup binary envelope ready for upload.
 */
export async function createEncryptedBackupFile(
  db: AppDatabase,
  householdId: string,
  passphrase: string,
): Promise<CreateBackupResult> {
  const snapshot = await createDatabaseSnapshot(db, householdId);
  const jsonStr = JSON.stringify(snapshot);
  const envelope = encryptBackup(jsonStr, passphrase);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `nosotros_backup_${householdId.slice(0, 8)}_${timestamp}.bin`;

  return {
    filename,
    envelope,
    snapshot,
  };
}

/**
 * Restores database state from an encrypted backup envelope with an atomic sync_epoch bump.
 */
export async function restoreDatabaseFromBackup(
  db: AppDatabase,
  envelope: Uint8Array,
  passphrase: string,
  targetHouseholdId?: string,
): Promise<RestoreBackupResult> {
  const jsonStr = decryptBackupToString(envelope, passphrase);
  let snapshot: BackupDataSnapshot;

  try {
    snapshot = JSON.parse(jsonStr) as BackupDataSnapshot;
  } catch {
    throw new Error('INVALID_BACKUP_PAYLOAD: Corrupted JSON content inside envelope');
  }

  if (snapshot.version !== 1 || !snapshot.data || !snapshot.householdId) {
    throw new Error('INVALID_BACKUP_SCHEMA: Snapshot schema is invalid or unrecognized');
  }

  if (targetHouseholdId && snapshot.householdId !== targetHouseholdId) {
    throw new Error(
      `HOUSEHOLD_MISMATCH: Backup belongs to household ${snapshot.householdId}, expected ${targetHouseholdId}`,
    );
  }

  const previousSyncEpoch = snapshot.syncEpoch ?? 1;
  const newSyncEpoch = previousSyncEpoch + 1;

  db.transaction((tx) => {
    // 1. Wipe local tables in reverse foreign-key order
    tx.delete(schema.transactions).run();
    tx.delete(schema.budgets).run();
    tx.delete(schema.recurringRules).run();
    tx.delete(schema.installmentPlans).run();
    tx.delete(schema.creditCardInvoices).run();
    tx.delete(schema.creditCards).run();
    tx.delete(schema.categories).run();
    tx.delete(schema.accounts).run();
    tx.delete(schema.householdMembers).run();
    tx.delete(schema.households).run();
    tx.delete(schema.syncOutbox).run();

    // 2. Insert restored households with bumped sync_epoch
    for (const h of snapshot.data.households) {
      tx.insert(schema.households)
        .values({
          ...h,
          syncEpoch: newSyncEpoch,
          updatedAt: new Date().toISOString(),
        })
        .run();
    }

    // 3. Insert household members
    for (const m of snapshot.data.householdMembers) {
      tx.insert(schema.householdMembers).values(m).run();
    }

    // 4. Insert accounts
    for (const acc of snapshot.data.accounts) {
      tx.insert(schema.accounts).values(acc).run();
    }

    // 5. Insert categories
    for (const cat of snapshot.data.categories) {
      tx.insert(schema.categories).values(cat).run();
    }

    // 6. Insert credit cards
    for (const card of snapshot.data.creditCards) {
      tx.insert(schema.creditCards).values(card).run();
    }

    // 7. Insert credit card invoices
    for (const inv of snapshot.data.creditCardInvoices) {
      tx.insert(schema.creditCardInvoices).values(inv).run();
    }

    // 8. Insert installment plans
    for (const inst of snapshot.data.installmentPlans) {
      tx.insert(schema.installmentPlans).values(inst).run();
    }

    // 9. Insert recurring rules
    for (const rec of snapshot.data.recurringRules) {
      tx.insert(schema.recurringRules).values(rec).run();
    }

    // 10. Insert transactions
    for (const transaction of snapshot.data.transactions) {
      tx.insert(schema.transactions).values(transaction).run();
    }

    // 11. Insert budgets
    for (const b of snapshot.data.budgets) {
      tx.insert(schema.budgets).values(b).run();
    }

    // 12. Update sync_meta with the new bumped sync_epoch
    tx.insert(schema.syncMeta)
      .values({
        key: schema.SYNC_META_KEYS.SYNC_EPOCH,
        value: newSyncEpoch.toString(),
      })
      .onConflictDoUpdate({
        target: schema.syncMeta.key,
        set: { value: newSyncEpoch.toString() },
      })
      .run();
  });

  return {
    success: true,
    householdId: snapshot.householdId,
    previousSyncEpoch,
    newSyncEpoch,
    recordCounts: {
      accounts: snapshot.data.accounts.length,
      categories: snapshot.data.categories.length,
      creditCards: snapshot.data.creditCards.length,
      creditCardInvoices: snapshot.data.creditCardInvoices.length,
      installmentPlans: snapshot.data.installmentPlans.length,
      recurringRules: snapshot.data.recurringRules.length,
      transactions: snapshot.data.transactions.length,
      budgets: snapshot.data.budgets.length,
    },
  };
}
