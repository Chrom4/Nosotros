import { Redirect, useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSessionUIStore } from '@/store/sessionUI';

export default function Index() {
  const router = useRouter();
  const authStatus = useSessionUIStore((s) => s.authStatus);
  const activeHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const memberRole = useSessionUIStore((s) => s.memberRole);
  const userEmail = useSessionUIStore((s) => s.userEmail);

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
    <View style={styles.container}>
      <Text style={styles.title}>No$otros</Text>
      <Text style={styles.subtitle}>
        Sessão ativa: {userEmail ?? ''} ({memberRole ?? 'MEMBRO'})
      </Text>
      {memberRole === 'FOUNDER' ? (
        <Pressable
          style={styles.inviteLink}
          onPress={() => router.push('/(auth)/create-household')}
        >
          <Text style={styles.inviteLinkText}>
            Gerenciar convite do casal (8 caracteres)
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        testID="open-ledger-tabs-button"
        style={[styles.inviteLink, { marginTop: 12 }]}
        onPress={() => router.push('/(tabs)/transactions')}
      >
        <Text style={styles.inviteLinkText}>
          Abrir Contas, Categorias e Lançamentos
        </Text>
      </Pressable>
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
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#94A3B8',
    marginBottom: 20,
  },
  inviteLink: {
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#4F46E5',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  inviteLinkText: {
    color: '#818CF8',
    fontSize: 14,
    fontWeight: '600',
  },
});
