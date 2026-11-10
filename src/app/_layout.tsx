import { Stack } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  handleAppStateTransition,
  promptBiometricUnlock,
} from '@/auth/biometricGuard';
import { restoreSessionOnLaunch } from '@/auth/onboardingService';
import { useSessionUIStore } from '@/store/sessionUI';

export default function RootLayout() {
  const authStatus = useSessionUIStore((s) => s.authStatus);
  const isBiometricLocked = useSessionUIStore((s) => s.isBiometricLocked);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const triggerUnlock = useCallback(async () => {
    setUnlocking(true);
    setUnlockError(null);
    try {
      const outcome = await promptBiometricUnlock();
      if (!outcome.unlocked) {
        setUnlockError(
          'Autenticação biométrica ou PIN necessária para acessar seus dados financeiros.',
        );
      }
    } finally {
      setUnlocking(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    restoreSessionOnLaunch()
      .then((res) => {
        if (mounted && res.authenticated) {
          void triggerUnlock();
        }
      })
      .catch(() => {
        if (mounted) {
          useSessionUIStore.getState().setSession(null);
        }
      });

    return () => {
      mounted = false;
    };
  }, [triggerUnlock]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const lockedAfterResume = handleAppStateTransition(nextState, Date.now());
      if (nextState === 'active' && lockedAfterResume) {
        void triggerUnlock();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [triggerUnlock]);

  if (authStatus === 'INITIALIZING') {
    return (
      <View style={styles.centerContainer} testID="auth-initializing-screen">
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Carregando cofre criptografado...</Text>
      </View>
    );
  }

  if (authStatus === 'AUTHENTICATED' && isBiometricLocked) {
    return (
      <View style={styles.centerContainer} testID="biometric-lock-gate">
        <View style={styles.lockCard}>
          <Text style={styles.lockTitle}>Cofre Bloqueado</Text>
          <Text style={styles.lockSubtitle}>
            Por segurança (DEC-03), confirme sua biometria ou PIN do aparelho
            para visualizar as finanças do casal.
          </Text>

          {unlockError ? (
            <Text style={styles.errorText} testID="biometric-lock-error">
              {unlockError}
            </Text>
          ) : null}

          <Pressable
            testID="biometric-unlock-button"
            style={[styles.unlockButton, unlocking && styles.buttonDisabled]}
            onPress={triggerUnlock}
            disabled={unlocking}
          >
            <Text style={styles.unlockButtonText}>
              {unlocking ? 'Verificando...' : 'Desbloquear com Biometria / PIN'}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

const styles = StyleSheet.create({
  centerContainer: {
    flex: 1,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    color: '#94A3B8',
    fontSize: 14,
  },
  lockCard: {
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#334155',
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
  },
  lockTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 8,
  },
  lockSubtitle: {
    fontSize: 14,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  errorText: {
    color: '#FDA4AF',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 16,
  },
  unlockButton: {
    backgroundColor: '#4F46E5',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 20,
    width: '100%',
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  unlockButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
