import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  createHouseholdAsFounder,
  type IssuedPartnerInvite,
  issuePartnerInvite,
} from '@/auth/onboardingService';
import { useSessionUIStore } from '@/store/sessionUI';

export default function CreateHouseholdScreen() {
  const router = useRouter();
  const activeHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);

  const [householdName, setHouseholdName] = useState('Casa Nosotros');
  const [displayName, setDisplayName] = useState('');
  const [partnerEmail, setPartnerEmail] = useState('');
  const [issuedInvite, setIssuedInvite] = useState<IssuedPartnerInvite | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleCreateHousehold = async () => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await createHouseholdAsFounder({
        householdName,
        displayName,
      });
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao criar o lar.',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateInvite = async () => {
    if (!activeHouseholdId) {
      setErrorMessage('Crie o lar primeiro antes de gerar um convite.');
      return;
    }

    setErrorMessage(null);
    setLoading(true);
    try {
      const invite = await issuePartnerInvite({
        householdId: activeHouseholdId,
        invitedEmail: partnerEmail,
      });
      setIssuedInvite(invite);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao gerar convite.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.card}>
        <Text style={styles.title}>Configurar Lar do Casal</Text>
        <Text style={styles.subtitle}>
          Exclusivo para o casal (máximo estrito de 2 membros ativos).
        </Text>

        {errorMessage ? (
          <View style={styles.errorBanner} testID="create-household-error">
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        {!activeHouseholdId ? (
          <>
            <Text style={styles.label}>Nome do Lar</Text>
            <TextInput
              testID="household-name-input"
              style={styles.input}
              value={householdName}
              onChangeText={setHouseholdName}
              placeholder="Ex.: Casa Nosotros"
              placeholderTextColor="#94A3B8"
              editable={!loading}
            />

            <Text style={styles.label}>Seu Nome de Exibição</Text>
            <TextInput
              testID="founder-display-name-input"
              style={styles.input}
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="Ex.: Diogo"
              placeholderTextColor="#94A3B8"
              editable={!loading}
            />

            <Pressable
              testID="create-household-button"
              style={[styles.primaryButton, loading && styles.buttonDisabled]}
              onPress={handleCreateHousehold}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>Criar Lar</Text>
              )}
            </Pressable>

            <Pressable
              testID="go-to-accept-invite-button"
              style={styles.secondaryButton}
              onPress={() => router.push('/(auth)/accept-invite')}
              disabled={loading}
            >
              <Text style={styles.secondaryButtonText}>
                Tenho um código de 8 caracteres para entrar
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.successBox}>
              <Text style={styles.successTitle}>Lar criado com sucesso!</Text>
              <Text style={styles.successSub}>
                Gere um código de 8 caracteres para parear o aparelho da pessoa
                parceira.
              </Text>
            </View>

            <Text style={styles.label}>E-mail da Pessoa Parceira</Text>
            <TextInput
              testID="partner-email-input"
              style={styles.input}
              value={partnerEmail}
              onChangeText={setPartnerEmail}
              placeholder="parceira@exemplo.com"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              keyboardType="email-address"
              editable={!loading}
            />

            <Pressable
              testID="generate-invite-button"
              style={[styles.primaryButton, loading && styles.buttonDisabled]}
              onPress={handleGenerateInvite}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  Gerar Código de Convite (8 caracteres)
                </Text>
              )}
            </Pressable>

            {issuedInvite ? (
              <View style={styles.inviteBox} testID="issued-invite-box">
                <Text style={styles.inviteLabel}>
                  Código para {issuedInvite.invitedEmail} (válido por{' '}
                  {issuedInvite.expiresInHours}h):
                </Text>
                <Text style={styles.inviteCode} testID="issued-invite-code">
                  {issuedInvite.inviteCode}
                </Text>
              </View>
            ) : null}

            <Pressable
              testID="continue-to-home-button"
              style={styles.secondaryButton}
              onPress={() => router.replace('/')}
            >
              <Text style={styles.secondaryButtonText}>Ir para o Início</Text>
            </Pressable>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  container: {
    flexGrow: 1,
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
  successBox: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 18,
  },
  successTitle: {
    color: '#A7F3D0',
    fontWeight: '700',
    fontSize: 15,
    marginBottom: 4,
  },
  successSub: {
    color: '#D1FAE5',
    fontSize: 13,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#CBD5E1',
    marginBottom: 6,
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
    backgroundColor: '#4F46E5',
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
  inviteBox: {
    marginTop: 20,
    backgroundColor: '#0F172A',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#6366F1',
    alignItems: 'center',
  },
  inviteLabel: {
    color: '#94A3B8',
    fontSize: 12,
    marginBottom: 8,
    textAlign: 'center',
  },
  inviteCode: {
    color: '#F8FAFC',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 4,
  },
  secondaryButton: {
    marginTop: 18,
    alignItems: 'center',
    paddingVertical: 8,
  },
  secondaryButtonText: {
    color: '#818CF8',
    fontSize: 14,
    fontWeight: '500',
  },
});
