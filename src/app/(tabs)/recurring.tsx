import { FlashList } from '@shopify/flash-list';
import { and, eq, isNull } from 'drizzle-orm';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BottomSheetModal } from '@/components/BottomSheetModal';
import { CurrencyInput } from '@/components/CurrencyInput';
import { DatePickerInput } from '@/components/DatePickerInput';
import type { RecurringFrequency, RecurringRuleType } from '@/core';
import {
  accounts,
  type AppDatabase,
  calculateRecurringProjectionSummary,
  categories,
  confirmPendingTransaction,
  createRecurringRule,
  creditCards,
  generateUuidV4,
  householdMembers,
  listRecurringOccurrencesForMonth,
  listRecurringRulesWithDetails,
  materializeMonth,
  recurringRules,
  type RecurringRuleWithDetails,
  softDeleteRecurringRule,
  transactions,
  updateRecurringRuleWithOccurrences,
  useActiveDatabase,
  useReactiveQuery,
} from '@/data';
import { syncHouseholdMembers } from '@/sync/membershipSync';
import {
  formatCentsToBrl,
  useFiltersStore,
  useSessionUIStore,
} from '@/store';
import { styles } from './recurring.styles';

export interface RecurringScreenProps {
  db?: AppDatabase | null;
  householdId?: string | null;
  currentUserId?: string | null;
}

export default function RecurringScreen({
  db: propDb,
  householdId: propHouseholdId,
  currentUserId: propCurrentUserId,
}: RecurringScreenProps = {}) {
  const sessionHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const sessionUserId = useSessionUIStore((s) => s.userId);
  const sessionUserEmail = useSessionUIStore((s) => s.userEmail);
  const ownershipFilter = useFiltersStore((s) => s.ownershipFilter);
  const setOwnershipFilter = useFiltersStore((s) => s.setOwnershipFilter);
  const competenceMonth = useFiltersStore((s) => s.competenceMonth);
  const shiftCompetenceMonth = useFiltersStore((s) => s.shiftCompetenceMonth);

  const db = useActiveDatabase(propDb);
  const householdId = propHouseholdId ?? sessionHouseholdId;
  const currentUserId = propCurrentUserId ?? sessionUserId;

  const [activeTab, setActiveTab] = useState<'PROJECTIONS' | 'RULES'>('PROJECTIONS');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [formType, setFormType] = useState<RecurringRuleType>('EXPENSE');
  const [formDescription, setFormDescription] = useState('');
  const [formAmountCents, setFormAmountCents] = useState(0);
  const [formDayOfMonth, setFormDayOfMonth] = useState('10');
  const [formFrequency, setFormFrequency] = useState<RecurringFrequency>('MONTHLY');
  const [formStartMonth, setFormStartMonth] = useState(competenceMonth);
  const [formEndMonth, setFormEndMonth] = useState('');
  const [formCategoryId, setFormCategoryId] = useState('');
  const [formAccountId, setFormAccountId] = useState('');
  const [formCardId, setFormCardId] = useState('');
  const [formOwnerUserId, setFormOwnerUserId] = useState<string | null>(null);

  useEffect(() => {
    if (db && householdId) {
      void syncHouseholdMembers(db, householdId);
    }
  }, [db, householdId]);

  // Reactive queries
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

  const effectiveMembers = useMemo(() => {
    if (memberRows && memberRows.length > 0) {
      return memberRows;
    }
    if (sessionUserId) {
      return [
        {
          id: 'me',
          householdId: householdId ?? '',
          userId: sessionUserId,
          displayName: sessionUserEmail
            ? sessionUserEmail.split('@')[0]
            : 'Você',
          role: 'FOUNDER' as const,
          colorHex: '#4F46E5',
          joinedAt: new Date().toISOString(),
          revokedAt: null,
        },
      ];
    }
    return [];
  }, [memberRows, sessionUserId, sessionUserEmail, householdId]);

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
                eq(accounts.isArchived, false),
              ),
            )
        : null,
    [db, householdId],
    ['accounts'],
  );

  const { data: cardRows } = useReactiveQuery(
    () =>
      db && householdId
        ? db
            .select()
            .from(creditCards)
            .where(
              and(
                eq(creditCards.householdId, householdId),
                isNull(creditCards.deletedAt),
                eq(creditCards.isArchived, false),
              ),
            )
        : null,
    [db, householdId],
    ['credit_cards'],
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

  // Trigger reactive updates when transactions or recurring_rules change
  const { data: txList } = useReactiveQuery(
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
        : null,
    [db, householdId, competenceMonth],
    ['transactions'],
  );

  const { data: rawRuleRows } = useReactiveQuery(
    () =>
      db && householdId
        ? db
            .select()
            .from(recurringRules)
            .where(
              and(
                eq(recurringRules.householdId, householdId),
                isNull(recurringRules.deletedAt),
              ),
            )
        : null,
    [db, householdId],
    ['recurring_rules'],
  );

  // Filtered occurrences and projection summary
  const occurrences = useMemo(() => {
    if (!db || !householdId) return [];
    // Reference reactive rows so this recomputes whenever transactions/rules update
    void txList;
    void rawRuleRows;
    return listRecurringOccurrencesForMonth(
      db,
      householdId,
      competenceMonth,
      ownershipFilter,
    );
  }, [db, householdId, competenceMonth, ownershipFilter, txList, rawRuleRows]);

  const projectionSummary = useMemo(() => {
    if (!txList) {
      return {
        projectedIncomeCents: 0,
        projectedExpenseCents: 0,
        projectedNetBalanceCents: 0,
        totalOccurrencesCount: 0,
        pendingCount: 0,
        clearedCount: 0,
        pendingIncomeCents: 0,
        pendingExpenseCents: 0,
      };
    }
    const relevantTxs = txList.filter((t) => t.recurringRuleId !== null);
    return calculateRecurringProjectionSummary(relevantTxs);
  }, [txList]);

  const rulesWithDetails = useMemo(() => {
    if (!db || !householdId) return [];
    void rawRuleRows;
    void categoryRows;
    void accountRows;
    void cardRows;
    void memberRows;
    return listRecurringRulesWithDetails(db, householdId);
  }, [db, householdId, rawRuleRows, categoryRows, accountRows, cardRows, memberRows]);

  const handleOpenNewModal = () => {
    setEditingRuleId(null);
    setFormType('EXPENSE');
    setFormDescription('');
    setFormAmountCents(0);
    setFormDayOfMonth('10');
    setFormFrequency('MONTHLY');
    setFormStartMonth(competenceMonth);
    setFormEndMonth('');
    setFormCategoryId(categoryRows?.[0]?.id ?? '');
    setFormAccountId(accountRows?.[0]?.id ?? '');
    setFormCardId(cardRows?.[0]?.id ?? '');
    setFormOwnerUserId(null);
    setErrorMessage(null);
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (item: RecurringRuleWithDetails) => {
    setEditingRuleId(item.rule.id);
    setFormType(item.rule.type);
    setFormDescription(item.rule.description);
    setFormAmountCents(item.rule.amountCents);
    setFormDayOfMonth(String(item.rule.dayOfMonth));
    setFormFrequency(item.rule.frequency);
    setFormStartMonth(item.rule.startMonth);
    setFormEndMonth(item.rule.endMonth ?? '');
    setFormCategoryId(item.rule.categoryId);
    setFormAccountId(item.rule.accountId ?? accountRows?.[0]?.id ?? '');
    setFormCardId(item.rule.creditCardId ?? cardRows?.[0]?.id ?? '');
    setFormOwnerUserId(item.rule.ownerUserId);
    setErrorMessage(null);
    setIsModalOpen(true);
  };

  const handleSaveRule = () => {
    if (!db || !householdId || !currentUserId) return;
    setErrorMessage(null);

    const cents = formAmountCents;
    if (cents <= 0) {
      setErrorMessage('Informe um valor válido maior que zero.');
      return;
    }

    const day = parseInt(formDayOfMonth, 10);
    if (isNaN(day) || day < 1 || day > 31) {
      setErrorMessage('Dia do mês deve ser entre 1 e 31.');
      return;
    }

    if (!formDescription.trim()) {
      setErrorMessage('Descrição é obrigatória.');
      return;
    }

    if (!formCategoryId) {
      setErrorMessage('Selecione uma categoria.');
      return;
    }

    if (formType === 'CREDIT_PURCHASE' && !formCardId) {
      setErrorMessage('Selecione um cartão de crédito.');
      return;
    }

    if (formType !== 'CREDIT_PURCHASE' && !formAccountId) {
      setErrorMessage('Selecione uma conta bancária.');
      return;
    }

    try {
      if (editingRuleId) {
        updateRecurringRuleWithOccurrences(
          db,
          editingRuleId,
          {
            description: formDescription.trim(),
            amountCents: cents,
            dayOfMonth: day,
            frequency: formFrequency,
            endMonth: formEndMonth.trim() || null,
            categoryId: formCategoryId,
            accountId: formType === 'CREDIT_PURCHASE' ? null : formAccountId,
            creditCardId: formType === 'CREDIT_PURCHASE' ? formCardId : null,
            ownerUserId: formOwnerUserId,
          },
          competenceMonth,
        );
        setFeedbackMessage('Regra atualizada com sucesso!');
      } else {
        createRecurringRule(db, {
          id: generateUuidV4(),
          householdId,
          createdByUserId: currentUserId,
          ownerUserId: formOwnerUserId,
          type: formType,
          accountId: formType === 'CREDIT_PURCHASE' ? null : formAccountId,
          creditCardId: formType === 'CREDIT_PURCHASE' ? formCardId : null,
          categoryId: formCategoryId,
          description: formDescription.trim(),
          amountCents: cents,
          frequency: formFrequency,
          dayOfMonth: day,
          startMonth: formStartMonth,
          endMonth: formEndMonth.trim() || null,
          isActive: true,
        });
        setFeedbackMessage('Regra criada com sucesso!');
      }
      setIsModalOpen(false);
      setTimeout(() => setFeedbackMessage(null), 3000);
    } catch (err) {
      setErrorMessage((err as Error).message);
    }
  };

  const handleSoftDeleteRule = (ruleId: string) => {
    if (!db) return;
    try {
      softDeleteRecurringRule(db, ruleId);
      setFeedbackMessage('Regra desativada.');
      setTimeout(() => setFeedbackMessage(null), 3000);
    } catch (err) {
      setErrorMessage((err as Error).message);
    }
  };

  const handleMaterializeMonth = () => {
    if (!db || !householdId || !currentUserId) return;
    try {
      const materialized = materializeMonth(db, {
        householdId,
        competenceMonth,
        defaultCreatedByUserId: currentUserId,
      });
      if (materialized.length > 0) {
        setFeedbackMessage(`${materialized.length} lançamentos gerados para ${competenceMonth}.`);
      } else {
        setFeedbackMessage(`Mês ${competenceMonth} já está atualizado.`);
      }
      setTimeout(() => setFeedbackMessage(null), 3000);
    } catch (err) {
      setErrorMessage((err as Error).message);
    }
  };

  const handleConfirmOccurrence = (transactionId: string) => {
    if (!db) return;
    try {
      confirmPendingTransaction(db, transactionId);
      setFeedbackMessage('Lançamento confirmado!');
      setTimeout(() => setFeedbackMessage(null), 3000);
    } catch (err) {
      setErrorMessage((err as Error).message);
    }
  };

  return (
    <View style={styles.container}>
      {/* Top Month Navigation */}
      <View style={styles.monthHeader}>
        <Pressable
          style={styles.navButton}
          onPress={() => shiftCompetenceMonth(-1)}
          accessibilityRole="button"
          accessibilityLabel="Mês Anterior"
        >
          <Text style={styles.navButtonText}>‹</Text>
        </Pressable>
        <Text style={styles.monthTitle}>{competenceMonth}</Text>
        <Pressable
          style={styles.navButton}
          onPress={() => shiftCompetenceMonth(1)}
          accessibilityRole="button"
          accessibilityLabel="Próximo Mês"
        >
          <Text style={styles.navButtonText}>›</Text>
        </Pressable>
      </View>

      {/* Ownership Filter Pills */}
      <View style={styles.filterRow}>
        <Pressable
          style={[
            styles.filterPill,
            ownershipFilter.mode === 'CONSOLIDATED' && styles.filterPillActive,
          ]}
          onPress={() => setOwnershipFilter({ mode: 'CONSOLIDATED' })}
        >
          <Text
            style={[
              styles.filterPillText,
              ownershipFilter.mode === 'CONSOLIDATED' && styles.filterPillTextActive,
            ]}
          >
            Consolidado
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.filterPill,
            ownershipFilter.mode === 'DOMESTIC' && styles.filterPillActive,
          ]}
          onPress={() => setOwnershipFilter({ mode: 'DOMESTIC' })}
        >
          <Text
            style={[
              styles.filterPillText,
              ownershipFilter.mode === 'DOMESTIC' && styles.filterPillTextActive,
            ]}
          >
            Casa
          </Text>
        </Pressable>
        {effectiveMembers.map((member) => {
          const isSelected =
            ownershipFilter.mode === 'USER' && ownershipFilter.userId === member.userId;
          return (
            <Pressable
              key={member.id}
              style={[styles.filterPill, isSelected && styles.filterPillActive]}
              onPress={() =>
                setOwnershipFilter({ mode: 'USER', userId: member.userId })
              }
            >
              <Text
                style={[
                  styles.filterPillText,
                  isSelected && styles.filterPillTextActive,
                ]}
              >
                {member.displayName}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Feedback / Error Banner */}
      {feedbackMessage ? (
        <View style={styles.feedbackBanner}>
          <Text style={styles.feedbackText}>{feedbackMessage}</Text>
        </View>
      ) : null}
      {errorMessage ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}

      {/* Tabs Switcher: Projeções vs Regras */}
      <View style={styles.tabBar}>
        <Pressable
          style={[styles.tabButton, activeTab === 'PROJECTIONS' && styles.tabButtonActive]}
          onPress={() => setActiveTab('PROJECTIONS')}
        >
          <Text
            style={[
              styles.tabButtonText,
              activeTab === 'PROJECTIONS' && styles.tabButtonTextActive,
            ]}
          >
            Projeções do Mês
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, activeTab === 'RULES' && styles.tabButtonActive]}
          onPress={() => setActiveTab('RULES')}
        >
          <Text
            style={[
              styles.tabButtonText,
              activeTab === 'RULES' && styles.tabButtonTextActive,
            ]}
          >
            Regras Fixas ({rulesWithDetails.length})
          </Text>
        </Pressable>
      </View>

      {/* Tab 1: Projeções do Mês */}
      {activeTab === 'PROJECTIONS' ? (
        <View style={styles.tabContent}>
          {/* Summary Card */}
          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View style={styles.summaryCol}>
                <Text style={styles.summaryLabel}>Receitas Previstas</Text>
                <Text style={[styles.summaryValue, styles.incomeText]}>
                  {formatCentsToBrl(projectionSummary.projectedIncomeCents)}
                </Text>
              </View>
              <View style={styles.summaryCol}>
                <Text style={styles.summaryLabel}>Despesas Previstas</Text>
                <Text style={[styles.summaryValue, styles.expenseText]}>
                  {formatCentsToBrl(projectionSummary.projectedExpenseCents)}
                </Text>
              </View>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryFooterRow}>
              <Text style={styles.summaryLabel}>Saldo Projetado:</Text>
              <Text
                style={[
                  styles.summaryNetValue,
                  projectionSummary.projectedNetBalanceCents >= 0
                    ? styles.incomeText
                    : styles.expenseText,
                ]}
              >
                {formatCentsToBrl(projectionSummary.projectedNetBalanceCents)}
              </Text>
              <View style={styles.badgeRow}>
                <View style={styles.statusBadgePending}>
                  <Text style={styles.statusBadgeTextPending}>
                    {projectionSummary.pendingCount} pendente(s)
                  </Text>
                </View>
                <View style={styles.statusBadgeCleared}>
                  <Text style={styles.statusBadgeTextCleared}>
                    {projectionSummary.clearedCount} ok
                  </Text>
                </View>
              </View>
            </View>
          </View>

          {/* Action Bar */}
          <View style={styles.actionBar}>
            <Pressable
              style={styles.materializeButton}
              onPress={handleMaterializeMonth}
              accessibilityRole="button"
              accessibilityLabel="Materializar Mês"
            >
              <Text style={styles.materializeButtonText}>⚡ Abrir / Materializar Mês</Text>
            </Pressable>
          </View>

          {/* Occurrences List */}
          <View style={styles.listContainer}>
            <FlashList
              data={occurrences}
              keyExtractor={(item) => item.transaction.id}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>
                    Nenhuma recorrência para {competenceMonth}.
                  </Text>
                  <Text style={styles.emptySubtext}>
                    Toque em &quot;Abrir / Materializar Mês&quot; ou configure regras na aba &quot;Regras Fixas&quot;.
                  </Text>
                </View>
              }
              renderItem={({ item }) => {
                const isPending = item.transaction.status === 'PENDING';
                const isIncome = item.transaction.type === 'INCOME';
                return (
                  <View style={styles.occurrenceCard}>
                    <View style={styles.occurrenceLeft}>
                      <View
                        style={[
                          styles.categoryIconCircle,
                          {
                            backgroundColor:
                              item.category?.colorHex ?? '#64748B',
                          },
                        ]}
                      >
                        <Text style={styles.categoryIconText}>
                          {item.category?.name?.slice(0, 1) ?? '•'}
                        </Text>
                      </View>
                      <View style={styles.occurrenceMeta}>
                        <Text style={styles.occurrenceDescription} numberOfLines={1}>
                          {item.transaction.description}
                        </Text>
                        <Text style={styles.occurrenceSub}>
                          {item.transaction.transactionDate} •{' '}
                          {item.creditCard
                            ? `💳 ${item.creditCard.name}`
                            : item.account
                            ? `🏦 ${item.account.name}`
                            : ''}
                          {item.ownerMember ? ` (${item.ownerMember.displayName})` : ' (Casa)'}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.occurrenceRight}>
                      <Text
                        style={[
                          styles.occurrenceAmount,
                          isIncome ? styles.incomeText : styles.expenseText,
                        ]}
                      >
                        {formatCentsToBrl(item.transaction.amountCents)}
                      </Text>
                      {isPending ? (
                        <Pressable
                          style={styles.confirmButton}
                          onPress={() => handleConfirmOccurrence(item.transaction.id)}
                          accessibilityRole="button"
                          accessibilityLabel="Confirmar lançamento"
                        >
                          <Text style={styles.confirmButtonText}>Confirmar</Text>
                        </Pressable>
                      ) : (
                        <View style={styles.clearedPill}>
                          <Text style={styles.clearedPillText}>✓ Pago</Text>
                        </View>
                      )}
                    </View>
                  </View>
                );
              }}
            />
          </View>
        </View>
      ) : (
        /* Tab 2: Regras Fixas */
        <View style={styles.tabContent}>
          <View style={styles.actionBar}>
            <Pressable
              style={styles.newRuleButton}
              onPress={handleOpenNewModal}
              accessibilityRole="button"
              accessibilityLabel="Criar Nova Regra"
            >
              <Text style={styles.newRuleButtonText}>+ Nova Regra Recorrente</Text>
            </Pressable>
          </View>

          <View style={styles.listContainer}>
            <FlashList
              data={rulesWithDetails}
              keyExtractor={(item) => item.rule.id}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>Nenhuma regra fixa cadastrada.</Text>
                  <Text style={styles.emptySubtext}>
                    Cadastre salários, aluguéis, assinaturas e contas fixas do casal.
                  </Text>
                </View>
              }
              renderItem={({ item }) => {
                const isIncome = item.rule.type === 'INCOME';
                return (
                  <View style={styles.ruleCard}>
                    <View style={styles.ruleHeader}>
                      <View style={styles.ruleLeft}>
                        <View
                          style={[
                            styles.categoryIconCircle,
                            {
                              backgroundColor:
                                item.category?.colorHex ?? '#64748B',
                            },
                          ]}
                        >
                          <Text style={styles.categoryIconText}>
                            {item.category?.name?.slice(0, 1) ?? '•'}
                          </Text>
                        </View>
                        <View style={styles.ruleMeta}>
                          <Text style={styles.ruleDescription} numberOfLines={1}>
                            {item.rule.description}
                          </Text>
                          <Text style={styles.ruleSub}>
                            Dia {item.rule.dayOfMonth} •{' '}
                            {item.rule.frequency === 'MONTHLY' ? 'Mensal' : 'Anual'} •{' '}
                            {item.creditCard
                              ? `💳 ${item.creditCard.name}`
                              : item.account
                              ? `🏦 ${item.account.name}`
                              : ''}
                            {item.ownerMember ? ` (${item.ownerMember.displayName})` : ' (Casa)'}
                          </Text>
                        </View>
                      </View>
                      <Text
                        style={[
                          styles.ruleAmount,
                          isIncome ? styles.incomeText : styles.expenseText,
                        ]}
                      >
                        {formatCentsToBrl(item.rule.amountCents)}
                      </Text>
                    </View>
                    <View style={styles.ruleActions}>
                      <Pressable
                        style={styles.ruleActionEdit}
                        onPress={() => handleOpenEditModal(item)}
                      >
                        <Text style={styles.ruleActionEditText}>Editar</Text>
                      </Pressable>
                      <Pressable
                        style={styles.ruleActionDelete}
                        onPress={() => handleSoftDeleteRule(item.rule.id)}
                      >
                        <Text style={styles.ruleActionDeleteText}>Desativar</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              }}
            />
          </View>
        </View>
      )}

      <BottomSheetModal
        visible={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        testID="recurring-rule-modal"
        title={
          editingRuleId ? 'Editar Regra Recorrente' : 'Nova Regra Recorrente'
        }
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
        >
              {/* Type Switcher */}
              <Text style={styles.inputLabel}>Tipo de Transação</Text>
              <View style={styles.modalTypeRow}>
                <Pressable
                  style={[
                    styles.modalTypePill,
                    formType === 'EXPENSE' && styles.modalTypePillActive,
                  ]}
                  onPress={() => setFormType('EXPENSE')}
                >
                  <Text
                    style={[
                      styles.modalTypePillText,
                      formType === 'EXPENSE' && styles.modalTypePillTextActive,
                    ]}
                  >
                    Despesa Conta
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.modalTypePill,
                    formType === 'INCOME' && styles.modalTypePillActive,
                  ]}
                  onPress={() => setFormType('INCOME')}
                >
                  <Text
                    style={[
                      styles.modalTypePillText,
                      formType === 'INCOME' && styles.modalTypePillTextActive,
                    ]}
                  >
                    Receita
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.modalTypePill,
                    formType === 'CREDIT_PURCHASE' && styles.modalTypePillActive,
                  ]}
                  onPress={() => setFormType('CREDIT_PURCHASE')}
                >
                  <Text
                    style={[
                      styles.modalTypePillText,
                      formType === 'CREDIT_PURCHASE' && styles.modalTypePillTextActive,
                    ]}
                  >
                    Cartão de Crédito
                  </Text>
                </Pressable>
              </View>

              {/* Description */}
              <Text style={styles.inputLabel}>Descrição</Text>
              <TextInput
                style={styles.textInput}
                value={formDescription}
                onChangeText={setFormDescription}
                placeholder="Ex: Aluguel, Salário, Internet"
                placeholderTextColor="#64748B"
              />

              {/* Amount */}
              <Text style={styles.inputLabel}>Valor (R$)</Text>
              <CurrencyInput
                style={styles.textInput}
                valueCents={formAmountCents}
                onChangeCents={setFormAmountCents}
                placeholder="R$ 0,00"
              />

              {/* Day of Month & Frequency */}
              <View style={styles.rowInputs}>
                <View style={styles.colInput}>
                  <Text style={styles.inputLabel}>Dia do Vencimento (1..31)</Text>
                  <TextInput
                    style={styles.textInput}
                    value={formDayOfMonth}
                    onChangeText={setFormDayOfMonth}
                    placeholder="10"
                    placeholderTextColor="#64748B"
                    keyboardType="number-pad"
                  />
                </View>
                <View style={styles.colInput}>
                  <Text style={styles.inputLabel}>Frequência</Text>
                  <View style={styles.freqToggleRow}>
                    <Pressable
                      style={[
                        styles.freqButton,
                        formFrequency === 'MONTHLY' && styles.freqButtonActive,
                      ]}
                      onPress={() => setFormFrequency('MONTHLY')}
                    >
                      <Text
                        style={[
                          styles.freqButtonText,
                          formFrequency === 'MONTHLY' && styles.freqButtonTextActive,
                        ]}
                      >
                        Mensal
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[
                        styles.freqButton,
                        formFrequency === 'YEARLY' && styles.freqButtonActive,
                      ]}
                      onPress={() => setFormFrequency('YEARLY')}
                    >
                      <Text
                        style={[
                          styles.freqButtonText,
                          formFrequency === 'YEARLY' && styles.freqButtonTextActive,
                        ]}
                      >
                        Anual
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>

              {/* Start & End Month (Linhas dedicadas com calendário de mês) */}
              <DatePickerInput
                testID="recurring-start-month-input"
                label="Mês de Início da Regra"
                mode="month"
                value={formStartMonth}
                onChange={setFormStartMonth}
              />

              <DatePickerInput
                testID="recurring-end-month-input"
                label="Mês de Término (Opcional)"
                mode="month"
                allowClear
                placeholder="Indeterminado (Sem data de término)"
                value={formEndMonth}
                onChange={setFormEndMonth}
              />

              {/* Category Picker */}
              <Text style={styles.inputLabel}>Categoria</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerScroll}>
                {categoryRows?.map((c) => (
                  <Pressable
                    key={c.id}
                    style={[
                      styles.choicePill,
                      formCategoryId === c.id && styles.choicePillActive,
                    ]}
                    onPress={() => setFormCategoryId(c.id)}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        formCategoryId === c.id && styles.choicePillTextActive,
                      ]}
                    >
                      {c.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>

              {/* Account / Card Picker */}
              {formType === 'CREDIT_PURCHASE' ? (
                <>
                  <Text style={styles.inputLabel}>Cartão de Crédito</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerScroll}>
                    {cardRows?.map((card) => (
                      <Pressable
                        key={card.id}
                        style={[
                          styles.choicePill,
                          formCardId === card.id && styles.choicePillActive,
                        ]}
                        onPress={() => setFormCardId(card.id)}
                      >
                        <Text
                          style={[
                            styles.choicePillText,
                            formCardId === card.id && styles.choicePillTextActive,
                          ]}
                        >
                          💳 {card.name}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </>
              ) : (
                <>
                  <Text style={styles.inputLabel}>Conta de Pagamento / Depósito</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerScroll}>
                    {accountRows?.map((acc) => (
                      <Pressable
                        key={acc.id}
                        style={[
                          styles.choicePill,
                          formAccountId === acc.id && styles.choicePillActive,
                        ]}
                        onPress={() => setFormAccountId(acc.id)}
                      >
                        <Text
                          style={[
                            styles.choicePillText,
                            formAccountId === acc.id && styles.choicePillTextActive,
                          ]}
                        >
                          🏦 {acc.name}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </>
              )}

              {/* Owner Picker */}
              <Text style={styles.inputLabel}>Responsável / Titularidade</Text>
              <View style={styles.ownerPickerRow}>
                <Pressable
                  style={[
                    styles.choicePill,
                    formOwnerUserId === null && styles.choicePillActive,
                  ]}
                  onPress={() => setFormOwnerUserId(null)}
                >
                  <Text
                    style={[
                      styles.choicePillText,
                      formOwnerUserId === null && styles.choicePillTextActive,
                    ]}
                  >
                    Casa (Conjunta)
                  </Text>
                </Pressable>
                {effectiveMembers.map((member) => {
                  const isMe = member.userId === sessionUserId;
                  return (
                    <Pressable
                      key={member.id}
                      style={[
                        styles.choicePill,
                        formOwnerUserId === member.userId && styles.choicePillActive,
                      ]}
                      onPress={() => setFormOwnerUserId(member.userId)}
                    >
                      <Text
                        style={[
                          styles.choicePillText,
                          formOwnerUserId === member.userId && styles.choicePillTextActive,
                        ]}
                      >
                        Pessoal ({member.displayName}{isMe ? ' - Você' : ''})
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Buttons */}
              <View style={styles.modalButtonRow}>
                <Pressable
                  style={styles.modalCancelButton}
                  onPress={() => setIsModalOpen(false)}
                >
                  <Text style={styles.modalCancelButtonText}>Cancelar</Text>
                </Pressable>
                <Pressable style={styles.modalSaveButton} onPress={handleSaveRule}>
                  <Text style={styles.modalSaveButtonText}>Salvar</Text>
                </Pressable>
              </View>
        </ScrollView>
      </BottomSheetModal>
    </View>
  );
}
