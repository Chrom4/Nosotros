import { FlashList } from '@shopify/flash-list';
import { and, eq, isNull } from 'drizzle-orm';
import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { InvoiceStatus } from '@/core';
import { CurrencyInput } from '@/components/CurrencyInput';
import { DatePickerInput } from '@/components/DatePickerInput';
import { InstallmentEditor } from '@/components/InstallmentEditor';
import {
  accounts,
  type AppDatabase,
  categories,
  closeCreditCardInvoice,
  computeInstallmentPlansWithSlices,
  computeInvoicesWithDetails,
  creditCardInvoices,
  creditCards,
  getActiveDatabase,
  householdMembers,
  type InstallmentPlanWithSlices,
  installmentPlans,
  type InvoiceWithSummary,
  payCreditCardInvoice,
  reopenCreditCardInvoice,
  type TransactionRow,
  transactions,
  useReactiveQuery,
} from '@/data';
import {
  formatCentsToBrl,
  useFiltersStore,
  useSessionUIStore,
} from '@/store';

export interface InvoicesScreenProps {
  db?: AppDatabase | null;
  householdId?: string | null;
  currentUserId?: string | null;
}

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  OPEN: 'ABERTA',
  CLOSED: 'FECHADA',
  PAID: 'PAGA',
};

export default function InvoicesScreen({
  db: propDb,
  householdId: propHouseholdId,
  currentUserId: propCurrentUserId,
}: InvoicesScreenProps = {}) {
  const sessionHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const sessionUserId = useSessionUIStore((s) => s.userId);
  const ownershipFilter = useFiltersStore((s) => s.ownershipFilter);
  const competenceMonth = useFiltersStore((s) => s.competenceMonth);

  const db = propDb ?? getActiveDatabase();
  const householdId = propHouseholdId ?? sessionHouseholdId;
  const currentUserId = propCurrentUserId ?? sessionUserId;

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'ALL'>(
    'ALL',
  );
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<string | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Payment Modal State
  const [payingInvoice, setPayingInvoice] =
    useState<InvoiceWithSummary | null>(null);
  const [paymentMode, setPaymentMode] = useState<'FULL' | 'PARTIAL'>('FULL');
  const [partialAmountCents, setPartialAmountCents] = useState<number>(0);
  const [paymentAccountId, setPaymentAccountId] = useState<string | null>(null);
  const [paymentDate, setPaymentDate] = useState(`${competenceMonth}-17`);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  // Installment Editor State
  const [editingPlan, setEditingPlan] =
    useState<InstallmentPlanWithSlices | null>(null);
  const [editingSliceTx, setEditingSliceTx] = useState<TransactionRow | null>(
    null,
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

  const invoicesWithDetails = useMemo(
    () =>
      computeInvoicesWithDetails(invoiceRows, cardRows, txRows, {
        creditCardId: selectedCardId,
        statusFilter,
        ownerFilter: ownershipFilter,
      }),
    [invoiceRows, cardRows, txRows, selectedCardId, statusFilter, ownershipFilter],
  );

  const plansById = useMemo(() => {
    const allPlans = computeInstallmentPlansWithSlices(
      planRows,
      txRows,
      invoiceRows,
    );
    const map = new Map<string, InstallmentPlanWithSlices>();
    for (const p of allPlans) {
      map.set(p.plan.id, p);
    }
    return map;
  }, [planRows, txRows, invoiceRows]);

  const totalUnpaidDebtCents = useMemo(
    () =>
      invoicesWithDetails.reduce(
        (acc, item) => acc + Math.max(0, item.debtCents),
        0,
      ),
    [invoicesWithDetails],
  );

  const activeAccounts = useMemo(
    () => accountRows.filter((a) => !a.isArchived),
    [accountRows],
  );

  const handleCloseInvoice = (invoiceId: string) => {
    if (!db) return;
    setErrorMessage(null);
    try {
      closeCreditCardInvoice(db, invoiceId);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao fechar fatura.',
      );
    }
  };

  const handleReopenInvoice = (invoiceId: string) => {
    if (!db) return;
    setErrorMessage(null);
    try {
      reopenCreditCardInvoice(db, invoiceId);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao reabrir fatura.',
      );
    }
  };

  const openPaymentModal = (item: InvoiceWithSummary) => {
    setPayingInvoice(item);
    setPaymentMode('FULL');
    setPartialAmountCents(0);
    setPaymentAccountId(
      item.card?.defaultPaymentAccountId ?? activeAccounts[0]?.id ?? null,
    );
    setPaymentDate(item.invoice.dueDate);
    setPaymentError(null);
  };

  const handleConfirmPayment = () => {
    setPaymentError(null);
    if (!db || !householdId || !payingInvoice) return;

    const effectiveUserId =
      currentUserId ?? memberRows[0]?.userId ?? null;
    if (!effectiveUserId) {
      setPaymentError('Sessão do utilizador não identificada.');
      return;
    }

    const effectiveAccId =
      paymentAccountId ??
      payingInvoice.card?.defaultPaymentAccountId ??
      activeAccounts[0]?.id;

    if (!effectiveAccId) {
      setPaymentError('Selecione uma conta bancária para pagamento.');
      return;
    }

    let amountToPay: number | undefined;
    if (paymentMode === 'PARTIAL') {
      if (partialAmountCents <= 0) {
        setPaymentError('O valor parcial deve ser maior que R$ 0,00.');
        return;
      }
      amountToPay = partialAmountCents;
    }

    try {
      payCreditCardInvoice(db, {
        householdId,
        createdByUserId: effectiveUserId,
        invoiceId: payingInvoice.invoice.id,
        accountId: effectiveAccId,
        amountCents: amountToPay,
        paymentDate: paymentDate.trim(),
      });
      setPayingInvoice(null);
    } catch (err) {
      setPaymentError(
        err instanceof Error ? err.message : 'Erro ao pagar fatura.',
      );
    }
  };

  return (
    <View style={styles.container} testID="invoices-screen">
      {/* Resumo & Filtros de Cartão e Status */}
      <View style={styles.headerCard}>
        <Text style={styles.summaryLabel}>Dívida em Aberto nas Faturas</Text>
        <Text style={styles.summaryValue} testID="invoices-total-debt">
          {formatCentsToBrl(totalUnpaidDebtCents)}
        </Text>

        {errorMessage ? (
          <View style={styles.errorBanner} testID="invoices-error-banner">
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* Filtro porStatus (ALL / OPEN / CLOSED / PAID) */}
        <View style={styles.filterRow}>
          {(['ALL', 'OPEN', 'CLOSED', 'PAID'] as const).map((st) => {
            const active = statusFilter === st;
            return (
              <Pressable
                key={st}
                testID={`invoices-status-filter-${st}`}
                style={[styles.filterChip, active && styles.filterChipActive]}
                onPress={() => setStatusFilter(st)}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    active && styles.filterChipTextActive,
                  ]}
                >
                  {st === 'ALL' ? 'Todas' : STATUS_LABELS[st]}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Filtro por Cartão */}
        <View style={styles.filterRow}>
          <Pressable
            testID="invoices-card-filter-ALL"
            style={[
              styles.filterChip,
              selectedCardId === null && styles.filterChipActive,
            ]}
            onPress={() => setSelectedCardId(null)}
          >
            <Text
              style={[
                styles.filterChipText,
                selectedCardId === null && styles.filterChipTextActive,
              ]}
            >
              Todos os Cartões
            </Text>
          </Pressable>
          {cardRows.map((c) => {
            const active = selectedCardId === c.id;
            return (
              <Pressable
                key={c.id}
                testID={`invoices-card-filter-${c.id}`}
                style={[styles.filterChip, active && styles.filterChipActive]}
                onPress={() => setSelectedCardId(c.id)}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    active && styles.filterChipTextActive,
                  ]}
                >
                  {c.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Lista Reativa de Faturas */}
      <View style={styles.listWrapper}>
        <FlashList
          data={invoicesWithDetails}
          keyExtractor={(item) => item.invoice.id}
          renderItem={({ item }) => {
            const isExpanded = expandedInvoiceId === item.invoice.id;

            return (
              <View
                style={styles.invoiceCard}
                testID={`invoice-row-${item.invoice.id}`}
              >
                <Pressable
                  testID={`toggle-invoice-details-${item.invoice.id}`}
                  onPress={() =>
                    setExpandedInvoiceId(isExpanded ? null : item.invoice.id)
                  }
                >
                  <View style={styles.invoiceTopRow}>
                    <View style={styles.invoiceInfo}>
                      <Text style={styles.invoiceTitle}>
                        {item.card?.name ?? 'Cartão'} •{' '}
                        {item.invoice.competenceMonth}
                      </Text>
                      <Text
                        style={styles.invoiceDates}
                        testID={`invoice-dates-${item.invoice.id}`}
                      >
                        Fechamento: {item.invoice.closingDate} • Vencimento:{' '}
                        {item.invoice.dueDate}
                      </Text>
                    </View>
                    <View style={styles.invoiceRight}>
                      <View
                        style={[
                          styles.statusBadge,
                          item.invoice.status === 'OPEN'
                            ? styles.badgeOpen
                            : item.invoice.status === 'CLOSED'
                              ? styles.badgeClosed
                              : styles.badgePaid,
                        ]}
                        testID={`invoice-status-${item.invoice.id}`}
                      >
                        <Text style={styles.statusBadgeText}>
                          {STATUS_LABELS[item.invoice.status]}
                        </Text>
                      </View>
                      <Text
                        style={styles.debtAmount}
                        testID={`invoice-debt-${item.invoice.id}`}
                      >
                        Dívida: {formatCentsToBrl(item.debtCents)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.breakdownRow}>
                    <Text style={styles.breakdownText}>
                      Compras: {formatCentsToBrl(item.chargesCents)}
                    </Text>
                    <Text style={styles.breakdownText}>
                      Estornos: {formatCentsToBrl(item.refundsCents)}
                    </Text>
                    <Text style={styles.breakdownText}>
                      Pago: {formatCentsToBrl(item.paidCents)}
                    </Text>
                  </View>
                </Pressable>

                {/* Ações da Fatura */}
                <View style={styles.actionRow}>
                  {item.invoice.status === 'OPEN' ? (
                    <Pressable
                      testID={`close-invoice-${item.invoice.id}`}
                      style={styles.secondaryBtn}
                      onPress={() => handleCloseInvoice(item.invoice.id)}
                    >
                      <Text style={styles.secondaryBtnText}>Fechar Fatura</Text>
                    </Pressable>
                  ) : null}

                  {item.invoice.status === 'CLOSED' ? (
                    <Pressable
                      testID={`reopen-invoice-${item.invoice.id}`}
                      style={styles.secondaryBtn}
                      onPress={() => handleReopenInvoice(item.invoice.id)}
                    >
                      <Text style={styles.secondaryBtnText}>Reabrir</Text>
                    </Pressable>
                  ) : null}

                  {item.debtCents > 0 ? (
                    <Pressable
                      testID={`pay-invoice-${item.invoice.id}`}
                      style={styles.payBtn}
                      onPress={() => openPaymentModal(item)}
                    >
                      <Text style={styles.payBtnText}>
                        Pagar Fatura (Total / Parcial)
                      </Text>
                    </Pressable>
                  ) : null}
                </View>

                {/* Detalhes de Lançamentos da Fatura */}
                {isExpanded ? (
                  <View
                    style={styles.txListSection}
                    testID={`invoice-tx-list-${item.invoice.id}`}
                  >
                    <Text style={styles.txSectionHeader}>
                      Itens na Fatura ({item.transactions.length}):
                    </Text>
                    {item.transactions.map((tx) => {
                      const linkedPlan = tx.installmentPlanId
                        ? plansById.get(tx.installmentPlanId)
                        : null;

                      return (
                        <View
                          key={tx.id}
                          style={styles.txRow}
                          testID={`invoice-tx-${tx.id}`}
                        >
                          <View style={styles.txRowLeft}>
                            <Text style={styles.txRowDesc}>
                              {tx.description}
                            </Text>
                            <Text style={styles.txRowMeta}>
                              {tx.transactionDate} • {tx.type}
                            </Text>
                          </View>
                          <View style={styles.txRowRight}>
                            <Text
                              style={[
                                styles.txRowAmount,
                                tx.type === 'CREDIT_PURCHASE'
                                  ? styles.chargeColor
                                  : styles.creditColor,
                              ]}
                            >
                              {tx.type === 'CREDIT_PURCHASE' ? '+ ' : '- '}
                              {formatCentsToBrl(tx.amountCents)}
                            </Text>
                            {linkedPlan ? (
                              <Pressable
                                testID={`edit-slice-tx-${tx.id}`}
                                onPress={() => {
                                  setEditingPlan(linkedPlan);
                                  setEditingSliceTx(tx);
                                }}
                              >
                                <Text style={styles.editSliceLink}>
                                  Editar Parcela (A/B)
                                </Text>
                              </Pressable>
                            ) : null}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.emptyText} testID="invoices-empty-state">
              Nenhuma fatura encontrada para os filtros selecionados.
            </Text>
          }
        />
      </View>

      {/* Modal de Pagamento de Fatura (Total ou Parcial) */}
      <Modal
        visible={payingInvoice !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setPayingInvoice(null)}
      >
        <View style={styles.modalBackdrop} testID="invoice-payment-modal">
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                Pagar Fatura ({payingInvoice?.invoice.competenceMonth})
              </Text>
              <Pressable
                testID="close-payment-modal"
                onPress={() => setPayingInvoice(null)}
              >
                <Text style={styles.closeText}>Fechar</Text>
              </Pressable>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled">
              {paymentError ? (
                <View style={styles.errorBanner} testID="payment-modal-error">
                  <Text style={styles.errorText}>{paymentError}</Text>
                </View>
              ) : null}

              <View style={styles.infoBanner}>
                <Text style={styles.infoBannerText}>
                  Dívida Atual da Fatura:{' '}
                  {formatCentsToBrl(payingInvoice?.debtCents ?? 0)}
                </Text>
                <Text style={styles.infoBannerSub}>
                  O pagamento (INVOICE_PAYMENT) reduz o saldo da conta bancária
                  e quita o passivo da fatura sem duplicar despesa no resumo
                  mensal (TEST-FIN-02).
                </Text>
              </View>

              <Text style={styles.label}>Modalidade de Pagamento</Text>
              <View style={styles.filterRow}>
                <Pressable
                  testID="payment-mode-FULL"
                  style={[
                    styles.filterChip,
                    paymentMode === 'FULL' && styles.filterChipActive,
                  ]}
                  onPress={() => setPaymentMode('FULL')}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      paymentMode === 'FULL' && styles.filterChipTextActive,
                    ]}
                  >
                    Pagamento Total (
                    {formatCentsToBrl(payingInvoice?.debtCents ?? 0)})
                  </Text>
                </Pressable>
                <Pressable
                  testID="payment-mode-PARTIAL"
                  style={[
                    styles.filterChip,
                    paymentMode === 'PARTIAL' && styles.filterChipActive,
                  ]}
                  onPress={() => setPaymentMode('PARTIAL')}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      paymentMode === 'PARTIAL' && styles.filterChipTextActive,
                    ]}
                  >
                    Pagamento Parcial
                  </Text>
                </Pressable>
              </View>

              {paymentMode === 'PARTIAL' ? (
                <>
                  <Text style={styles.label}>Valor Parcial (R$)</Text>
                  <CurrencyInput
                    testID="payment-partial-amount-input"
                    style={styles.input}
                    valueCents={partialAmountCents}
                    onChangeCents={setPartialAmountCents}
                    placeholder="R$ 0,00"
                  />
                </>
              ) : null}

              <DatePickerInput
                testID="payment-date-input"
                label="Data do Pagamento"
                value={paymentDate}
                onChange={setPaymentDate}
              />

              <Text style={styles.label}>Conta Bancária Pagadora</Text>
              <View style={styles.filterRow}>
                {activeAccounts.map((acc) => {
                  const active = paymentAccountId === acc.id;
                  return (
                    <Pressable
                      key={acc.id}
                      testID={`payment-account-${acc.id}`}
                      style={[
                        styles.filterChip,
                        active && styles.filterChipActive,
                      ]}
                      onPress={() => setPaymentAccountId(acc.id)}
                    >
                      <Text
                        style={[
                          styles.filterChipText,
                          active && styles.filterChipTextActive,
                        ]}
                      >
                        {acc.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Pressable
                testID="confirm-invoice-payment-button"
                style={styles.confirmPayBtn}
                onPress={handleConfirmPayment}
              >
                <Text style={styles.confirmPayBtnText}>
                  Confirmar Pagamento da Fatura
                </Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <InstallmentEditor
        visible={editingPlan !== null}
        onClose={() => {
          setEditingPlan(null);
          setEditingSliceTx(null);
        }}
        initialMode="EDIT_INSTALLMENT"
        targetPlan={editingPlan}
        targetSliceTransaction={editingSliceTx}
        db={db}
        householdId={householdId}
        currentUserId={currentUserId}
        cards={cardRows}
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
  summaryLabel: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  summaryValue: {
    color: '#FB7185',
    fontSize: 22,
    fontWeight: '800',
    marginTop: 2,
    marginBottom: 10,
  },
  errorBanner: {
    backgroundColor: '#3F1D2E',
    borderColor: '#F43F5E',
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
  },
  errorText: {
    color: '#FDA4AF',
    fontSize: 12,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  filterChip: {
    backgroundColor: '#0F172A',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
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
  listWrapper: {
    flex: 1,
  },
  invoiceCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 10,
  },
  invoiceTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  invoiceInfo: {
    flex: 1,
  },
  invoiceTitle: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '700',
  },
  invoiceDates: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 2,
  },
  invoiceRight: {
    alignItems: 'flex-end',
  },
  statusBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 4,
  },
  badgeOpen: {
    backgroundColor: '#1E3A8A',
  },
  badgeClosed: {
    backgroundColor: '#78350F',
  },
  badgePaid: {
    backgroundColor: '#064E3B',
  },
  statusBadgeText: {
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: '700',
  },
  debtAmount: {
    color: '#FDA4AF',
    fontSize: 14,
    fontWeight: '700',
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  breakdownText: {
    color: '#CBD5E1',
    fontSize: 11,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  secondaryBtn: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  secondaryBtnText: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '600',
  },
  payBtn: {
    flex: 1,
    backgroundColor: '#10B981',
    borderRadius: 8,
    paddingVertical: 7,
    alignItems: 'center',
  },
  payBtnText: {
    color: '#064E3B',
    fontSize: 12,
    fontWeight: '800',
  },
  txListSection: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  txSectionHeader: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 6,
  },
  txRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#0F172A',
  },
  txRowLeft: {
    flex: 1,
  },
  txRowDesc: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '600',
  },
  txRowMeta: {
    color: '#64748B',
    fontSize: 11,
  },
  txRowRight: {
    alignItems: 'flex-end',
  },
  txRowAmount: {
    fontSize: 13,
    fontWeight: '700',
  },
  chargeColor: {
    color: '#FB7185',
  },
  creditColor: {
    color: '#34D399',
  },
  editSliceLink: {
    color: '#818CF8',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
  emptyText: {
    color: '#64748B',
    textAlign: 'center',
    marginTop: 20,
    fontSize: 13,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.82)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#1E293B',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '700',
  },
  closeText: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
  },
  infoBanner: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 10,
  },
  infoBannerText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  infoBannerSub: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 4,
  },
  label: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: '#F8FAFC',
    fontSize: 14,
    marginBottom: 6,
  },
  confirmPayBtn: {
    backgroundColor: '#10B981',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 14,
  },
  confirmPayBtnText: {
    color: '#064E3B',
    fontSize: 14,
    fontWeight: '800',
  },
});
