import { Redirect } from 'expo-router';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSessionUIStore } from '@/store/sessionUI';

/**
 * Root index: auth/household gate only. Ledger UI lives under /(tabs).
 */
export default function Index() {
  const authStatus = useSessionUIStore((s) => s.authStatus);
  const activeHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);

  if (authStatus === 'UNAUTHENTICATED') {
    return <Redirect href="/(auth)/login" />;
  }

  if (authStatus === 'AUTHENTICATED' && !activeHouseholdId) {
    return <Redirect href="/(auth)/create-household" />;
  }

  if (authStatus === 'AUTHENTICATED' && activeHouseholdId) {
    return <Redirect href="/(tabs)" />;
  }

  return (
    <View style={styles.container} testID="root-index-initializing">
      <ActivityIndicator size="large" color="#4F46E5" />
      <Text style={styles.subtitle}>Preparando sessão...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  subtitle: {
    marginTop: 12,
    fontSize: 14,
    color: '#94A3B8',
  },
});
