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
import {
  loginWithEmailPassword,
  signUpWithEmailPassword,
} from '@/auth/onboardingService';
import { useSessionUIStore } from '@/store/sessionUI';

export default function LoginScreen() {
  const router = useRouter();
  const revocationNotice = useSessionUIStore((s) => s.revocationNotice);
  const authError = useSessionUIStore((s) => s.authError);

  const [mode, setMode] = useState<'LOGIN' | 'SIGNUP'>('LOGIN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setLocalError('Informe um endereço de e-mail válido.');
      return;
    }
    if (password.length < 6) {
      setLocalError('A senha deve conter pelo menos 6 caracteres.');
      return;
    }

    setLocalError(null);
    setSubmitting(true);
    try {
      if (mode === 'LOGIN') {
        await loginWithEmailPassword({ email: trimmedEmail, password });
      } else {
        await signUpWithEmailPassword({ email: trimmedEmail, password });
      }

      const activeHouseholdId = useSessionUIStore.getState().activeHouseholdId;
      if (activeHouseholdId) {
        router.replace('/');
      } else {
        router.replace('/(auth)/create-household');
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Não foi possível autenticar. Verifique suas credenciais.';
      setLocalError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const displayedError = localError ?? authError;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.brand}>No$otros</Text>
        <Text style={styles.subtitle}>
          Gestão financeira compartilhada e 100% Offline-First para o casal
        </Text>

        {revocationNotice ? (
          <View style={styles.revocationBanner} testID="revocation-banner">
            <Text style={styles.revocationText}>{revocationNotice}</Text>
          </View>
        ) : null}

        {displayedError ? (
          <View style={styles.errorBanner} testID="auth-error-banner">
            <Text style={styles.errorText}>{displayedError}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>E-mail</Text>
        <TextInput
          testID="login-email-input"
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="voce@exemplo.com"
          placeholderTextColor="#94A3B8"
          autoCapitalize="none"
          keyboardType="email-address"
          editable={!submitting}
        />

        <Text style={styles.label}>Senha</Text>
        <TextInput
          testID="login-password-input"
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Mínimo de 6 caracteres"
          placeholderTextColor="#94A3B8"
          secureTextEntry
          editable={!submitting}
        />

        <Pressable
          testID="login-submit-button"
          style={[styles.primaryButton, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryButtonText}>
              {mode === 'LOGIN' ? 'Entrar' : 'Criar Conta'}
            </Text>
          )}
        </Pressable>

        <Pressable
          testID="login-toggle-mode-button"
          style={styles.secondaryButton}
          onPress={() => {
            setLocalError(null);
            setMode((prev) => (prev === 'LOGIN' ? 'SIGNUP' : 'LOGIN'));
          }}
          disabled={submitting}
        >
          <Text style={styles.secondaryButtonText}>
            {mode === 'LOGIN'
              ? 'Ainda não tem conta? Cadastre-se'
              : 'Já possui conta? Faça login'}
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
  brand: {
    fontSize: 28,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: '#94A3B8',
    marginBottom: 20,
    lineHeight: 20,
  },
  revocationBanner: {
    backgroundColor: '#450A0A',
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  revocationText: {
    color: '#FCA5A5',
    fontSize: 13,
    lineHeight: 18,
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
    marginTop: 4,
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
