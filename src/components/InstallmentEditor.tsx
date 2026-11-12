import React, { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CurrencyInput } from './CurrencyInput';
import { DatePickerInput } from './DatePickerInput';
import { parseFriendlyDateToIso } from './TransactionQuickModal';
import {
  resolveInvoiceCompetenceMonth,
  splitInstallments,
} from '@/core';
import {
  type AppDatabase,
  type CategoryRow,
  createCreditCardPurchase,
  createCreditCardRefund,
  createInstallmentPurchase,
  type CreditCardRow,
  editInstallmentScopeA,
  editInstallmentScopeB,
  flattenCategoryTree,
  generateUuidV4,
  getActiveDatabase,
  type HouseholdMemberRow,
  type InstallmentPlanWithSlices,
  softDeleteInstallmentPlan,
  type TransactionRow,
} from '@/data';
import {
  formatCentsToBrl,
  parseCurrencyInputToCents,
  useFiltersStore,
  useSessionUIStore,
} from '@/store';

export type InstallmentEditorMode =
  | 'CREATE_PURCHASE'
  | 'CREATE_INSTALLMENT'
  | 'CREATE_REFUND'
  | 'EDIT_INSTALLMENT';

export type InstallmentEditScope = 'SCOPE_A' | 'SCOPE_B';

export interface InstallmentEditorProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  initialMode?: InstallmentEditorMode;
  initialCardId?: string | null;
  targetPlan?: InstallmentPlanWithSlices | null;
  targetSliceTransaction?: TransactionRow | null;
  db?: AppDatabase | null;
  householdId?: string | null;
  currentUserId?: string | null;
  cards: readonly CreditCardRow[];
  categories: readonly CategoryRow[];
  members: readonly HouseholdMemberRow[];
  defaultDateIso?: string;
}

export function InstallmentEditor({
  visible,
  onClose,
  onSuccess,
  initialMode = 'CREATE_INSTALLMENT',
  initialCardId = null,
  targetPlan = null,
  targetSliceTransaction = null,
  db: propDb,
  householdId: propHouseholdId,
  currentUserId: propCurrentUserId,
  cards,
  categories,
  members,
  defaultDateIso,
}: InstallmentEditorProps) {
  const competenceMonth = useFiltersStore((s) => s.competenceMonth);
  const sessionHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const sessionUserId = useSessionUIStore((s) => s.userId);
  const sessionUserEmail = useSessionUIStore((s) => s.userEmail);

  const effectiveHouseholdId = propHouseholdId ?? sessionHouseholdId;
  const effectiveUserId =
    propCurrentUserId ?? sessionUserId ?? members[0]?.userId ?? null;

  const effectiveMembers = useMemo(() => {
    if (members && members.length > 0) {
      return members;
    }
    if (effectiveUserId) {
      return [
        {
          id: 'me',
          householdId: effectiveHouseholdId ?? '',
          userId: effectiveUserId,
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
  }, [members, effectiveUserId, effectiveHouseholdId, sessionUserEmail]);

  const [mode, setMode] = useState<InstallmentEditorMode>(initialMode);
  const [editScope, setEditScope] = useState<InstallmentEditScope>('SCOPE_B');
  const [selectedSliceNumber, setSelectedSliceNumber] = useState<number>(
    targetSliceTransaction?.installmentNumber ?? 1,
  );

  const [creditCardId, setCreditCardId] = useState<string | null>(
    initialCardId,
  );
  const [categoryId, setCategoryId] = useState<string | null>(
    targetSliceTransaction?.categoryId ?? targetPlan?.plan.categoryId ?? null,
  );
  const [ownerUserId, setOwnerUserId] = useState<string | null>(
    targetSliceTransaction
      ? targetSliceTransaction.ownerUserId
      : targetPlan
        ? targetPlan.plan.ownerUserId
        : null,
  );
  const [amountCents, setAmountCents] = useState(0);
  const [installmentsInput, setInstallmentsInput] = useState('3');
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const yesterdayIso = useMemo(
    () => new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    [],
  );
  const [purchaseDate, setPurchaseDate] = useState(
    defaultDateIso ??
      (todayIso.startsWith(competenceMonth)
        ? todayIso
        : `${competenceMonth}-01`),
  );
  const [description, setDescription] = useState(
    targetPlan?.plan.description ?? '',
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setMode(initialMode);
      if (initialCardId) {
        setCreditCardId(initialCardId);
      }
      if (initialMode === 'CREATE_PURCHASE') {
        setInstallmentsInput('1');
      } else if (initialMode === 'CREATE_INSTALLMENT') {
        setInstallmentsInput('3');
      }
      setAmountCents(0);
      setErrorMessage(null);
      const currentToday = new Date().toISOString().slice(0, 10);
      setPurchaseDate(
        defaultDateIso ??
          (currentToday.startsWith(competenceMonth)
            ? currentToday
            : `${competenceMonth}-01`),
      );
    }
  }, [visible, initialMode, initialCardId, competenceMonth, defaultDateIso]);

  const activeMode: InstallmentEditorMode = targetPlan
    ? 'EDIT_INSTALLMENT'
    : mode;

  const activeCards = useMemo(
    () => cards.filter((c) => c.deletedAt === null && !c.isArchived),
    [cards],
  );

  const expenseCategories = useMemo(
    () => flattenCategoryTree(categories, 'EXPENSE'),
    [categories],
  );

  const effectiveCardId = useMemo(() => {
    if (creditCardId && activeCards.some((c) => c.id === creditCardId)) {
      return creditCardId;
    }
    if (
      initialCardId &&
      activeCards.some((c) => c.id === initialCardId)
    ) {
      return initialCardId;
    }
    return activeCards[0]?.id ?? null;
  }, [creditCardId, initialCardId, activeCards]);

  const effectiveCategoryId = useMemo(() => {
    if (
      categoryId &&
      expenseCategories.some((c) => c.row.id === categoryId)
    ) {
      return categoryId;
    }
    return expenseCategories[0]?.row.id ?? null;
  }, [categoryId, expenseCategories]);

  const selectedCard = useMemo(
    () => activeCards.find((c) => c.id === effectiveCardId) ?? null,
    [activeCards, effectiveCardId],
  );

  // Live preview of installment splitting (1st slice gets total % N)
  const installmentPreview = useMemo(() => {
    if (activeMode !== 'CREATE_INSTALLMENT' || !selectedCard) {
      return null;
    }
    try {
      const totalCents = amountCents;
      const count = Number(installmentsInput.trim());
      if (totalCents <= 0 || !Number.isInteger(count) || count < 2 || count > 240) {
        return null;
      }
      const firstMonth = resolveInvoiceCompetenceMonth(
        purchaseDate.trim(),
        selectedCard.closingDay,
      );
      return splitInstallments(totalCents, count, firstMonth);
    } catch {
      return null;
    }
  }, [activeMode, selectedCard, amountCents, installmentsInput, purchaseDate]);

  const targetSliceItem = useMemo(() => {
    if (!targetPlan) return null;
    if (targetSliceTransaction) {
      return (
        targetPlan.slices.find(
          (s) => s.transaction.id === targetSliceTransaction.id,
        ) ?? targetPlan.slices[0] ?? null
      );
    }
    return (
      targetPlan.slices.find(
        (s) => s.transaction.installmentNumber === selectedSliceNumber,
      ) ??
      targetPlan.slices[0] ??
      null
    );
  }, [targetPlan, targetSliceTransaction, selectedSliceNumber]);

  const handleClose = () => {
    setErrorMessage(null);
    onClose();
  };

  const handleSubmit = () => {
    setErrorMessage(null);
    const targetDb = propDb ?? getActiveDatabase();
    if (!targetDb) {
      setErrorMessage('Banco de dados local não inicializado.');
      return;
    }
    if (!effectiveHouseholdId || !effectiveUserId) {
      setErrorMessage('Sessão do casal não identificada.');
      return;
    }

    if (amountCents <= 0) {
      setErrorMessage('O valor deve ser maior que R$ 0,00.');
      return;
    }

    try {
      if (activeMode === 'EDIT_INSTALLMENT' && targetPlan) {
        if (!targetSliceItem) {
          setErrorMessage('Selecione uma parcela válida para edição.');
          return;
        }

        if (editScope === 'SCOPE_A') {
          editInstallmentScopeA(targetDb, {
            transactionId: targetSliceItem.transaction.id,
            changes: {
              amountCents,
              categoryId: effectiveCategoryId ?? undefined,
              description: description.trim() || undefined,
              ownerUserId,
            },
          });
        } else {
          editInstallmentScopeB(targetDb, {
            installmentPlanId: targetPlan.plan.id,
            fromInstallmentNumber:
              targetSliceItem.transaction.installmentNumber ?? 1,
            changes: {
              amountCents,
              categoryId: effectiveCategoryId ?? undefined,
              description: description.trim() || undefined,
              ownerUserId,
            },
          });
        }

        onSuccess?.();
        handleClose();
        return;
      }

      if (!effectiveCardId) {
        setErrorMessage('Selecione um cartão de crédito ativo.');
        return;
      }
      if (!effectiveCategoryId) {
        setErrorMessage('Selecione uma categoria de despesa.');
        return;
      }
      if (!description.trim()) {
        setErrorMessage('Informe a descrição da compra.');
        return;
      }

      const finalPurchaseDate = parseFriendlyDateToIso(
        purchaseDate,
        competenceMonth,
      );

      if (activeMode === 'CREATE_PURCHASE') {
        createCreditCardPurchase(targetDb, {
          householdId: effectiveHouseholdId,
          createdByUserId: effectiveUserId,
          ownerUserId,
          creditCardId: effectiveCardId,
          categoryId: effectiveCategoryId,
          amountCents,
          transactionDate: finalPurchaseDate,
          description: description.trim(),
        });
      } else if (activeMode === 'CREATE_REFUND') {
        createCreditCardRefund(targetDb, {
          householdId: effectiveHouseholdId,
          createdByUserId: effectiveUserId,
          ownerUserId,
          creditCardId: effectiveCardId,
          categoryId: effectiveCategoryId,
          amountCents,
          transactionDate: finalPurchaseDate,
          description: description.trim(),
        });
      } else {
        const totalInstallments = Number(installmentsInput.trim());
        if (
          !Number.isInteger(totalInstallments) ||
          totalInstallments < 2 ||
          totalInstallments > 240
        ) {
          setErrorMessage('O número de parcelas deve ser entre 2 e 240.');
          return;
        }

        createInstallmentPurchase(targetDb, {
          plan: {
            id: generateUuidV4(),
            householdId: effectiveHouseholdId,
            createdByUserId: effectiveUserId,
            ownerUserId,
            creditCardId: effectiveCardId,
            accountId: null,
            categoryId: effectiveCategoryId,
            description: description.trim(),
            totalAmountCents: amountCents,
            totalInstallments,
            purchaseDate: finalPurchaseDate,
          },
        });
      }

      setAmountCents(0);
      setDescription('');
      onSuccess?.();
      handleClose();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Erro ao registrar operação no cartão.',
      );
    }
  };

  const handleCancelWholePlan = () => {
    if (!targetPlan) return;
    setErrorMessage(null);
    const targetDb = propDb ?? getActiveDatabase();
    if (!targetDb) return;

    try {
      softDeleteInstallmentPlan(targetDb, targetPlan.plan.id);
      onSuccess?.();
      handleClose();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Não foi possível cancelar o parcelamento.',
      );
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <View style={styles.backdrop} testID="installment-editor-modal">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboardContainer}
        >
          <View style={styles.sheet}>
            <View style={styles.headerRow}>
              <Text style={styles.title}>
                {activeMode === 'EDIT_INSTALLMENT'
                  ? 'Editar Parcelamento (Escopo A / B)'
                  : 'Lançamento no Cartão de Crédito'}
              </Text>
              <Pressable
                testID="installment-editor-close"
                onPress={handleClose}
                style={styles.closeBtn}
              >
                <Text style={styles.closeBtnText}>Fechar</Text>
              </Pressable>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
            {errorMessage ? (
              <View
                style={styles.errorBanner}
                testID="installment-editor-error"
              >
                <Text style={styles.errorText}>{errorMessage}</Text>
              </View>
            ) : null}

            {activeMode !== 'EDIT_INSTALLMENT' ? (
              <>
                <Text style={styles.label}>Modalidade no Cartão</Text>
                <View style={styles.pillRow}>
                  {(
                    [
                      { id: 'CREATE_PURCHASE', label: 'Compra à Vista' },
                      { id: 'CREATE_INSTALLMENT', label: 'Compra Parcelada' },
                      { id: 'CREATE_REFUND', label: 'Estorno (Crédito)' },
                    ] as const
                  ).map((item) => {
                    const active = mode === item.id;
                    return (
                      <Pressable
                        key={item.id}
                        testID={`installment-mode-${item.id}`}
                        style={[styles.pill, active && styles.pillActive]}
                        onPress={() => setMode(item.id)}
                      >
                        <Text
                          style={[
                            styles.pillText,
                            active && styles.pillTextActive,
                          ]}
                        >
                          {item.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={styles.label}>Cartão de Crédito</Text>
                <View style={styles.pillRow}>
                  {activeCards.map((card) => {
                    const active = effectiveCardId === card.id;
                    return (
                      <Pressable
                        key={card.id}
                        testID={`installment-card-${card.id}`}
                        style={[styles.pill, active && styles.pillActive]}
                        onPress={() => setCreditCardId(card.id)}
                      >
                        <Text
                          style={[
                            styles.pillText,
                            active && styles.pillTextActive,
                          ]}
                        >
                          {card.name} (Fecha dia {card.closingDay})
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : (
              /* Modo Edição de Parcelas (Escopo A vs Escopo B) */
              <>
                <View style={styles.planSummaryBox}>
                  <Text style={styles.planSummaryTitle}>
                    {targetPlan?.plan.description}
                  </Text>
                  <Text
                    style={styles.planSummarySub}
                    testID="installment-plan-recalculated-total"
                  >
                    Total Atual do Plano:{' '}
                    {formatCentsToBrl(targetPlan?.plan.totalAmountCents ?? 0)} (
                    {targetPlan?.plan.totalInstallments}x)
                  </Text>
                </View>

                <Text style={styles.label}>Selecionar Parcela de Referência</Text>
                <View style={styles.pillRow}>
                  {targetPlan?.slices.map((s) => {
                    const num = s.transaction.installmentNumber ?? 1;
                    const active =
                      targetSliceItem?.transaction.id === s.transaction.id;
                    return (
                      <Pressable
                        key={s.transaction.id}
                        testID={`select-slice-${num}`}
                        style={[
                          styles.pill,
                          active && styles.pillActive,
                          s.isLocked && styles.pillLocked,
                        ]}
                        onPress={() => setSelectedSliceNumber(num)}
                      >
                        <Text
                          style={[
                            styles.pillText,
                            active && styles.pillTextActive,
                          ]}
                        >
                          {num}/{targetPlan.plan.totalInstallments} (
                          {s.transaction.competenceMonth}){' '}
                          {s.isLocked ? `[${s.invoiceStatus}]` : ''}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={styles.label}>Escopo de Alteração</Text>
                <View style={styles.pillRow}>
                  <Pressable
                    testID="installment-scope-SCOPE_A"
                    style={[
                      styles.pill,
                      editScope === 'SCOPE_A' && styles.pillActive,
                    ]}
                    onPress={() => setEditScope('SCOPE_A')}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        editScope === 'SCOPE_A' && styles.pillTextActive,
                      ]}
                    >
                      Escopo A: Apenas esta parcela
                    </Text>
                  </Pressable>
                  <Pressable
                    testID="installment-scope-SCOPE_B"
                    style={[
                      styles.pill,
                      editScope === 'SCOPE_B' && styles.pillActive,
                    ]}
                    onPress={() => setEditScope('SCOPE_B')}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        editScope === 'SCOPE_B' && styles.pillTextActive,
                      ]}
                    >
                      Escopo B: Esta e as seguintes (faturas abertas)
                    </Text>
                  </Pressable>
                </View>
              </>
            )}

            {/* Valor e Parcelas */}
            <View style={styles.splitRow}>
              <View style={styles.splitCol}>
                <Text style={styles.label}>
                  {activeMode === 'CREATE_INSTALLMENT'
                    ? 'Valor Total da Compra (R$)'
                    : activeMode === 'EDIT_INSTALLMENT'
                      ? 'Novo Valor da Parcela (R$)'
                      : 'Valor (R$)'}
                </Text>
                <CurrencyInput
                  testID="installment-amount-input"
                  style={styles.input}
                  valueCents={amountCents}
                  onChangeCents={setAmountCents}
                  placeholder="R$ 0,00"
                />
              </View>

              {activeMode === 'CREATE_INSTALLMENT' ? (
                <View style={styles.splitCol}>
                  <Text style={styles.label}>Nº de Parcelas (2..240)</Text>
                  <TextInput
                    testID="installment-count-input"
                    style={styles.input}
                    value={installmentsInput}
                    onChangeText={setInstallmentsInput}
                    placeholder="3"
                    placeholderTextColor="#64748B"
                    keyboardType="number-pad"
                  />
                </View>
              ) : null}
            </View>

            {/* Preview de Divisão Exata com Resto na 1ª Parcela (TEST-FIN-01) */}
            {installmentPreview && installmentPreview.length > 0 ? (
              <View
                style={styles.previewBox}
                testID="installment-split-preview"
              >
                <Text style={styles.previewTitle}>
                  Divisão Contábil Exata (Resto na 1ª Parcela):
                </Text>
                <Text style={styles.previewText}>
                  1ª Parcela ({installmentPreview[0].competenceMonth}):{' '}
                  {formatCentsToBrl(installmentPreview[0].amountCents)} • Demais
                  ({installmentPreview.length - 1}x):{' '}
                  {formatCentsToBrl(installmentPreview[1].amountCents)}
                </Text>
              </View>
            ) : null}

            {/* Descrição & Data */}
            <Text style={styles.label}>Descrição</Text>
            <TextInput
              testID="installment-description-input"
              style={styles.input}
              value={description}
              onChangeText={setDescription}
              placeholder="Ex.: Lava-louças Inox"
              placeholderTextColor="#64748B"
            />

            {activeMode !== 'EDIT_INSTALLMENT' ? (
              <DatePickerInput
                testID="installment-date-input"
                label="Data da Compra"
                value={purchaseDate}
                onChange={setPurchaseDate}
              />
            ) : null}

            {/* Titularidade (Casa vs Membro) */}
            <Text style={styles.label}>Titularidade da Despesa</Text>
            <View style={styles.pillRow}>
              <Pressable
                testID="installment-owner-DOMESTIC"
                style={[
                  styles.pill,
                  ownerUserId === null && styles.pillActive,
                ]}
                onPress={() => setOwnerUserId(null)}
              >
                <Text
                  style={[
                    styles.pillText,
                    ownerUserId === null && styles.pillTextActive,
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
                    testID={`installment-owner-${m.userId}`}
                    style={[styles.pill, active && styles.pillActive]}
                    onPress={() => setOwnerUserId(m.userId)}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        active && styles.pillTextActive,
                      ]}
                    >
                      Pessoal ({m.displayName}{isMe ? ' - Você' : ''})
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Categoria de Despesa */}
            <Text style={styles.label}>Categoria</Text>
            <View style={styles.pillRow}>
              {expenseCategories.map((cat) => {
                const active = effectiveCategoryId === cat.row.id;
                return (
                  <Pressable
                    key={cat.row.id}
                    testID={`installment-category-${cat.row.id}`}
                    style={[styles.pill, active && styles.pillActive]}
                    onPress={() => setCategoryId(cat.row.id)}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        active && styles.pillTextActive,
                      ]}
                    >
                      {cat.displayLabel}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              testID="installment-submit-button"
              style={styles.submitButton}
              onPress={handleSubmit}
            >
              <Text style={styles.submitButtonText}>
                {activeMode === 'EDIT_INSTALLMENT'
                  ? 'Salvar Alteração de Parcela(s)'
                  : 'Confirmar Lançamento no Cartão'}
              </Text>
            </Pressable>

            {activeMode === 'EDIT_INSTALLMENT' && targetPlan?.canCancelAll ? (
              <Pressable
                testID="installment-cancel-plan-button"
                style={styles.dangerButton}
                onPress={handleCancelWholePlan}
              >
                <Text style={styles.dangerButtonText}>
                  Cancelar Plano Inteiro (Soft Delete em Lote)
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.82)',
    justifyContent: 'flex-end',
  },
  keyboardContainer: {
    width: '100%',
    maxHeight: '92%',
  },
  scrollContent: {
    paddingBottom: 40,
  },
  sheet: {
    backgroundColor: '#1E293B',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '100%',
    borderWidth: 1,
    borderColor: '#334155',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  closeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  closeBtnText: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: '#3F1D2E',
    borderColor: '#F43F5E',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  errorText: {
    color: '#FDA4AF',
    fontSize: 13,
  },
  planSummaryBox: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 10,
  },
  planSummaryTitle: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  planSummarySub: {
    color: '#818CF8',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#CBD5E1',
    marginBottom: 6,
    marginTop: 8,
  },
  labelRowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 4,
  },
  dateChipsRow: {
    flexDirection: 'row',
    gap: 4,
  },
  dateQuickChip: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  dateQuickChipActive: {
    borderColor: '#4F46E5',
    backgroundColor: '#312E81',
  },
  dateQuickChipText: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '500',
  },
  dateQuickChipTextActive: {
    color: '#E0E7FF',
    fontWeight: '700',
  },
  input: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#F8FAFC',
    fontSize: 14,
    marginBottom: 6,
  },
  splitRow: {
    flexDirection: 'row',
    gap: 10,
  },
  splitCol: {
    flex: 1,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 6,
  },
  pill: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  pillActive: {
    backgroundColor: '#4F46E5',
    borderColor: '#6366F1',
  },
  pillLocked: {
    opacity: 0.65,
    borderColor: '#F59E0B',
  },
  pillText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '500',
  },
  pillTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  previewBox: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginVertical: 6,
  },
  previewTitle: {
    color: '#A7F3D0',
    fontSize: 12,
    fontWeight: '700',
  },
  previewText: {
    color: '#D1FAE5',
    fontSize: 12,
    marginTop: 2,
  },
  submitButton: {
    backgroundColor: '#4F46E5',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 14,
    marginBottom: 8,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  dangerButton: {
    backgroundColor: '#3F1D2E',
    borderColor: '#F43F5E',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  dangerButtonText: {
    color: '#FDA4AF',
    fontSize: 13,
    fontWeight: '600',
  },
});
