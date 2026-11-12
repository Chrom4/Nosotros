import { FlashList } from '@shopify/flash-list';
import { and, eq, isNull } from 'drizzle-orm';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CurrencyInput } from '@/components/CurrencyInput';
import type { AccountType, OwnershipFilter } from '@/core';
import {
  type AccountRow,
  accounts,
  type AppDatabase,
  computeAccountsWithBalances,
  createAccount,
  generateUuidV4,
  getActiveDatabase,
  householdMembers,
  softDeleteAccount,
  transactions,
  updateAccount,
  useReactiveQuery,
} from '@/data';
import { syncHouseholdMembers } from '@/sync/membershipSync';
import {
  formatCentsToBrl,
  parseCurrencyInputToCents,
  useFiltersStore,
  useSessionUIStore,
} from '@/store';

const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: 'CHECKING', label: 'Conta Corrente' },
  { value: 'SAVINGS', label: 'Poupança' },
  { value: 'WALLET', label: 'Carteira Física' },
  { value: 'INVESTMENT', label: 'Investimento' },
];

export interface AccountsScreenProps {
  db?: AppDatabase | null;
  householdId?: string | null;
}

export default function AccountsScreen({
  db: propDb,
  householdId: propHouseholdId,
}: AccountsScreenProps = {}) {
  const sessionHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const sessionUserId = useSessionUIStore((s) => s.userId);
  const sessionUserEmail = useSessionUIStore((s) => s.userEmail);
  const ownershipFilter = useFiltersStore((s) => s.ownershipFilter);
  const setOwnershipFilter = useFiltersStore((s) => s.setOwnershipFilter);

  const db = propDb ?? getActiveDatabase();
  const householdId = propHouseholdId ?? sessionHouseholdId;

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

  const accountsWithBalances = useMemo(
    () => computeAccountsWithBalances(accountRows, txRows, ownershipFilter),
    [accountRows, txRows, ownershipFilter],
  );

  const totalBalanceCents = useMemo(
    () =>
      accountsWithBalances.reduce((acc, item) => acc + item.balanceCents, 0),
    [accountsWithBalances],
  );

  const [editingAccount, setEditingAccount] = useState<AccountRow | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('CHECKING');
  const [initialBalanceCents, setInitialBalanceCents] = useState(0);
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [includeInNetWorth, setIncludeInNetWorth] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const resetForm = () => {
    setEditingAccount(null);
    setName('');
    setType('CHECKING');
    setInitialBalanceCents(0);
    setOwnerUserId(null);
    setIncludeInNetWorth(true);
    setErrorMessage(null);
  };

  const handleEditSelect = (account: AccountRow) => {
    setEditingAccount(account);
    setName(account.name);
    setType(account.type);
    setInitialBalanceCents(account.initialBalanceCents);
    setOwnerUserId(account.ownerUserId);
    setIncludeInNetWorth(account.includeInNetWorth);
    setErrorMessage(null);
  };

  const handleSaveAccount = () => {
    setErrorMessage(null);
    if (!db || !householdId) {
      setErrorMessage('Banco local ou lar ativo não disponível.');
      return;
    }

    if (!name.trim()) {
      setErrorMessage('Informe o nome da conta ou carteira.');
      return;
    }

    try {
      if (editingAccount) {
        updateAccount(db, editingAccount.id, {
          name: name.trim(),
          type,
          initialBalanceCents,
          ownerUserId,
          includeInNetWorth,
        });
      } else {
        createAccount(db, {
          id: generateUuidV4(),
          householdId,
          ownerUserId,
          name: name.trim(),
          type,
          initialBalanceCents,
          includeInNetWorth,
          isArchived: false,
        });
      }
      resetForm();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao salvar conta.',
      );
    }
  };

  const handleSoftDelete = (accountId: string) => {
    if (!db) return;
    try {
      softDeleteAccount(db, accountId);
      if (editingAccount?.id === accountId) {
        resetForm();
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao remover conta.',
      );
    }
  };

  const renderFilterChip = (label: string, filter: OwnershipFilter, testId: string) => {
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
    <View style={styles.container} testID="accounts-screen">
      {/* Resumo de Saldo & Filtro de Titularidade */}
      <View style={styles.summaryCard}>
        <Text style={styles.summaryLabel}>Saldo nas Contas Visíveis</Text>
        <Text style={styles.summaryValue} testID="accounts-total-balance">
          {formatCentsToBrl(totalBalanceCents)}
        </Text>

        <View style={styles.filterRow}>
          {renderFilterChip(
            'Consolidado',
            { mode: 'CONSOLIDATED' },
            'accounts-filter-CONSOLIDATED',
          )}
          {renderFilterChip(
            'Casa (Conjunta)',
            { mode: 'DOMESTIC' },
            'accounts-filter-DOMESTIC',
          )}
          {effectiveMembers.map((m) =>
            renderFilterChip(
              m.displayName,
              { mode: 'USER', userId: m.userId },
              `accounts-filter-USER-${m.userId}`,
            ),
          )}
        </View>
      </View>

      {/* Formulário de Criação / Edição de Conta */}
      <View style={styles.formCard}>
        <Text style={styles.formTitle}>
          {editingAccount ? 'Editar Conta' : 'Nova Conta / Carteira'}
        </Text>

        {errorMessage ? (
          <View style={styles.errorBanner} testID="accounts-error-banner">
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <View style={styles.inputRow}>
          <TextInput
            testID="account-name-input"
            style={[styles.input, { flex: 2 }]}
            value={name}
            onChangeText={setName}
            placeholder="Nome (ex.: Itaú Conjunta)"
            placeholderTextColor="#64748B"
          />
          <CurrencyInput
            testID="account-initial-balance-input"
            style={[styles.input, { flex: 1 }]}
            valueCents={initialBalanceCents}
            onChangeCents={setInitialBalanceCents}
            placeholder="Saldo R$"
          />
        </View>

        <View style={styles.chipRow}>
          {ACCOUNT_TYPES.map((t) => {
            const active = type === t.value;
            return (
              <Pressable
                key={t.value}
                testID={`account-type-${t.value}`}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setType(t.value)}
              >
                <Text
                  style={[styles.chipText, active && styles.chipTextActive]}
                >
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.chipRow}>
          <Pressable
            testID="account-owner-DOMESTIC"
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
                testID={`account-owner-${m.userId}`}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setOwnerUserId(m.userId)}
              >
                <Text
                  style={[styles.chipText, active && styles.chipTextActive]}
                >
                  Pessoal ({m.displayName}{isMe ? ' - Você' : ''})
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            testID="account-networth-toggle"
            style={[styles.chip, includeInNetWorth && styles.chipActive]}
            onPress={() => setIncludeInNetWorth((v) => !v)}
          >
            <Text
              style={[
                styles.chipText,
                includeInNetWorth && styles.chipTextActive,
              ]}
            >
              {includeInNetWorth ? '✓ Soma Património' : 'Fora do Património'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.actionRow}>
          <Pressable
            testID="save-account-button"
            style={styles.primaryButton}
            onPress={handleSaveAccount}
          >
            <Text style={styles.primaryButtonText}>
              {editingAccount ? 'Atualizar Conta' : 'Adicionar Conta'}
            </Text>
          </Pressable>
          {editingAccount ? (
            <Pressable
              testID="cancel-edit-account-button"
              style={styles.secondaryButton}
              onPress={resetForm}
            >
              <Text style={styles.secondaryButtonText}>Cancelar</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Lista Reativa de Contas via FlashList */}
      <View style={styles.listWrapper}>
        <FlashList
          data={accountsWithBalances}
          keyExtractor={(item) => item.account.id}
          renderItem={({ item }) => {
            const memberName =
              item.account.ownerUserId === null
                ? 'Conjunta / Casa'
                : (memberRows.find(
                    (m) => m.userId === item.account.ownerUserId,
                  )?.displayName ?? 'Individual');

            return (
              <View
                style={styles.accountItem}
                testID={`account-row-${item.account.id}`}
              >
                <View style={styles.accountInfo}>
                  <Text style={styles.accountName}>{item.account.name}</Text>
                  <Text style={styles.accountMeta}>
                    {item.account.type} • {memberName}
                  </Text>
                </View>
                <View style={styles.accountRight}>
                  <Text
                    style={styles.accountBalance}
                    testID={`account-balance-${item.account.id}`}
                  >
                    {formatCentsToBrl(item.balanceCents)}
                  </Text>
                  <View style={styles.rowActions}>
                    <Pressable
                      testID={`edit-account-${item.account.id}`}
                      onPress={() => handleEditSelect(item.account)}
                      style={styles.rowBtn}
                    >
                      <Text style={styles.editBtnText}>Editar</Text>
                    </Pressable>
                    <Pressable
                      testID={`delete-account-${item.account.id}`}
                      onPress={() => handleSoftDelete(item.account.id)}
                      style={styles.rowBtn}
                    >
                      <Text style={styles.deleteBtnText}>Excluir</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.emptyText} testID="accounts-empty-state">
              Nenhuma conta ativa para o filtro selecionado.
            </Text>
          }
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    padding: 16,
  },
  summaryCard: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 12,
  },
  summaryLabel: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  summaryValue: {
    color: '#F8FAFC',
    fontSize: 24,
    fontWeight: '800',
    marginTop: 4,
    marginBottom: 10,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  filterChip: {
    backgroundColor: '#0F172A',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
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
  formCard: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 12,
  },
  formTitle: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 10,
  },
  errorBanner: {
    backgroundColor: '#3F1D2E',
    borderColor: '#F43F5E',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  errorText: {
    color: '#FDA4AF',
    fontSize: 12,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#F8FAFC',
    fontSize: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  chip: {
    backgroundColor: '#0F172A',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipActive: {
    backgroundColor: '#312E81',
    borderColor: '#6366F1',
  },
  chipText: {
    color: '#94A3B8',
    fontSize: 12,
  },
  chipTextActive: {
    color: '#E0E7FF',
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: '#4F46E5',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#CBD5E1',
    fontSize: 14,
  },
  listWrapper: {
    flex: 1,
  },
  accountItem: {
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
  accountInfo: {
    flex: 1,
  },
  accountName: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '700',
  },
  accountMeta: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 2,
  },
  accountRight: {
    alignItems: 'flex-end',
  },
  accountBalance: {
    color: '#A7F3D0',
    fontSize: 15,
    fontWeight: '700',
  },
  rowActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  rowBtn: {
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  editBtnText: {
    color: '#818CF8',
    fontSize: 12,
    fontWeight: '600',
  },
  deleteBtnText: {
    color: '#FB7185',
    fontSize: 12,
    fontWeight: '600',
  },
  emptyText: {
    color: '#64748B',
    textAlign: 'center',
    marginTop: 24,
    fontSize: 14,
  },
});
