import type { OwnershipFilter } from '@/core';

export type ContextMode = 'CONSOLIDATED' | 'MINE' | 'PARTNER' | 'DOMESTIC';

export interface MD3ContextTheme {
  mode: ContextMode;
  label: string;
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  surface: string;
  surfaceVariant: string;
  cardBackground: string;
  outline: string;
  accent: string;
  badgeBackground: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  income: string;
  expense: string;
  savings: string;
  warning: string;
}

export const CONSOLIDATED_THEME: MD3ContextTheme = {
  mode: 'CONSOLIDATED',
  label: 'Consolidado',
  primary: '#6366F1', // Indigo 500
  onPrimary: '#FFFFFF',
  primaryContainer: '#1E1B4B', // Indigo 950
  onPrimaryContainer: '#C7D2FE', // Indigo 200
  surface: '#0F172A', // Slate 900
  surfaceVariant: '#1E293B', // Slate 800
  cardBackground: '#1E293B',
  outline: '#4338CA', // Indigo 700
  accent: '#818CF8', // Indigo 400
  badgeBackground: '#312E81',
  textPrimary: '#F8FAFC',
  textSecondary: '#94A3B8',
  textMuted: '#64748B',
  income: '#10B981', // Emerald
  expense: '#F43F5E', // Rose
  savings: '#38BDF8', // Sky
  warning: '#F59E0B', // Amber
};

export const MINE_THEME: MD3ContextTheme = {
  mode: 'MINE',
  label: 'Minhas Finanças',
  primary: '#0EA5E9', // Sky 500
  onPrimary: '#FFFFFF',
  primaryContainer: '#082F49', // Sky 950
  onPrimaryContainer: '#BAE6FD', // Sky 200
  surface: '#071524',
  surfaceVariant: '#0C243B',
  cardBackground: '#0F2438',
  outline: '#0284C7', // Sky 600
  accent: '#38BDF8', // Sky 400
  badgeBackground: '#0369A1',
  textPrimary: '#F0F9FF',
  textSecondary: '#7DD3FC',
  textMuted: '#0284C7',
  income: '#10B981',
  expense: '#F43F5E',
  savings: '#38BDF8',
  warning: '#F59E0B',
};

export const PARTNER_THEME: MD3ContextTheme = {
  mode: 'PARTNER',
  label: 'Finanças do Parceiro(a)',
  primary: '#10B981', // Emerald 500
  onPrimary: '#FFFFFF',
  primaryContainer: '#022C22', // Emerald 950
  onPrimaryContainer: '#A7F3D0', // Emerald 200
  surface: '#061D15',
  surfaceVariant: '#0E3328',
  cardBackground: '#0F2D24',
  outline: '#059669', // Emerald 600
  accent: '#34D399', // Emerald 400
  badgeBackground: '#047857',
  textPrimary: '#ECFDF5',
  textSecondary: '#6EE7B7',
  textMuted: '#059669',
  income: '#10B981',
  expense: '#F43F5E',
  savings: '#34D399',
  warning: '#F59E0B',
};

export const DOMESTIC_THEME: MD3ContextTheme = {
  mode: 'DOMESTIC',
  label: 'Casa / Compartilhado',
  primary: '#8B5CF6', // Violet 500
  onPrimary: '#FFFFFF',
  primaryContainer: '#2E1065', // Violet 950
  onPrimaryContainer: '#DDD6FE', // Violet 200
  surface: '#130D24',
  surfaceVariant: '#22173B',
  cardBackground: '#24183A',
  outline: '#7C3AED', // Violet 600
  accent: '#A78BFA', // Violet 400
  badgeBackground: '#6D28D9',
  textPrimary: '#F5F3FF',
  textSecondary: '#C4B5FD',
  textMuted: '#7C3AED',
  income: '#10B981',
  expense: '#F43F5E',
  savings: '#A78BFA',
  warning: '#F59E0B',
};

export const CONTEXT_THEMES: Record<ContextMode, MD3ContextTheme> = {
  CONSOLIDATED: CONSOLIDATED_THEME,
  MINE: MINE_THEME,
  PARTNER: PARTNER_THEME,
  DOMESTIC: DOMESTIC_THEME,
};

/**
 * Resolves the ContextMode from the active OwnershipFilter and the current user's ID.
 */
export function resolveContextMode(
  filter: OwnershipFilter,
  currentUserId: string | null,
): ContextMode {
  if (filter.mode === 'CONSOLIDATED') {
    return 'CONSOLIDATED';
  }
  if (filter.mode === 'DOMESTIC') {
    return 'DOMESTIC';
  }
  if (filter.mode === 'USER') {
    if (currentUserId && filter.userId === currentUserId) {
      return 'MINE';
    }
    return 'PARTNER';
  }
  return 'CONSOLIDATED';
}

/**
 * Returns the MD3ContextTheme matching the resolved context mode.
 */
export function getContextTheme(
  filter: OwnershipFilter,
  currentUserId: string | null,
): MD3ContextTheme {
  const mode = resolveContextMode(filter, currentUserId);
  return CONTEXT_THEMES[mode];
}
