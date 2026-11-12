import React, { useMemo, useState } from 'react';
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
import type { TransactionStatus } from '@/core';
import {
  type AccountRow,
  type AppDatabase,
  BASE_TRANSACTION_TYPES,
  type BaseTransactionType,
  type CategoryRow,
  createBaseTransaction,
  flattenCategoryTree,
  getActiveDatabase,
  type HouseholdMemberRow,
  resolveBaseTransactionContributionFlag,
  type TransactionRow,
} from '@/data';
import {
  formatCentsToBrl,
  parseCurrencyInputToCents,
  useFiltersStore,
  useSessionUIStore,
} from '@/store';

export interface TransactionQuickModalProps {
  visible?: boolean;
  onClose?: () => void;
  onSuccess?: (transaction: TransactionRow) => void;
  db?: AppDatabase | null;
  householdId?: string | null;
  currentUserId?: string | null;
  accounts: readonly AccountRow[];
  categories: readonly CategoryRow[];
  members: readonly HouseholdMemberRow[];
  defaultDateIso?: string;
}

const TYPE_LABELS: Record<BaseTransactionType, string> = {
  EXPENSE: 'Despesa',
  INCOME: 'Receita',
  DEBIT_REFUND: 'Estorno Débito',
  TRANSFER: 'Transferência',
};

export function parseFriendlyDateToIso(
  input: string,
  fallbackMonth?: string,
): string {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const ddmmyyyy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const day = ddmmyyyy[1].padStart(2, '0');
    const month = ddmmyyyy[2].padStart(2, '0');
    const year = ddmmyyyy[3];
    return `${year}-${month}-${day}`;
  }
  const ddmm = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (ddmm) {
    const year = fallbackMonth
      ? fallbackMonth.slice(0, 4)
      : new Date().getFullYear().toString();
    const day = ddmm[1].padStart(2, '0');
    const month = ddmm[2].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const dd = trimmed.match(/^(\d{1,2})$/);
  if (dd && fallbackMonth) {
    const day = dd[1].padStart(2, '0');
    return `${fallbackMonth}-${day}`;
  }
  return trimmed;
}

export function TransactionQuickModal({
  visible,
  onClose,
  onSuccess,
  db: propDb,
  householdId: propHouseholdId,
  currentUserId: propCurrentUserId,
  accounts,
  categories,
  members,
  defaultDateIso,
}: TransactionQuickModalProps) {
  const storeVisible = useFiltersStore((s) => s.isQuickModalVisible);
  const storeInitialType = useFiltersStore((s) => s.quickModalInitialType);
  const competenceMonth = useFiltersStore((s) => s.competenceMonth);
  const closeQuickModal = useFiltersStore((s) => s.closeQuickModal);

  const sessionHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const sessionUserId = useSessionUIStore((s) => s.userId);
  const sessionUserEmail = useSessionUIStore((s) => s.userEmail);

  const isVisible = visible ?? storeVisible;
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

  const [selectedType, setSelectedType] = useState<BaseTransactionType | null>(
    null,
  );
  const type = selectedType ?? storeInitialType;

  const [amountCents, setAmountCents] = useState(0);
  const [description, setDescription] = useState('');
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const yesterdayIso = useMemo(
    () => new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    [],
  );
  const [transactionDate, setTransactionDate] = useState(
    defaultDateIso ??
      (todayIso.startsWith(competenceMonth)
        ? todayIso
        : `${competenceMonth}-01`),
  );
  const [status, setStatus] = useState<TransactionStatus>('CLEARED');
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [transferAccountId, setTransferAccountId] = useState<string | null>(
    null,
  );
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [manualContributionToggle, setManualContributionToggle] =
    useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeAccounts = useMemo(
    () => accounts.filter((a) => a.deletedAt === null && !a.isArchived),
    [accounts],
  );

  const expectedCategoryKind = type === 'INCOME' ? 'INCOME' : 'EXPENSE';
  const hierarchicalCategories = useMemo(
    () =>
      type === 'TRANSFER'
        ? []
        : flattenCategoryTree(categories, expectedCategoryKind),
    [categories, expectedCategoryKind, type],
  );

  const effectiveAccountId = useMemo(() => {
    if (accountId && activeAccounts.some((a) => a.id === accountId)) {
      return accountId;
    }
    return activeAccounts[0]?.id ?? null;
  }, [accountId, activeAccounts]);

  const effectiveTransferAccountId = useMemo(() => {
    if (type !== 'TRANSFER') {
      return null;
    }
    if (
      transferAccountId &&
      transferAccountId !== effectiveAccountId &&
      activeAccounts.some((a) => a.id === transferAccountId)
    ) {
      return transferAccountId;
    }
    const candidate = activeAccounts.find((a) => a.id !== effectiveAccountId);
    return candidate?.id ?? null;
  }, [type, transferAccountId, effectiveAccountId, activeAccounts]);

  const effectiveCategoryId = useMemo(() => {
    if (type === 'TRANSFER') {
      return null;
    }
    if (
      categoryId &&
      hierarchicalCategories.some((c) => c.row.id === categoryId)
    ) {
      return categoryId;
    }
    return hierarchicalCategories[0]?.row.id ?? null;
  }, [type, categoryId, hierarchicalCategories]);

  const selectedOriginAccount = useMemo(
    () => activeAccounts.find((a) => a.id === effectiveAccountId) ?? null,
    [activeAccounts, effectiveAccountId],
  );

  const selectedDestAccount = useMemo(
    () =>
      activeAccounts.find((a) => a.id === effectiveTransferAccountId) ?? null,
    [activeAccounts, effectiveTransferAccountId],
  );

  const isAutoDec02Contribution =
    (type === 'EXPENSE' || type === 'DEBIT_REFUND') &&
    ownerUserId === null &&
    selectedOriginAccount !== null &&
    selectedOriginAccount.ownerUserId !== null;

  const isEligibleTransferContribution =
    type === 'TRANSFER' &&
    selectedOriginAccount !== null &&
    selectedOriginAccount.ownerUserId !== null &&
    selectedDestAccount !== null &&
    selectedDestAccount.ownerUserId === null;

  const effectiveContributionFlag = resolveBaseTransactionContributionFlag({
    type,
    ownerUserId,
    originAccountOwnerUserId: selectedOriginAccount?.ownerUserId ?? null,
    destAccountOwnerUserId: selectedDestAccount?.ownerUserId ?? null,
    requestedContributionFlag: manualContributionToggle,
  });

  const handleClose = () => {
    setErrorMessage(null);
    setSelectedType(null);
    if (onClose) {
      onClose();
    } else {
      closeQuickModal();
    }
  };

  const handleSelectType = (nextType: BaseTransactionType) => {
    setSelectedType(nextType);
    setErrorMessage(null);
    if (nextType === 'TRANSFER') {
      setCategoryId(null);
    } else {
      setTransferAccountId(null);
    }
  };

  const handleSubmit = () => {
    setErrorMessage(null);

    const targetDb = propDb ?? getActiveDatabase();
    if (!targetDb) {
      setErrorMessage('Banco de dados local ainda não inicializado.');
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

    if (!description.trim()) {
      setErrorMessage('Informe uma descrição para o lançamento.');
      return;
    }

    try {
      const finalDate = parseFriendlyDateToIso(transactionDate, competenceMonth);
      const created = createBaseTransaction(targetDb, {
        householdId: effectiveHouseholdId,
        createdByUserId: effectiveUserId,
        ownerUserId,
        type,
        status,
        amountCents,
        transactionDate: finalDate,
        competenceMonth: finalDate.slice(0, 7),
        description: description.trim(),
        accountId: effectiveAccountId,
        transferAccountId:
          type === 'TRANSFER' ? effectiveTransferAccountId : null,
        categoryId: type === 'TRANSFER' ? null : effectiveCategoryId,
        isHouseholdContribution: effectiveContributionFlag,
      });

      setAmountCents(0);
      setDescription('');
      onSuccess?.(created);
      handleClose();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Erro ao salvar lançamento no cofre local.',
      );
    }
  };

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <View style={styles.backdrop} testID="transaction-quick-modal">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboardContainer}
        >
          <View style={styles.sheet}>
            <View style={styles.headerRow}>
              <Text style={styles.title}>Novo Lançamento</Text>
              <Pressable
                testID="quick-modal-close-button"
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
                <View style={styles.errorBanner} testID="quick-modal-error">
                  <Text style={styles.errorText}>{errorMessage}</Text>
                </View>
              ) : null}

              {/* Tipo de Lançamento Base */}
              <Text style={styles.label}>Tipo de Lançamento</Text>
              <View style={styles.pillRow}>
                {BASE_TRANSACTION_TYPES.map((t) => {
                  const active = type === t;
                  return (
                    <Pressable
                      key={t}
                      testID={`quick-modal-type-${t}`}
                      style={[styles.pill, active && styles.pillActive]}
                      onPress={() => handleSelectType(t)}
                    >
                      <Text
                        style={[styles.pillText, active && styles.pillTextActive]}
                      >
                        {TYPE_LABELS[t]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Valor em Centavos (input com máscara de banco) */}
              <Text style={styles.label}>Valor (R$)</Text>
              <CurrencyInput
                testID="quick-modal-amount-input"
                style={styles.input}
                valueCents={amountCents}
                onChangeCents={setAmountCents}
                placeholder="R$ 0,00"
              />

              {/* Descrição */}
              <Text style={styles.label}>Descrição</Text>
              <TextInput
                testID="quick-modal-description-input"
                style={styles.input}
                value={description}
                onChangeText={setDescription}
                placeholder="Ex.: Supermercado Semanal"
                placeholderTextColor="#64748B"
              />

              {/* Data do Lançamento (Linha única dedicada) */}
              <DatePickerInput
                testID="quick-modal-date-input"
                label="Data"
                value={transactionDate}
                onChange={setTransactionDate}
              />

              {/* Status */}
              <Text style={styles.label}>Status</Text>
              <View style={styles.pillRow}>
                {(['CLEARED', 'PENDING'] as const).map((st) => {
                  const active = status === st;
                  return (
                    <Pressable
                      key={st}
                      testID={`quick-modal-status-${st}`}
                      style={[styles.pill, active && styles.pillActive]}
                      onPress={() => setStatus(st)}
                    >
                      <Text
                        style={[
                          styles.pillText,
                          active && styles.pillTextActive,
                        ]}
                      >
                        {st === 'CLEARED' ? 'Efetivado' : 'Pendente'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Titularidade / Ownership Selector */}
              <Text style={styles.label}>Titularidade da Despesa / Receita</Text>
              <View style={styles.pillRow}>
                <Pressable
                  testID="quick-modal-owner-DOMESTIC"
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
                      testID={`quick-modal-owner-${m.userId}`}
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

            {/* Conta de Origem / Conta Bancária */}
            <Text style={styles.label}>
              {type === 'TRANSFER' ? 'Conta de Origem' : 'Conta / Carteira'}
            </Text>
            <View style={styles.pillRow}>
              {activeAccounts.map((acc) => {
                const active = effectiveAccountId === acc.id;
                return (
                  <Pressable
                    key={acc.id}
                    testID={`quick-modal-account-${acc.id}`}
                    style={[styles.pill, active && styles.pillActive]}
                    onPress={() => setAccountId(acc.id)}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        active && styles.pillTextActive,
                      ]}
                    >
                      {acc.name}{' '}
                      {acc.ownerUserId === null ? '(Conjunta)' : '(Individual)'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Conta de Destino (apenas para TRANSFER) */}
            {type === 'TRANSFER' ? (
              <>
                <Text style={styles.label}>Conta de Destino</Text>
                <View style={styles.pillRow}>
                  {activeAccounts.map((acc) => {
                    const active = effectiveTransferAccountId === acc.id;
                    return (
                      <Pressable
                        key={acc.id}
                        testID={`quick-modal-transfer-account-${acc.id}`}
                        style={[styles.pill, active && styles.pillActive]}
                        onPress={() => setTransferAccountId(acc.id)}
                      >
                        <Text
                          style={[
                            styles.pillText,
                            active && styles.pillTextActive,
                          ]}
                        >
                          {acc.name}{' '}
                          {acc.ownerUserId === null
                            ? '(Conjunta)'
                            : '(Individual)'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : (
              /* Seletor de Categoria Hierárquica (para INCOME / EXPENSE / DEBIT_REFUND) */
              <>
                <Text style={styles.label}>Categoria</Text>
                <View style={styles.pillRow}>
                  {hierarchicalCategories.map((item) => {
                    const active = effectiveCategoryId === item.row.id;
                    return (
                      <Pressable
                        key={item.row.id}
                        testID={`quick-modal-category-${item.row.id}`}
                        style={[styles.pill, active && styles.pillActive]}
                        onPress={() => setCategoryId(item.row.id)}
                      >
                        <Text
                          style={[
                            styles.pillText,
                            active && styles.pillTextActive,
                          ]}
                        >
                          {item.displayLabel}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}

            {/* Indicador / Seletor DEC-02 de Aporte / Contribuição para a Casa */}
            {isAutoDec02Contribution ? (
              <View
                style={styles.dec02Banner}
                testID="quick-modal-dec02-auto-banner"
              >
                <Text style={styles.dec02BannerTitle}>
                  Aporte Automático (DEC-02)
                </Text>
                <Text style={styles.dec02BannerSub}>
                  Despesa compartilhada da casa paga com conta individual é
                  contabilizada automaticamente como contribuição do membro.
                </Text>
              </View>
            ) : null}

            {isEligibleTransferContribution ? (
              <Pressable
                testID="quick-modal-contribution-toggle"
                style={[
                  styles.contributionToggleBox,
                  manualContributionToggle &&
                    styles.contributionToggleBoxActive,
                ]}
                onPress={() => setManualContributionToggle((v) => !v)}
              >
                <Text style={styles.contributionToggleText}>
                  {manualContributionToggle
                    ? '✓ Marcar transferência como Aporte para a Conta Conjunta (DEC-02)'
                    : 'Marcar transferência como Aporte para a Conta Conjunta (DEC-02)'}
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              testID="quick-modal-submit-button"
              style={styles.submitButton}
              onPress={handleSubmit}
            >
              <Text style={styles.submitButtonText}>Salvar Lançamento</Text>
            </Pressable>
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
    backgroundColor: 'rgba(15, 23, 42, 0.8)',
    justifyContent: 'flex-end',
  },
  keyboardContainer: {
    width: '100%',
    maxHeight: '90%',
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
    marginBottom: 16,
  },
  title: {
    fontSize: 19,
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
    marginBottom: 14,
  },
  errorText: {
    color: '#FDA4AF',
    fontSize: 13,
  },
  label: {
    fontSize: 13,
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
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#F8FAFC',
    fontSize: 15,
    marginBottom: 6,
  },
  helperText: {
    color: '#94A3B8',
    fontSize: 12,
    marginBottom: 6,
  },
  splitRow: {
    flexDirection: 'row',
    gap: 12,
  },
  splitCol: {
    flex: 1,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  pill: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pillActive: {
    backgroundColor: '#4F46E5',
    borderColor: '#6366F1',
  },
  pillText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '500',
  },
  pillTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  dec02Banner: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
    marginBottom: 6,
  },
  dec02BannerTitle: {
    color: '#A7F3D0',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  dec02BannerSub: {
    color: '#D1FAE5',
    fontSize: 12,
  },
  contributionToggleBox: {
    backgroundColor: '#0F172A',
    borderColor: '#475569',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
  },
  contributionToggleBoxActive: {
    backgroundColor: '#1E1B4B',
    borderColor: '#6366F1',
  },
  contributionToggleText: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '500',
  },
  submitButton: {
    backgroundColor: '#4F46E5',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 8,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});
