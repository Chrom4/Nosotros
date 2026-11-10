import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { OwnershipFilter } from '@/core';
import {
  type ContextMode,
  type MD3ContextTheme,
  resolveContextMode,
} from '@/theme';

export interface ContextPillsProps {
  currentUserId: string | null;
  partnerUserId: string | null;
  partnerName?: string | null;
  activeFilter: OwnershipFilter;
  onSelectFilter: (filter: OwnershipFilter) => void;
  theme: MD3ContextTheme;
}

interface PillConfig {
  mode: ContextMode;
  label: string;
  testID: string;
  filter: OwnershipFilter;
  disabled?: boolean;
}

export const ContextPills: React.FC<ContextPillsProps> = ({
  currentUserId,
  partnerUserId,
  partnerName,
  activeFilter,
  onSelectFilter,
  theme,
}) => {
  const activeMode = resolveContextMode(activeFilter, currentUserId);

  const pills: PillConfig[] = [
    {
      mode: 'CONSOLIDATED',
      label: 'Geral',
      testID: 'context-pill-consolidated',
      filter: { mode: 'CONSOLIDATED' },
    },
    {
      mode: 'MINE',
      label: 'Meu',
      testID: 'context-pill-mine',
      filter: currentUserId
        ? { mode: 'USER', userId: currentUserId }
        : { mode: 'CONSOLIDATED' },
      disabled: !currentUserId,
    },
    {
      mode: 'PARTNER',
      label: partnerName ? partnerName : 'Parceiro(a)',
      testID: 'context-pill-partner',
      filter: partnerUserId
        ? { mode: 'USER', userId: partnerUserId }
        : { mode: 'CONSOLIDATED' },
      disabled: !partnerUserId,
    },
    {
      mode: 'DOMESTIC',
      label: 'Casa',
      testID: 'context-pill-domestic',
      filter: { mode: 'DOMESTIC' },
    },
  ];

  return (
    <View testID="context-pills-container" style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {pills.map((pill) => {
          const isActive = activeMode === pill.mode;
          const isDisabled = !!pill.disabled;

          return (
            <Pressable
              key={pill.mode}
              testID={pill.testID}
              disabled={isDisabled}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive, disabled: isDisabled }}
              onPress={() => !isDisabled && onSelectFilter(pill.filter)}
              style={[
                styles.pill,
                isActive
                  ? {
                      backgroundColor: theme.primary,
                      borderColor: theme.primary,
                    }
                  : {
                      backgroundColor: theme.surfaceVariant,
                      borderColor: '#334155',
                    },
                isDisabled && styles.pillDisabled,
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  isActive
                    ? { color: theme.onPrimary, fontWeight: '700' }
                    : { color: theme.textSecondary },
                  isDisabled && styles.pillTextDisabled,
                ]}
              >
                {pill.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingVertical: 8,
  },
  scrollContent: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    gap: 8,
  },
  pill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillDisabled: {
    opacity: 0.4,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
  },
  pillTextDisabled: {
    color: '#64748B',
  },
});
