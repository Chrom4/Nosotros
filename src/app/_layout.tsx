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
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  handleAppStateTransitionAsync,
  promptBiometricUnlock,
} from '@/auth/biometricGuard';
import { getBiometricsEnabled } from '@/auth/devicePreferences';
import { ensureLocalSessionReady } from '@/auth/localSession';
import { restoreSessionOnLaunch } from '@/auth/onboardingService';
import { loadPersistedHouseholdContext } from '@/store/householdPersistence';
import { useSessionUIStore } from '@/store/sessionUI';
import { logger } from '@/utils/logger';

export default function RootLayout() {
  const authStatus = useSessionUIStore((s) => s.authStatus);
  const isBiometricLocked = useSessionUIStore((s) => s.isBiometricLocked);
  const dbError = useSessionUIStore((s) => s.dbError);
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
    (async () => {
      try {
        const persisted = await loadPersistedHouseholdContext();
        if (persisted.householdId) {
          useSessionUIStore
            .getState()
            .setHouseholdContext(persisted.householdId, persisted.memberRole);
        }

        const res = await restoreSessionOnLaunch({
          knownHouseholdId: persisted.householdId,
        });
        if (!mounted) return;

        if (res.authenticated) {
          try {
            await ensureLocalSessionReady();
          } catch (e) {
            logger.warn('Database initialization on launch failed', {
              reason: e instanceof Error ? e.message : 'unknown',
            });
          }
          const biometricsOn = await getBiometricsEnabled();
          if (biometricsOn) {
            void triggerUnlock();
          } else {
            useSessionUIStore.getState().unlockBiometrics();
          }
        }
      } catch {
        if (mounted) {
          useSessionUIStore.getState().setSession(null);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [triggerUnlock]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      void (async () => {
        const lockedAfterResume = await handleAppStateTransitionAsync(
          nextState,
          Date.now(),
        );
        if (nextState === 'active' && lockedAfterResume) {
          void triggerUnlock();
        }
      })();
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
        {dbError ? (
          <Text style={styles.errorText} testID="db-init-error">
            {dbError}
          </Text>
        ) : null}
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

  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
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
    marginTop: 8,
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
