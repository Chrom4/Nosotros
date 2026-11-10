import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatCentsToBrl } from '@/store';
import type { MD3ContextTheme } from '@/theme';

export interface BudgetBarItem {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryIcon?: string;
  categoryColorHex?: string;
  limitCents: number;
  consumedCents: number;
}

export interface BudgetBarProps {
  budget: BudgetBarItem;
  theme?: MD3ContextTheme;
}

export const BudgetBar: React.FC<BudgetBarProps> = ({ budget, theme }) => {
  const { categoryId, categoryName, limitCents, consumedCents } = budget;

  const percent =
    limitCents > 0 ? Math.round((consumedCents / limitCents) * 100) : 0;
  const clampedRatio =
    limitCents > 0 ? Math.min(Math.max(consumedCents / limitCents, 0), 1) : 0;
  const isOverBudget = consumedCents > limitCents;
  const remainingCents = limitCents - consumedCents;

  let barColor = '#10B981'; // Green (calm)
  if (percent > 100) {
    barColor = '#F43F5E'; // Red / Over budget
  } else if (percent > 80) {
    barColor = '#F59E0B'; // Amber / Warning
  }

  const textColor = theme?.textPrimary ?? '#F8FAFC';
  const mutedColor = theme?.textSecondary ?? '#94A3B8';
  const cardBg = theme?.surfaceVariant ?? '#1E293B';

  return (
    <View
      testID={`budget-bar-${categoryId}`}
      style={[styles.container, { backgroundColor: cardBg }]}
    >
      <View style={styles.header}>
        <View style={styles.categoryInfo}>
          {budget.categoryColorHex ? (
            <View
              style={[
                styles.categoryDot,
                { backgroundColor: budget.categoryColorHex },
              ]}
            />
          ) : null}
          <Text style={[styles.categoryName, { color: textColor }]}>
            {categoryName}
          </Text>
        </View>

        <Text
          testID={`budget-bar-percent-${categoryId}`}
          style={[
            styles.percentText,
            { color: barColor, fontWeight: isOverBudget ? '800' : '600' },
          ]}
        >
          {percent}%
        </Text>
      </View>

      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            {
              width: `${Math.round(clampedRatio * 100)}%`,
              backgroundColor: barColor,
            },
          ]}
        />
      </View>

      <View style={styles.footer}>
        <Text
          testID={`budget-bar-consumed-${categoryId}`}
          style={[styles.amountText, { color: textColor }]}
        >
          {formatCentsToBrl(consumedCents)}
          <Text style={[styles.limitSubText, { color: mutedColor }]}>
            {' '}
            / {formatCentsToBrl(limitCents)}
          </Text>
        </Text>

        <Text
          style={[
            styles.remainingText,
            { color: isOverBudget ? '#F43F5E' : mutedColor },
          ]}
        >
          {isOverBudget
            ? `Excedido em ${formatCentsToBrl(Math.abs(remainingCents))}`
            : `Restam ${formatCentsToBrl(remainingCents)}`}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  categoryInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  categoryDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  categoryName: {
    fontSize: 15,
    fontWeight: '600',
  },
  percentText: {
    fontSize: 14,
  },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#334155',
    overflow: 'hidden',
    marginBottom: 10,
  },
  fill: {
    height: '100%',
    borderRadius: 4,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  amountText: {
    fontSize: 13,
    fontWeight: '600',
  },
  limitSubText: {
    fontSize: 12,
    fontWeight: '400',
  },
  remainingText: {
    fontSize: 12,
    fontWeight: '500',
  },
});
