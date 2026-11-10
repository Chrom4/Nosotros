import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { acceptPartnerInviteCode } from '@/auth/onboardingService';

export default function AcceptInviteScreen() {
  const router = useRouter();
  const [inviteCode, setInviteCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleAcceptInvite = async () => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await acceptPartnerInviteCode({
        inviteCode,
        displayName,
      });
      router.replace('/');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao aceitar convite.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Aceitar Convite do Casal</Text>
        <Text style={styles.subtitle}>
          Digite o código de 8 caracteres gerado no aparelho da pessoa parceira.
        </Text>

        {errorMessage ? (
          <View style={styles.errorBanner} testID="accept-invite-error">
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Código de Convite (8 caracteres)</Text>
        <TextInput
          testID="accept-invite-code-input"
          style={styles.codeInput}
          value={inviteCode}
          onChangeText={(text) => setInviteCode(text.toUpperCase())}
          placeholder="ABCD2345"
          placeholderTextColor="#64748B"
          autoCapitalize="characters"
          maxLength={10}
          editable={!loading}
        />

        <Text style={styles.label}>Seu Nome de Exibição</Text>
        <TextInput
          testID="partner-display-name-input"
          style={styles.input}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Ex.: Ana"
          placeholderTextColor="#94A3B8"
          editable={!loading}
        />

        <Pressable
          testID="accept-invite-submit-button"
          style={[styles.primaryButton, loading && styles.buttonDisabled]}
          onPress={handleAcceptInvite}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryButtonText}>Parear e Entrar no Lar</Text>
          )}
        </Pressable>

        <Pressable
          testID="back-to-create-household-button"
          style={styles.secondaryButton}
          onPress={() => router.back()}
          disabled={loading}
        >
          <Text style={styles.secondaryButtonText}>
            Voltar para criação de lar
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#334155',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    color: '#94A3B8',
    marginBottom: 20,
  },
  errorBanner: {
    backgroundColor: '#3F1D2E',
    borderColor: '#F43F5E',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: '#FDA4AF',
    fontSize: 13,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#CBD5E1',
    marginBottom: 6,
  },
  codeInput: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#6366F1',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 3,
    textAlign: 'center',
    marginBottom: 16,
  },
  input: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#F8FAFC',
    fontSize: 15,
    marginBottom: 16,
  },
  primaryButton: {
    backgroundColor: '#EC4899',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryButton: {
    marginTop: 16,
    alignItems: 'center',
    paddingVertical: 8,
  },
  secondaryButtonText: {
    color: '#818CF8',
    fontSize: 14,
    fontWeight: '500',
  },
});
