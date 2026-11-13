/**
 * Shared visual tokens for No$otros screens (dark financial UI).
 * Prefer these over duplicated hex literals in tab screens.
 */

export const colors = {
  surface: '#0F172A',
  surfaceElevated: '#1E293B',
  surfaceMuted: '#334155',
  border: '#334155',
  borderStrong: '#475569',
  textPrimary: '#F8FAFC',
  textSecondary: '#E2E8F0',
  textMuted: '#94A3B8',
  textFaint: '#64748B',
  textOnAccent: '#FFFFFF',
  accent: '#4F46E5',
  accentSoft: '#818CF8',
  accentContainer: '#1E1B4B',
  success: '#10B981',
  danger: '#F43F5E',
  dangerSoft: '#FB7185',
  dangerContainer: '#3F1D2E',
  warning: '#F59E0B',
  tabBar: '#1E293B',
  tabActive: '#818CF8',
  tabInactive: '#94A3B8',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const radii = {
  sm: 8,
  md: 10,
  lg: 12,
} as const;

export type ColorToken = keyof typeof colors;
