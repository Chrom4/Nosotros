import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSessionUIStore } from '@/store/sessionUI';

/**
 * Distinguishes vault loading / vault error / missing household for list screens.
 */
export function SessionGateBanner() {
  const dbReady = useSessionUIStore((s) => s.dbReady);
  const dbError = useSessionUIStore((s) => s.dbError);
  const householdId = useSessionUIStore((s) => s.activeHouseholdId);

  if (dbError) {
    return (
      <View style={styles.errorBanner} testID="session-db-error-banner">
        <Text style={styles.errorText}>{dbError}</Text>
      </View>
    );
  }

  if (!dbReady) {
    return (
      <View style={styles.loadingBanner} testID="session-db-loading-banner">
        <ActivityIndicator color="#818CF8" size="small" />
        <Text style={styles.loadingText}>Abrindo cofre criptografado...</Text>
      </View>
    );
  }

  if (!householdId) {
    return (
      <View style={styles.warnBanner} testID="session-no-household-banner">
        <Text style={styles.warnText}>
          Nenhum lar ativo. Conclua o onboarding do casal para continuar.
        </Text>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  loadingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#1E293B',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  loadingText: {
    color: '#94A3B8',
    fontSize: 13,
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
  warnBanner: {
    backgroundColor: '#422006',
    borderColor: '#F59E0B',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  warnText: {
    color: '#FCD34D',
    fontSize: 13,
  },
});
