import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BudgetBar } from '@/components/BudgetBar';
import { ContextPills } from '@/components/ContextPills';
import { ContributionCard } from '@/components/ContributionCard';
import { NetWorthChart } from '@/components/NetWorthChart';
import {
  type AppDatabase,
  getDashboardAggregates,
  subscribeToDatabaseChanges,
  useActiveDatabase,
} from '@/data';
import { syncHouseholdMembers } from '@/sync/membershipSync';
import {
  formatCentsToBrl,
  useFiltersStore,
  useSessionUIStore,
} from '@/store';
import { getContextTheme } from '@/theme';

export interface DashboardScreenProps {
  db?: AppDatabase | null;
  householdId?: string | null;
  currentUserId?: string | null;
}

const MONTH_NAMES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

function formatMonthHeader(competenceMonth: string): string {
  const [yearStr, monthStr] = competenceMonth.split('-');
  const monthIdx = Number(monthStr) - 1;
  const name = MONTH_NAMES[monthIdx] ?? monthStr;
  return `${name} ${yearStr}`;
}

export default function DashboardScreen({
  db: propDb,
  householdId: propHouseholdId,
  currentUserId: propCurrentUserId,
}: DashboardScreenProps = {}) {
  const sessionHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const sessionUserId = useSessionUIStore((s) => s.userId);

  const competenceMonth = useFiltersStore((s) => s.competenceMonth);
  const ownershipFilter = useFiltersStore((s) => s.ownershipFilter);
  const shiftCompetenceMonth = useFiltersStore((s) => s.shiftCompetenceMonth);
  const setOwnershipFilter = useFiltersStore((s) => s.setOwnershipFilter);
  const openQuickModal = useFiltersStore((s) => s.openQuickModal);

  const db = useActiveDatabase(propDb);
  const householdId = propHouseholdId ?? sessionHouseholdId;
  const currentUserId = propCurrentUserId ?? sessionUserId;

  const [dbRevision, setDbRevision] = useState(0);

  useEffect(() => {
    if (db && householdId) {
      syncHouseholdMembers(db, householdId).catch(() => {});
    }
  }, [db, householdId]);

  useEffect(() => {
    const unsubscribe = subscribeToDatabaseChanges(() => {
      setDbRevision((r) => r + 1);
    });
    return unsubscribe;
  }, []);

  const theme = useMemo(
    () => getContextTheme(ownershipFilter, currentUserId),
    [ownershipFilter, currentUserId],
  );

  const aggregates = useMemo(() => {
    if (!db || !householdId || dbRevision < 0) {
      return null;
    }
    return getDashboardAggregates(
      db,
      householdId,
      competenceMonth,
      ownershipFilter,
    );
  }, [db, householdId, competenceMonth, ownershipFilter, dbRevision]);

  const partner = aggregates?.members.find((m) => m.userId !== currentUserId);
  const partnerUserId = partner?.userId ?? null;
  const partnerName = partner?.displayName ?? null;

  const memberNames: Record<string, string> = useMemo(() => {
    const map: Record<string, string> = {};
    if (aggregates?.members) {
      for (const m of aggregates.members) {
        map[m.userId] =
          m.userId === currentUserId ? 'Você' : m.displayName;
      }
    }
    return map;
  }, [aggregates, currentUserId]);

  const summary = aggregates?.monthlySummary ?? {
    incomeCents: 0,
    expenseCents: 0,
    netSavingsCents: 0,
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.surface }]}>
      {/* Month Navigator Header */}
      <View style={[styles.monthHeader, { backgroundColor: theme.surfaceVariant }]}>
        <Pressable
          testID="month-prev-btn"
          accessibilityRole="button"
          accessibilityLabel="Mês anterior"
          onPress={() => shiftCompetenceMonth(-1)}
          style={styles.monthNavBtn}
        >
          <Text style={[styles.monthNavBtnText, { color: theme.accent }]}>◀</Text>
        </Pressable>

        <Text
          testID="competence-month-label"
          style={[styles.monthLabel, { color: theme.textPrimary }]}
        >
          {formatMonthHeader(competenceMonth)}
        </Text>

        <Pressable
          testID="month-next-btn"
          accessibilityRole="button"
          accessibilityLabel="Próximo mês"
          onPress={() => shiftCompetenceMonth(1)}
          style={styles.monthNavBtn}
        >
          <Text style={[styles.monthNavBtnText, { color: theme.accent }]}>▶</Text>
        </Pressable>
      </View>

      {/* Contextual Pills */}
      <ContextPills
        currentUserId={currentUserId}
        partnerUserId={partnerUserId}
        partnerName={partnerName}
        activeFilter={ownershipFilter}
        onSelectFilter={setOwnershipFilter}
        theme={theme}
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Monthly Summary Cards (Income / Expense / Savings) */}
        <View style={styles.summaryGrid}>
          {/* Income */}
          <View
            style={[
              styles.summaryCard,
              { backgroundColor: theme.surfaceVariant, borderTopColor: theme.income },
            ]}
          >
            <Text style={[styles.summaryCardLabel, { color: theme.textSecondary }]}>
              Receitas
            </Text>
            <Text
              testID="summary-income"
              style={[styles.summaryCardAmount, { color: theme.income }]}
            >
              {formatCentsToBrl(summary.incomeCents)}
            </Text>
          </View>

          {/* Expense */}
          <View
            style={[
              styles.summaryCard,
              { backgroundColor: theme.surfaceVariant, borderTopColor: theme.expense },
            ]}
          >
            <Text style={[styles.summaryCardLabel, { color: theme.textSecondary }]}>
              Despesas
            </Text>
            <Text
              testID="summary-expense"
              style={[styles.summaryCardAmount, { color: theme.expense }]}
            >
              {formatCentsToBrl(summary.expenseCents)}
            </Text>
          </View>

          {/* Net Savings */}
          <View
            style={[
              styles.summaryCard,
              {
                backgroundColor: theme.surfaceVariant,
                borderTopColor:
                  summary.netSavingsCents >= 0 ? theme.savings : theme.expense,
              },
            ]}
          >
            <Text style={[styles.summaryCardLabel, { color: theme.textSecondary }]}>
              Saldo do Mês
            </Text>
            <Text
              testID="summary-savings"
              style={[
                styles.summaryCardAmount,
                {
                  color:
                    summary.netSavingsCents >= 0 ? theme.savings : theme.expense,
                },
              ]}
            >
              {formatCentsToBrl(summary.netSavingsCents)}
            </Text>
          </View>
        </View>

        {/* Net Worth Card & SVG Chart */}
        <View
          testID="net-worth-card"
          style={[styles.netWorthCard, { backgroundColor: theme.cardBackground }]}
        >
          <View style={styles.netWorthHeader}>
            <View>
              <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>
                Patrimônio Líquido
              </Text>
              <Text
                testID="net-worth-amount"
                style={[styles.netWorthValue, { color: theme.textPrimary }]}
              >
                {formatCentsToBrl(aggregates?.netWorthCents ?? 0)}
              </Text>
            </View>
            <View
              style={[
                styles.contextBadge,
                { backgroundColor: theme.primaryContainer },
              ]}
            >
              <Text
                style={[
                  styles.contextBadgeText,
                  { color: theme.onPrimaryContainer },
                ]}
              >
                {theme.label}
              </Text>
            </View>
          </View>

          {/* Net Worth Evolution SVG Chart */}
          <View style={styles.chartWrapper}>
            <NetWorthChart
              data={aggregates?.netWorthEvolution ?? []}
              theme={theme}
            />
          </View>
        </View>

        {/* DEC-02: Contribution Split Breakdown */}
        <View testID="contributions-section">
          <ContributionCard
            summary={aggregates?.contributions ?? null}
            currentUserId={currentUserId}
            memberNames={memberNames}
            theme={theme}
          />
        </View>

        {/* DEC-01: Budgets Section */}
        <View testID="budgets-section" style={styles.budgetsSection}>
          <View style={styles.sectionHeaderRow}>
            <Text style={[styles.sectionTitle, { color: theme.textPrimary }]}>
              Orçamentos ({aggregates?.budgets.length ?? 0})
            </Text>
            <Text style={[styles.sectionSub, { color: theme.textSecondary }]}>
              Regime de Caixa (DEC-01)
            </Text>
          </View>

          {aggregates && aggregates.budgets.length > 0 ? (
            aggregates.budgets.map((b) => (
              <BudgetBar key={b.id} budget={b} theme={theme} />
            ))
          ) : (
            <View
              style={[
                styles.emptyBudgetsBox,
                { backgroundColor: theme.surfaceVariant },
              ]}
            >
              <Text style={[styles.emptyBudgetsText, { color: theme.textSecondary }]}>
                Nenhum orçamento configurado para {formatMonthHeader(competenceMonth)}.
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Floating Action Button for Quick Transaction */}
      <Pressable
        testID="quick-add-tx-fab"
        accessibilityRole="button"
        accessibilityLabel="Novo Lançamento Rápido"
        onPress={() => openQuickModal('EXPENSE')}
        style={[styles.fab, { backgroundColor: theme.primary }]}
      >
        <Text style={[styles.fabText, { color: theme.onPrimary }]}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  monthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  monthNavBtn: {
    padding: 8,
  },
  monthNavBtnText: {
    fontSize: 16,
    fontWeight: '700',
  },
  monthLabel: {
    fontSize: 16,
    fontWeight: '700',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 80,
  },
  summaryGrid: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  summaryCard: {
    flex: 1,
    borderRadius: 10,
    padding: 10,
    borderTopWidth: 3,
    borderWidth: 1,
    borderColor: '#334155',
  },
  summaryCardLabel: {
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 4,
  },
  summaryCardAmount: {
    fontSize: 13,
    fontWeight: '700',
  },
  netWorthCard: {
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  netWorthHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  netWorthValue: {
    fontSize: 22,
    fontWeight: '800',
  },
  contextBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  contextBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  chartWrapper: {
    alignItems: 'center',
    marginTop: 4,
  },
  budgetsSection: {
    marginBottom: 16,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 12,
  },
  sectionSub: {
    fontSize: 11,
  },
  emptyBudgetsBox: {
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  emptyBudgetsText: {
    fontSize: 13,
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  fabText: {
    fontSize: 28,
    fontWeight: '400',
    marginTop: -2,
  },
});
