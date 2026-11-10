import { FlashList } from '@shopify/flash-list';
import { and, desc, eq, isNull } from 'drizzle-orm';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  calculateMonthlySummaryCents,
  type LedgerTransaction,
  matchesOwnershipFilter,
  type OwnershipFilter,
} from '@/core';
import { TransactionQuickModal } from '@/components/TransactionQuickModal';
import {
  accounts,
  type AppDatabase,
  categories,
  getActiveDatabase,
  householdMembers,
  softDeleteTransaction,
  transactions,
  useReactiveQuery,
} from '@/data';
import {
  formatCentsToBrl,
  useFiltersStore,
  useSessionUIStore,
} from '@/store';

export interface TransactionsScreenProps {
  db?: AppDatabase | null;
  householdId?: string | null;
  currentUserId?: string | null;
}

export default function TransactionsScreen({
  db: propDb,
  householdId: propHouseholdId,
  currentUserId: propCurrentUserId,
}: TransactionsScreenProps = {}) {
  const sessionHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const sessionUserId = useSessionUIStore((s) => s.userId);

  const competenceMonth = useFiltersStore((s) => s.competenceMonth);
  const ownershipFilter = useFiltersStore((s) => s.ownershipFilter);
  const shiftCompetenceMonth = useFiltersStore((s) => s.shiftCompetenceMonth);
  const setOwnershipFilter = useFiltersStore((s) => s.setOwnershipFilter);
  const openQuickModal = useFiltersStore((s) => s.openQuickModal);

  const db = propDb ?? getActiveDatabase();
  const householdId = propHouseholdId ?? sessionHouseholdId;
  const currentUserId = propCurrentUserId ?? sessionUserId;

  const { data: txRows } = useReactiveQuery(
    () =>
      db && householdId
        ? db
            .select()
            .from(transactions)
            .where(
              and(
                eq(transactions.householdId, householdId),
                eq(transactions.competenceMonth, competenceMonth),
                isNull(transactions.deletedAt),
              ),
            )
            .orderBy(
              desc(transactions.transactionDate),
              desc(transactions.hlcTimestamp),
            )
        : null,
    [db, householdId, competenceMonth],
    ['transactions'],
  );

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

  const filteredTransactions = useMemo(
    () =>
      txRows.filter((tx) =>
        matchesOwnershipFilter(tx.ownerUserId, ownershipFilter),
      ),
    [txRows, ownershipFilter],
  );

  const monthlySummary = useMemo(() => {
    const ledgerTxs: LedgerTransaction[] = txRows.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      amountCents: t.amountCents,
      transactionDate: t.transactionDate,
      competenceMonth: t.competenceMonth,
      description: t.description,
      accountId: t.accountId,
      transferAccountId: t.transferAccountId,
      creditCardId: t.creditCardId,
      invoiceId: t.invoiceId,
      categoryId: t.categoryId,
      ownerUserId: t.ownerUserId,
      installmentPlanId: t.installmentPlanId,
      installmentNumber: t.installmentNumber,
      totalInstallments: t.totalInstallments,
      recurringRuleId: t.recurringRuleId,
      refundedTransactionId: t.refundedTransactionId,
      isHouseholdContribution: t.isHouseholdContribution,
      deletedAt: t.deletedAt,
    }));

    return calculateMonthlySummaryCents(
      competenceMonth,
      ledgerTxs,
      ownershipFilter,
    );
  }, [txRows, competenceMonth, ownershipFilter]);

  const accountNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const acc of accountRows) {
      map.set(acc.id, acc.name);
    }
    return map;
  }, [accountRows]);

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categoryRows) {
      map.set(cat.id, cat.name);
    }
    return map;
  }, [categoryRows]);

  const handleSoftDelete = (transactionId: string) => {
    if (!db) return;
    softDeleteTransaction(db, transactionId);
  };

  const renderFilterChip = (
    label: string,
    filter: OwnershipFilter,
    testId: string,
  ) => {
    const isSelected =
      ownershipFilter.mode === filter.mode &&
      (filter.mode !== 'USER' ||
        (ownershipFilter.mode === 'USER' &&
          ownershipFilter.userId === filter.userId));

    return (
      <Pressable
        key={testId}
        testID={testId}
        style={[styles.filterChip, isSelected && styles.filterChipActive]}
        onPress={() => setOwnershipFilter(filter)}
      >
        <Text
          style={[
            styles.filterChipText,
            isSelected && styles.filterChipTextActive,
          ]}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.container} testID="transactions-screen">
      {/* Navegação de Competência Mensal e Filtro de Titularidade */}
      <View style={styles.headerCard}>
        <View style={styles.monthRow}>
          <Pressable
            testID="transactions-prev-month"
            style={styles.monthNavBtn}
            onPress={() => shiftCompetenceMonth(-1)}
          >
            <Text style={styles.monthNavText}>‹ Anterior</Text>
          </Pressable>
          <Text
            style={styles.monthTitle}
            testID="transactions-competence-month"
          >
            {competenceMonth}
          </Text>
          <Pressable
            testID="transactions-next-month"
            style={styles.monthNavBtn}
            onPress={() => shiftCompetenceMonth(1)}
          >
            <Text style={styles.monthNavText}>Próximo ›</Text>
          </Pressable>
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryBox}>
            <Text style={styles.summaryLabel}>Receitas</Text>
            <Text
              style={styles.incomeText}
              testID="transactions-monthly-income"
            >
              {formatCentsToBrl(monthlySummary.incomeCents)}
            </Text>
          </View>
          <View style={styles.summaryBox}>
            <Text style={styles.summaryLabel}>Despesas Líq.</Text>
            <Text
              style={styles.expenseText}
              testID="transactions-monthly-expense"
            >
              {formatCentsToBrl(monthlySummary.expenseCents)}
            </Text>
          </View>
          <View style={styles.summaryBox}>
            <Text style={styles.summaryLabel}>Resultado</Text>
            <Text
              style={styles.netText}
              testID="transactions-monthly-net"
            >
              {formatCentsToBrl(monthlySummary.netSavingsCents)}
            </Text>
          </View>
        </View>

        <View style={styles.filterRow}>
          {renderFilterChip(
            'Consolidado',
            { mode: 'CONSOLIDATED' },
            'transactions-filter-CONSOLIDATED',
          )}
          {renderFilterChip(
            'Casa (Compartilhado)',
            { mode: 'DOMESTIC' },
            'transactions-filter-DOMESTIC',
          )}
          {memberRows.map((m) =>
            renderFilterChip(
              m.displayName,
              { mode: 'USER', userId: m.userId },
              `transactions-filter-USER-${m.userId}`,
            ),
          )}
        </View>

        <Pressable
          testID="open-quick-modal-button"
          style={styles.quickAddButton}
          onPress={() => openQuickModal('EXPENSE')}
        >
          <Text style={styles.quickAddButtonText}>+ Novo Lançamento Base</Text>
        </Pressable>
      </View>

      {/* Lista Reativa de Lançamentos via FlashList */}
      <View style={styles.listWrapper}>
        <FlashList
          data={filteredTransactions}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const originAcc = item.accountId
              ? (accountNameById.get(item.accountId) ?? 'Conta')
              : 'Cartão';
            const destAcc = item.transferAccountId
              ? (accountNameById.get(item.transferAccountId) ?? 'Destino')
              : null;
            const catName = item.categoryId
              ? (categoryNameById.get(item.categoryId) ?? 'Categoria')
              : 'Transferência';
            const ownerName =
              item.ownerUserId === null
                ? 'Casa'
                : (memberRows.find((m) => m.userId === item.ownerUserId)
                    ?.displayName ?? 'Individual');

            const isPositiveFlow =
              item.type === 'INCOME' || item.type === 'DEBIT_REFUND';

            return (
              <View
                style={styles.txItem}
                testID={`transaction-row-${item.id}`}
              >
                <View style={styles.txLeft}>
                  <Text style={styles.txDescription}>{item.description}</Text>
                  <Text style={styles.txMeta}>
                    {item.transactionDate} •{' '}
                    {item.type === 'TRANSFER'
                      ? `${originAcc} → ${destAcc}`
                      : `${catName} (${originAcc})`}{' '}
                    • {ownerName}
                  </Text>
                  {item.isHouseholdContribution ? (
                    <Text
                      style={styles.dec02Badge}
                      testID={`transaction-dec02-badge-${item.id}`}
                    >
                      Aporte Casa (DEC-02)
                    </Text>
                  ) : null}
                </View>

                <View style={styles.txRight}>
                  <Text
                    style={[
                      styles.txAmount,
                      item.type === 'TRANSFER'
                        ? styles.transferAmount
                        : isPositiveFlow
                          ? styles.incomeText
                          : styles.expenseText,
                    ]}
                    testID={`transaction-amount-${item.id}`}
                  >
                    {formatCentsToBrl(item.amountCents)}
                  </Text>
                  <Pressable
                    testID={`delete-transaction-${item.id}`}
                    onPress={() => handleSoftDelete(item.id)}
                    style={styles.deleteBtn}
                  >
                    <Text style={styles.deleteBtnText}>Excluir</Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.emptyText} testID="transactions-empty-state">
              Nenhum lançamento neste mês para o filtro ativo.
            </Text>
          }
        />
      </View>

      <TransactionQuickModal
        db={db}
        householdId={householdId}
        currentUserId={currentUserId}
        accounts={accountRows}
        categories={categoryRows}
        members={memberRows}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    padding: 16,
  },
  headerCard: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 12,
  },
  monthRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  monthNavBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#0F172A',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  monthNavText: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '600',
  },
  monthTitle: {
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '800',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 8,
  },
  summaryBox: {
    flex: 1,
    backgroundColor: '#0F172A',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  summaryLabel: {
    color: '#94A3B8',
    fontSize: 11,
    marginBottom: 4,
  },
  incomeText: {
    color: '#34D399',
    fontSize: 13,
    fontWeight: '700',
  },
  expenseText: {
    color: '#FB7185',
    fontSize: 13,
    fontWeight: '700',
  },
  netText: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
  },
  transferAmount: {
    color: '#818CF8',
    fontSize: 13,
    fontWeight: '700',
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 12,
  },
  filterChip: {
    backgroundColor: '#0F172A',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  filterChipActive: {
    backgroundColor: '#4F46E5',
    borderColor: '#6366F1',
  },
  filterChipText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: '#FFFFFF',
  },
  quickAddButton: {
    backgroundColor: '#4F46E5',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  quickAddButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  listWrapper: {
    flex: 1,
  },
  txItem: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  txLeft: {
    flex: 1,
    paddingRight: 10,
  },
  txDescription: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  txMeta: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 2,
  },
  dec02Badge: {
    color: '#A7F3D0',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
  },
  txRight: {
    alignItems: 'flex-end',
  },
  txAmount: {
    fontSize: 14,
    fontWeight: '700',
  },
  deleteBtn: {
    marginTop: 6,
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  deleteBtnText: {
    color: '#FB7185',
    fontSize: 11,
    fontWeight: '600',
  },
  emptyText: {
    color: '#64748B',
    textAlign: 'center',
    marginTop: 24,
    fontSize: 14,
  },
});
