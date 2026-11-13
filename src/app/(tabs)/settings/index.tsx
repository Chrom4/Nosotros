import { and, eq, isNull } from 'drizzle-orm';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getBiometricsEnabled,
  logoutCurrentUser,
  revokePartnerAccess,
  setBiometricsEnabled,
} from '@/auth';
import { householdMembers, useActiveDatabase, useReactiveQuery } from '@/data';
import { useSessionUIStore } from '@/store';
import { colors, radii, spacing } from '@/theme';
import { logger } from '@/utils/logger';

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const db = useActiveDatabase();
  const userId = useSessionUIStore((s) => s.userId);
  const userEmail = useSessionUIStore((s) => s.userEmail);
  const activeHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const memberRole = useSessionUIStore((s) => s.memberRole);
  const unlockBiometrics = useSessionUIStore((s) => s.unlockBiometrics);

  const [biometricsOn, setBiometricsOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: members = [] } = useReactiveQuery(
    () =>
      db && activeHouseholdId
        ? db
            .select()
            .from(householdMembers)
            .where(
              and(
                eq(householdMembers.householdId, activeHouseholdId),
                isNull(householdMembers.revokedAt),
              ),
            )
        : null,
    [db, activeHouseholdId],
  );

  const partner = useMemo(
    () => members.find((m) => m.userId !== userId && m.revokedAt === null) ?? null,
    [members, userId],
  );

  useEffect(() => {
    let mounted = true;
    void getBiometricsEnabled().then((enabled) => {
      if (mounted) {
        setBiometricsOn(enabled);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const handleBiometricsToggle = useCallback(async (next: boolean) => {
    setBiometricsOn(next);
    await setBiometricsEnabled(next);
    if (!next) {
      unlockBiometrics();
    }
  }, [unlockBiometrics]);

  const handleLogout = useCallback(() => {
    Alert.alert(
      'Sair da conta',
      'Você sairá do No$otros neste aparelho. Os dados criptografados locais permanecem até uma revogação ou limpeza manual.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Sair',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            setErrorMessage(null);
            try {
              await logoutCurrentUser();
              router.replace('/(auth)/login');
            } catch (err) {
              logger.warn('Logout failed', {
                reason: err instanceof Error ? err.message : 'unknown',
              });
              setErrorMessage(
                err instanceof Error ? err.message : 'Falha ao sair da conta.',
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [router]);

  const handleRevokePartner = useCallback(() => {
    if (!activeHouseholdId || !partner || memberRole !== 'FOUNDER') {
      return;
    }

    Alert.alert(
      'Revogar parceiro(a)',
      `Remover ${partner.displayName} do lar? O aparelho do parceiro fará crypto-shred dos dados locais na próxima verificação.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Revogar',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            setErrorMessage(null);
            try {
              await revokePartnerAccess({
                householdId: activeHouseholdId,
                targetUserId: partner.userId,
              });
              Alert.alert('Parceiro(a) revogado(a)', 'Acesso removido com sucesso.');
            } catch (err) {
              setErrorMessage(
                err instanceof Error
                  ? err.message
                  : 'Falha ao revogar o parceiro.',
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [activeHouseholdId, memberRole, partner]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: Math.max(insets.bottom, 24) },
      ]}
      testID="settings-screen"
    >
      <Text style={styles.title}>Ajustes</Text>
      <Text style={styles.subtitle}>
        Conta, segurança do cofre e gestão do lar.
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Conta</Text>
        <Text style={styles.infoText}>
          E-mail: <Text style={styles.bold}>{userEmail ?? '—'}</Text>
        </Text>
        <Text style={styles.infoText}>
          Papel:{' '}
          <Text style={styles.bold}>
            {memberRole === 'FOUNDER' ? 'Fundador(a)' : 'Parceiro(a)'}
          </Text>
        </Text>
        <Pressable
          style={[styles.button, styles.buttonDanger]}
          onPress={handleLogout}
          disabled={busy}
          testID="settings-logout-button"
        >
          <Text style={styles.buttonTextDanger}>Sair da conta</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Biometria (DEC-03)</Text>
        <Text style={styles.description}>
          Bloqueia o app após 2 minutos em segundo plano. Desative apenas se o
          aparelho for de uso exclusivo do casal.
        </Text>
        <View style={styles.rowBetween}>
          <Text style={styles.infoText}>Bloqueio biométrico</Text>
          <Switch
            value={biometricsOn}
            onValueChange={(v) => {
              void handleBiometricsToggle(v);
            }}
            testID="settings-biometrics-switch"
          />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Backup & Google</Text>
        <Text style={styles.description}>
          Exportação AES-256-GCM para o Google Drive (appDataFolder) e lembretes
          na Agenda.
        </Text>
        <Pressable
          style={[styles.button, styles.buttonPrimary]}
          onPress={() => router.push('/(tabs)/settings/backup')}
          testID="settings-open-backup-button"
        >
          <Text style={styles.buttonText}>Abrir Backup</Text>
        </Pressable>
      </View>

      {memberRole === 'FOUNDER' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Parceiro do lar</Text>
          {partner ? (
            <>
              <Text style={styles.infoText}>
                {partner.displayName}{' '}
                <Text style={styles.muted}>({partner.role})</Text>
              </Text>
              <Pressable
                style={[styles.button, styles.buttonDanger]}
                onPress={handleRevokePartner}
                disabled={busy}
                testID="settings-revoke-partner-button"
              >
                <Text style={styles.buttonTextDanger}>Revogar acesso</Text>
              </Pressable>
            </>
          ) : (
            <Text style={styles.description}>
              Nenhum parceiro ativo. Convide pela tela de criação do lar.
            </Text>
          )}
        </View>
      ) : null}

      {busy ? (
        <ActivityIndicator color="#818CF8" style={{ marginTop: 12 }} />
      ) : null}
      {errorMessage ? (
        <Text style={styles.errorText} testID="settings-error">
          {errorMessage}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  card: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: 10,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  description: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
  },
  infoText: {
    fontSize: 14,
    color: '#CBD5E1',
  },
  bold: {
    fontWeight: '700',
    color: colors.textPrimary,
  },
  muted: {
    color: colors.textFaint,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  button: {
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  buttonPrimary: {
    backgroundColor: colors.accent,
  },
  buttonDanger: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.danger,
  },
  buttonText: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  buttonTextDanger: {
    color: colors.dangerSoft,
    fontWeight: '600',
  },
  errorText: {
    color: colors.dangerSoft,
    fontSize: 13,
  },
});
