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
import type { OwnershipFilter } from '@/core';
import {
  InstallmentEditor,
  type InstallmentEditorMode,
} from '@/components/InstallmentEditor';
import { SessionGateBanner } from '@/components/SessionGateBanner';
import {
  accounts,
  type AppDatabase,
  categories,
  computeCreditCardsWithLimits,
  computeInstallmentPlansWithSlices,
  createCreditCard,
  creditCardInvoices,
  type CreditCardRow,
  creditCards,
  generateUuidV4,
  householdMembers,
  type InstallmentPlanWithSlices,
  installmentPlans,
  softDeleteCreditCard,
  transactions,
  updateCreditCard,
  useActiveDatabase,
  useReactiveQuery,
} from '@/data';
import { syncHouseholdMembers } from '@/sync/membershipSync';
import {
  formatCentsToBrl,
  useFiltersStore,
  useSessionUIStore,
} from '@/store';
import { styles } from './cards.styles';

export interface CardsScreenProps {
  db?: AppDatabase | null;
  householdId?: string | null;
  currentUserId?: string | null;
}

export default function CardsScreen({
  db: propDb,
  householdId: propHouseholdId,
  currentUserId: propCurrentUserId,
}: CardsScreenProps = {}) {
  const sessionHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const sessionUserId = useSessionUIStore((s) => s.userId);
  const sessionUserEmail = useSessionUIStore((s) => s.userEmail);
  const ownershipFilter = useFiltersStore((s) => s.ownershipFilter);
  const setOwnershipFilter = useFiltersStore((s) => s.setOwnershipFilter);

  const db = useActiveDatabase(propDb);
  const householdId = propHouseholdId ?? sessionHouseholdId;
  const currentUserId = propCurrentUserId ?? sessionUserId;

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
              ),
            )
        : null,
    [db, householdId],
    ['credit_cards'],
  );

  const { data: invoiceRows } = useReactiveQuery(
    () =>
      db && householdId
        ? db
            .select()
            .from(creditCardInvoices)
            .where(
              and(
                eq(creditCardInvoices.householdId, householdId),
                isNull(creditCardInvoices.deletedAt),
              ),
            )
        : null,
    [db, householdId],
    ['credit_card_invoices'],
  );

  const { data: txRows } = useReactiveQuery(
    () =>
      db && householdId
        ? db
            .select()
            .from(transactions)
            .where(
              and(
                eq(transactions.householdId, householdId),
                isNull(transactions.deletedAt),
              ),
            )
        : null,
    [db, householdId],
    ['transactions'],
  );

  const { data: planRows } = useReactiveQuery(
    () =>
      db && householdId
        ? db
            .select()
            .from(installmentPlans)
            .where(
              and(
                eq(installmentPlans.householdId, householdId),
                isNull(installmentPlans.deletedAt),
              ),
            )
        : null,
    [db, householdId],
    ['installment_plans'],
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

  useEffect(() => {
    if (db && householdId) {
      void syncHouseholdMembers(db, householdId);
    }
  }, [db, householdId]);

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

  const cardsWithLimits = useMemo(
    () =>
      computeCreditCardsWithLimits(
        cardRows,
        invoiceRows,
        txRows,
        ownershipFilter,
      ),
    [cardRows, invoiceRows, txRows, ownershipFilter],
  );

  const plansWithSlices = useMemo(
    () =>
      computeInstallmentPlansWithSlices(
        planRows,
        txRows,
        invoiceRows,
        ownershipFilter,
      ),
    [planRows, txRows, invoiceRows, ownershipFilter],
  );

  const totalAvailableLimitCents = useMemo(
    () =>
      cardsWithLimits.reduce((acc, c) => acc + c.availableLimitCents, 0),
    [cardsWithLimits],
  );

  const totalUsedLimitCents = useMemo(
    () => cardsWithLimits.reduce((acc, c) => acc + c.usedLimitCents, 0),
    [cardsWithLimits],
  );

  const activeAccounts = useMemo(
    () => accountRows.filter((a) => !a.isArchived),
    [accountRows],
  );

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCardRow | null>(null);
  const [name, setName] = useState('');
  const [limitCents, setLimitCents] = useState(500000);
  const [closingDayInput, setClosingDayInput] = useState('10');
  const [dueDayInput, setDueDayInput] = useState('17');
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [defaultPaymentAccountId, setDefaultPaymentAccountId] = useState<
    string | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [editorVisible, setEditorVisible] = useState(false);
  const [editorMode, setEditorMode] =
    useState<InstallmentEditorMode>('CREATE_INSTALLMENT');
  const [editorCardId, setEditorCardId] = useState<string | null>(null);
  const [editorTargetPlan, setEditorTargetPlan] =
    useState<InstallmentPlanWithSlices | null>(null);

  const effectiveDefaultAccountId = useMemo(() => {
    if (
      defaultPaymentAccountId &&
      activeAccounts.some((a) => a.id === defaultPaymentAccountId)
    ) {
      return defaultPaymentAccountId;
    }
    return activeAccounts[0]?.id ?? null;
  }, [defaultPaymentAccountId, activeAccounts]);

  const resetForm = () => {
    setEditingCard(null);
    setName('');
    setLimitCents(500000);
    setClosingDayInput('10');
    setDueDayInput('17');
    setOwnerUserId(null);
    setDefaultPaymentAccountId(null);
    setErrorMessage(null);
  };

  const closeForm = () => {
    resetForm();
    setIsFormOpen(false);
  };

  const openCreateForm = () => {
    resetForm();
    setIsFormOpen(true);
  };

  const handleEditSelect = (card: CreditCardRow) => {
    setEditingCard(card);
    setName(card.name);
    setLimitCents(card.limitCents);
    setClosingDayInput(String(card.closingDay));
    setDueDayInput(String(card.dueDay));
    setOwnerUserId(card.ownerUserId);
    setDefaultPaymentAccountId(card.defaultPaymentAccountId);
    setErrorMessage(null);
    setIsFormOpen(true);
  };

  const handleSaveCard = () => {
    setErrorMessage(null);
    if (!db || !householdId) {
      setErrorMessage('Banco local ou lar ativo não disponível.');
      return;
    }

    if (!name.trim()) {
      setErrorMessage('Informe o nome do cartão.');
      return;
    }

    if (!effectiveDefaultAccountId) {
      setErrorMessage(
        'Cadastre ao menos uma conta bancária antes de criar um cartão.',
      );
      return;
    }

    const closingDay = Number(closingDayInput.trim());
    const dueDay = Number(dueDayInput.trim());
    if (
      !Number.isInteger(closingDay) ||
      closingDay < 1 ||
      closingDay > 31 ||
      !Number.isInteger(dueDay) ||
      dueDay < 1 ||
      dueDay > 31
    ) {
      setErrorMessage('Dia de fechamento e vencimento devem estar entre 1 e 31.');
      return;
    }

    try {
      if (editingCard) {
        updateCreditCard(db, editingCard.id, {
          name: name.trim(),
          limitCents,
          closingDay,
          dueDay,
          ownerUserId,
          defaultPaymentAccountId: effectiveDefaultAccountId,
        });
      } else {
        createCreditCard(db, {
          id: generateUuidV4(),
          householdId,
          ownerUserId,
          defaultPaymentAccountId: effectiveDefaultAccountId,
          name: name.trim(),
          limitCents,
          closingDay,
          dueDay,
          isArchived: false,
        });
      }
      closeForm();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao salvar cartão.',
      );
    }
  };

  const handleSoftDelete = (cardId: string) => {
    if (!db) return;
    try {
      softDeleteCreditCard(db, cardId);
      if (editingCard?.id === cardId) {
        closeForm();
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao excluir cartão.',
      );
    }
  };

  const openEditorForCard = (
    cardId: string | null,
    mode: InstallmentEditorMode,
  ) => {
    setEditorCardId(cardId);
    setEditorMode(mode);
    setEditorTargetPlan(null);
    setEditorVisible(true);
  };

  const openEditorForPlan = (plan: InstallmentPlanWithSlices) => {
    setEditorTargetPlan(plan);
    setEditorMode('EDIT_INSTALLMENT');
    setEditorCardId(plan.plan.creditCardId);
    setEditorVisible(true);
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
    <View style={styles.container} testID="cards-screen">
      <SessionGateBanner />

      {/* Resumo de Limites & Filtro de Titularidade */}
      <View style={styles.summaryCard}>
        <View style={styles.summaryMetricsRow}>
          <View>
            <Text style={styles.summaryLabel}>Limite Disponível</Text>
            <Text
              style={styles.summaryValue}
              testID="cards-total-available-limit"
            >
              {formatCentsToBrl(totalAvailableLimitCents)}
            </Text>
          </View>
          <View style={styles.summaryRightBox}>
            <Text style={styles.summaryLabel}>Comprometido em Faturas</Text>
            <Text style={styles.usedLimitValue} testID="cards-total-used-limit">
              {formatCentsToBrl(totalUsedLimitCents)}
            </Text>
          </View>
        </View>

        <View style={styles.filterRow}>
          {renderFilterChip(
            'Consolidado',
            { mode: 'CONSOLIDATED' },
            'cards-filter-CONSOLIDATED',
          )}
          {renderFilterChip(
            'Casa (Compartilhado)',
            { mode: 'DOMESTIC' },
            'cards-filter-DOMESTIC',
          )}
          {effectiveMembers.map((m) =>
            renderFilterChip(
              m.displayName,
              { mode: 'USER', userId: m.userId },
              `cards-filter-USER-${m.userId}`,
            ),
          )}
        </View>

        <View style={styles.quickActionRow}>
          <Pressable
            testID="open-card-purchase-button"
            style={styles.quickBtn}
            onPress={() => openEditorForCard(null, 'CREATE_PURCHASE')}
          >
            <Text style={styles.quickBtnText}>+ Compra à Vista</Text>
          </Pressable>
          <Pressable
            testID="open-card-installment-button"
            style={styles.quickBtn}
            onPress={() => openEditorForCard(null, 'CREATE_INSTALLMENT')}
          >
            <Text style={styles.quickBtnText}>+ Parcelar Compra</Text>
          </Pressable>
          <Pressable
            testID="open-card-refund-button"
            style={styles.quickBtnSecondary}
            onPress={() => openEditorForCard(null, 'CREATE_REFUND')}
          >
            <Text style={styles.quickBtnSecondaryText}>+ Estorno</Text>
          </Pressable>
          <Pressable
            testID="open-create-card-button"
            style={styles.quickBtn}
            onPress={openCreateForm}
          >
            <Text style={styles.quickBtnText}>+ Novo Cartão</Text>
          </Pressable>
        </View>
      </View>

      <BottomSheetModal
        visible={isFormOpen}
        onClose={closeForm}
        testID="card-form-sheet"
        closeTestID="cancel-edit-card-button"
        title={editingCard ? 'Editar Cartão' : 'Novo Cartão de Crédito'}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {errorMessage ? (
            <View style={styles.errorBanner} testID="cards-error-banner">
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}

          <View style={styles.inputRow}>
            <TextInput
              testID="card-name-input"
              style={[styles.input, { flex: 2 }]}
              value={name}
              onChangeText={setName}
              placeholder="Nome (ex.: Nubank Ultravioleta)"
              placeholderTextColor="#64748B"
            />
            <CurrencyInput
              testID="card-limit-input"
              style={[styles.input, { flex: 1 }]}
              valueCents={limitCents}
              onChangeCents={setLimitCents}
              placeholder="Limite R$"
            />
          </View>

          <View style={styles.inputRow}>
            <TextInput
              testID="card-closing-day-input"
              style={[styles.input, { flex: 1 }]}
              value={closingDayInput}
              onChangeText={setClosingDayInput}
              placeholder="Dia Fech. (1..31)"
              placeholderTextColor="#64748B"
              keyboardType="number-pad"
            />
            <TextInput
              testID="card-due-day-input"
              style={[styles.input, { flex: 1 }]}
              value={dueDayInput}
              onChangeText={setDueDayInput}
              placeholder="Dia Venc. (1..31)"
              placeholderTextColor="#64748B"
              keyboardType="number-pad"
            />
          </View>

          <View style={styles.chipRow}>
            <Pressable
              testID="card-owner-DOMESTIC"
              style={[styles.chip, ownerUserId === null && styles.chipActive]}
              onPress={() => setOwnerUserId(null)}
            >
              <Text
                style={[
                  styles.chipText,
                  ownerUserId === null && styles.chipTextActive,
                ]}
              >
                Casa (Conjunta)
              </Text>
            </Pressable>
            {effectiveMembers.map((m) => {
              const active = ownerUserId === m.userId;
              const isMe = m.userId === sessionUserId;
              return (
                <Pressable
                  key={m.id}
                  testID={`card-owner-${m.userId}`}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setOwnerUserId(m.userId)}
                >
                  <Text
                    style={[styles.chipText, active && styles.chipTextActive]}
                  >
                    Pessoal ({m.displayName}
                    {isMe ? ' - Você' : ''})
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.chipRow}>
            {activeAccounts.map((acc) => {
              const active = effectiveDefaultAccountId === acc.id;
              return (
                <Pressable
                  key={acc.id}
                  testID={`card-default-account-${acc.id}`}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setDefaultPaymentAccountId(acc.id)}
                >
                  <Text
                    style={[styles.chipText, active && styles.chipTextActive]}
                  >
                    Débito Padrão: {acc.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            testID="save-card-button"
            style={styles.primaryButton}
            onPress={handleSaveCard}
          >
            <Text style={styles.primaryButtonText}>
              {editingCard ? 'Atualizar Cartão' : 'Adicionar Cartão'}
            </Text>
          </Pressable>
        </ScrollView>
      </BottomSheetModal>

      {/* Lista Reativa de Cartões e Parcelamentos Ativos */}
      <View style={styles.listWrapper}>
        <FlashList
          data={cardsWithLimits}
          keyExtractor={(item) => item.card.id}
          renderItem={({ item }) => {
            const memberName =
              item.card.ownerUserId === null
                ? 'Compartilhado / Casa'
                : (memberRows.find((m) => m.userId === item.card.ownerUserId)
                    ?.displayName ?? 'Individual');

            const cardPlans = plansWithSlices.filter(
              (p) => p.plan.creditCardId === item.card.id,
            );

            return (
              <View
                style={styles.cardItem}
                testID={`credit-card-row-${item.card.id}`}
              >
                <View style={styles.cardTopRow}>
                  <View style={styles.cardInfo}>
                    <Text style={styles.cardName}>{item.card.name}</Text>
                    <Text style={styles.cardMeta}>
                      Fecha dia {item.card.closingDay} • Vence dia{' '}
                      {item.card.dueDay} • {memberName}
                    </Text>
                  </View>
                  <View style={styles.cardRight}>
                    <Text
                      style={styles.availableText}
                      testID={`card-available-limit-${item.card.id}`}
                    >
                      Disp: {formatCentsToBrl(item.availableLimitCents)}
                    </Text>
                    <Text
                      style={styles.usedText}
                      testID={`card-used-limit-${item.card.id}`}
                    >
                      Usado: {formatCentsToBrl(item.usedLimitCents)} /{' '}
                      {formatCentsToBrl(item.card.limitCents)}
                    </Text>
                  </View>
                </View>

                {cardPlans.length > 0 ? (
                  <View style={styles.plansSection}>
                    <Text style={styles.plansSectionTitle}>
                      Parcelamentos Ativos ({cardPlans.length}):
                    </Text>
                    {cardPlans.map((planItem) => (
                      <Pressable
                        key={planItem.plan.id}
                        testID={`edit-installment-plan-${planItem.plan.id}`}
                        style={styles.planChip}
                        onPress={() => openEditorForPlan(planItem)}
                      >
                        <Text style={styles.planChipText}>
                          {planItem.plan.description} (
                          {planItem.plan.totalInstallments}x •{' '}
                          {formatCentsToBrl(planItem.plan.totalAmountCents)}) —
                          Editar Escopo A/B
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}

                <View style={styles.rowActions}>
                  <Pressable
                    testID={`edit-card-${item.card.id}`}
                    onPress={() => handleEditSelect(item.card)}
                    style={styles.rowBtn}
                  >
                    <Text style={styles.editBtnText}>Editar Cartão</Text>
                  </Pressable>
                  <Pressable
                    testID={`delete-card-${item.card.id}`}
                    onPress={() => handleSoftDelete(item.card.id)}
                    style={styles.rowBtn}
                  >
                    <Text style={styles.deleteBtnText}>Excluir</Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.emptyText} testID="cards-empty-state">
              Nenhum cartão de crédito ativo para o filtro selecionado.
            </Text>
          }
        />
      </View>

      <InstallmentEditor
        visible={editorVisible}
        onClose={() => setEditorVisible(false)}
        initialMode={editorMode}
        initialCardId={editorCardId}
        targetPlan={editorTargetPlan}
        db={db}
        householdId={householdId}
        currentUserId={currentUserId}
        cards={cardRows}
        categories={categoryRows}
        members={effectiveMembers}
      />
    </View>
  );
}
