import { create } from 'zustand';
import {
  addMonthsToCompetence,
  assertCompetenceMonth,
  type OwnershipFilter,
} from '@/core';
import type { BaseTransactionType } from '@/data/repositories';
import type { CategoryKind } from '@/data/schema';

export const DEFAULT_COMPETENCE_MONTH = '2026-11';

/**
 * Formats an integer amount in cents (`amountCents`) to a Brazilian Real string (`R$ 1.234,56`)
 * using pure integer division and modulo (`Math.trunc` / `BigInt`-safe integer arithmetic, zero float math).
 */
export function formatCentsToBrl(amountCents: number): string {
  if (!Number.isInteger(amountCents) || !Number.isSafeInteger(amountCents)) {
    throw new Error(`Invalid integer cents: ${amountCents}`);
  }

  const isNegative = amountCents < 0;
  const absCents = Math.abs(amountCents);
  const wholeReais = Math.floor(absCents / 100);
  const centsPart = String(absCents % 100).padStart(2, '0');
  const formattedWhole = String(wholeReais).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    '.',
  );

  return `${isNegative ? '- ' : ''}R$ ${formattedWhole},${centsPart}`;
}

/**
 * Parses a user-entered currency string (e.g. `"150,50"`, `"1.250,00"`, `"45"`, `"R$ 89,90"`)
 * into a safe integer in cents using string/integer parsing only (no `parseFloat`).
 */
export function parseCurrencyInputToCents(rawInput: string): number {
  const trimmed = rawInput
    .replace(/R\$/gi, '')
    .replace(/\s+/g, '')
    .trim();

  if (!trimmed) {
    return 0;
  }

  const isNegative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[+-]/, '');

  // If the string contains a comma or dot as decimal separator
  const lastComma = unsigned.lastIndexOf(',');
  const lastDot = unsigned.lastIndexOf('.');
  const sepIndex = Math.max(lastComma, lastDot);

  let wholeDigits = '';
  let fractionDigits = '00';

  if (sepIndex >= 0) {
    const afterSep = unsigned.slice(sepIndex + 1).replace(/\D/g, '');
    // Treat as decimal separator if 1 or 2 digits follow (or if it is a comma)
    if (lastComma === sepIndex || afterSep.length <= 2) {
      wholeDigits = unsigned.slice(0, sepIndex).replace(/\D/g, '');
      fractionDigits = afterSep.slice(0, 2).padEnd(2, '0');
    } else {
      wholeDigits = unsigned.replace(/\D/g, '');
    }
  } else {
    wholeDigits = unsigned.replace(/\D/g, '');
  }

  const wholeInt = wholeDigits ? Number(wholeDigits) : 0;
  const fracInt = fractionDigits ? Number(fractionDigits) : 0;

  if (!Number.isSafeInteger(wholeInt) || !Number.isSafeInteger(fracInt)) {
    throw new Error(`Invalid monetary input: ${rawInput}`);
  }

  const totalCents = wholeInt * 100 + fracInt;
  return isNegative ? -totalCents : totalCents;
}

export interface FiltersUIState {
  ownershipFilter: OwnershipFilter;
  competenceMonth: string;
  selectedCategoryKind: CategoryKind;
  isQuickModalVisible: boolean;
  quickModalInitialType: BaseTransactionType;
  editingTransactionId: string | null;

  setOwnershipFilter: (filter: OwnershipFilter) => void;
  setCompetenceMonth: (competenceMonth: string) => void;
  shiftCompetenceMonth: (deltaMonths: number) => void;
  setSelectedCategoryKind: (kind: CategoryKind) => void;
  openQuickModal: (
    initialType?: BaseTransactionType,
    editingTransactionId?: string | null,
  ) => void;
  closeQuickModal: () => void;
  resetFilters: () => void;
}

const initialFiltersState = {
  ownershipFilter: { mode: 'CONSOLIDATED' } as OwnershipFilter,
  competenceMonth: DEFAULT_COMPETENCE_MONTH,
  selectedCategoryKind: 'EXPENSE' as CategoryKind,
  isQuickModalVisible: false,
  quickModalInitialType: 'EXPENSE' as BaseTransactionType,
  editingTransactionId: null as string | null,
};

export const useFiltersStore = create<FiltersUIState>((set, get) => ({
  ...initialFiltersState,

  setOwnershipFilter: (filter) => {
    set({ ownershipFilter: filter });
  },

  setCompetenceMonth: (competenceMonth) => {
    assertCompetenceMonth(competenceMonth, 'competenceMonth');
    set({ competenceMonth });
  },

  shiftCompetenceMonth: (deltaMonths) => {
    const nextMonth = addMonthsToCompetence(
      get().competenceMonth,
      deltaMonths,
    );
    set({ competenceMonth: nextMonth });
  },

  setSelectedCategoryKind: (kind) => {
    set({ selectedCategoryKind: kind });
  },

  openQuickModal: (initialType = 'EXPENSE', editingTransactionId = null) => {
    set({
      isQuickModalVisible: true,
      quickModalInitialType: initialType,
      editingTransactionId,
    });
  },

  closeQuickModal: () => {
    set({
      isQuickModalVisible: false,
      editingTransactionId: null,
    });
  },

  resetFilters: () => {
    set({ ...initialFiltersState });
  },
}));
