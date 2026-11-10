import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { HouseholdContributionSummary } from '@/core';
import { formatCentsToBrl } from '@/store';
import type { MD3ContextTheme } from '@/theme';

export interface ContributionCardProps {
  summary: HouseholdContributionSummary | null;
  currentUserId?: string | null;
  memberNames?: Record<string, string>;
  theme?: MD3ContextTheme;
}

export const ContributionCard: React.FC<ContributionCardProps> = ({
  summary,
  currentUserId,
  memberNames = {},
  theme,
}) => {
  const cardBg = theme?.surfaceVariant ?? '#1E293B';
  const textColor = theme?.textPrimary ?? '#F8FAFC';
  const mutedColor = theme?.textSecondary ?? '#94A3B8';
  const accentColor = theme?.accent ?? '#818CF8';

  if (!summary || summary.members.length < 2) {
    return (
      <View
        testID="contribution-card"
        style={[styles.container, { backgroundColor: cardBg }]}
      >
        <Text style={[styles.title, { color: textColor }]}>
          Aportes da Casa (DEC-02)
        </Text>
        <Text style={[styles.emptyText, { color: mutedColor }]}>
          Aguardando parceiro(a) no Household para calcular proporção de contribuições.
        </Text>
      </View>
    );
  }

  const [memberA, memberB] = summary.members;
  const nameA =
    memberNames[memberA.userId] ??
    (memberA.userId === currentUserId ? 'Você' : 'Membro 1');
  const nameB =
    memberNames[memberB.userId] ??
    (memberB.userId === currentUserId ? 'Você' : 'Parceiro(a)');

  // Split percentages for visual bar
  const pctA = Math.round(memberA.sharePercentage);
  const pctB = Math.round(memberB.sharePercentage);

  return (
    <View
      testID="contribution-card"
      style={[styles.container, { backgroundColor: cardBg }]}
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: textColor }]}>
          Aportes da Casa (DEC-02)
        </Text>
        <Text
          testID="contribution-total"
          style={[styles.totalAmount, { color: accentColor }]}
        >
          {formatCentsToBrl(summary.totalContributionCents)}
        </Text>
      </View>

      {/* Two-segment Split Bar */}
      <View style={styles.splitBar}>
        <View
          style={[
            styles.segmentA,
            {
              width: `${summary.totalContributionCents > 0 ? pctA : 50}%`,
              backgroundColor: '#0EA5E9', // Sky
            },
          ]}
        />
        <View
          style={[
            styles.segmentB,
            {
              width: `${summary.totalContributionCents > 0 ? pctB : 50}%`,
              backgroundColor: '#10B981', // Emerald
            },
          ]}
        />
      </View>

      <View style={styles.membersRow}>
        {/* Member A */}
        <View
          testID="contribution-member-0"
          style={[styles.memberCard, { borderLeftColor: '#0EA5E9' }]}
        >
          <View style={styles.memberNameRow}>
            <View style={[styles.colorDot, { backgroundColor: '#0EA5E9' }]} />
            <Text style={[styles.memberName, { color: textColor }]}>
              {nameA}
            </Text>
            <Text style={[styles.memberPercent, { color: '#0EA5E9' }]}>
              {pctA}%
            </Text>
          </View>
          <Text style={[styles.memberTotal, { color: textColor }]}>
            {formatCentsToBrl(memberA.totalContributionCents)}
          </Text>
          <View style={styles.breakdownSub}>
            <Text style={[styles.subDetail, { color: mutedColor }]}>
              Aportes: {formatCentsToBrl(memberA.explicitTransferCents)}
            </Text>
            <Text style={[styles.subDetail, { color: mutedColor }]}>
              Desp. pagas: {formatCentsToBrl(memberA.directDomesticExpenseCents)}
            </Text>
          </View>
        </View>

        {/* Member B */}
        <View
          testID="contribution-member-1"
          style={[styles.memberCard, { borderLeftColor: '#10B981' }]}
        >
          <View style={styles.memberNameRow}>
            <View style={[styles.colorDot, { backgroundColor: '#10B981' }]} />
            <Text style={[styles.memberName, { color: textColor }]}>
              {nameB}
            </Text>
            <Text style={[styles.memberPercent, { color: '#10B981' }]}>
              {pctB}%
            </Text>
          </View>
          <Text style={[styles.memberTotal, { color: textColor }]}>
            {formatCentsToBrl(memberB.totalContributionCents)}
          </Text>
          <View style={styles.breakdownSub}>
            <Text style={[styles.subDetail, { color: mutedColor }]}>
              Aportes: {formatCentsToBrl(memberB.explicitTransferCents)}
            </Text>
            <Text style={[styles.subDetail, { color: mutedColor }]}>
              Desp. pagas: {formatCentsToBrl(memberB.directDomesticExpenseCents)}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
  },
  totalAmount: {
    fontSize: 16,
    fontWeight: '700',
  },
  emptyText: {
    fontSize: 13,
    marginTop: 4,
  },
  splitBar: {
    height: 10,
    borderRadius: 5,
    backgroundColor: '#334155',
    flexDirection: 'row',
    overflow: 'hidden',
    marginBottom: 14,
  },
  segmentA: {
    height: '100%',
  },
  segmentB: {
    height: '100%',
  },
  membersRow: {
    flexDirection: 'row',
    gap: 10,
  },
  memberCard: {
    flex: 1,
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 10,
    borderLeftWidth: 3,
  },
  memberNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  colorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  memberName: {
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  memberPercent: {
    fontSize: 12,
    fontWeight: '700',
  },
  memberTotal: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 6,
  },
  breakdownSub: {
    gap: 2,
  },
  subDetail: {
    fontSize: 10,
  },
});
