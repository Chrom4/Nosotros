import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSyncStatusStore } from '@/store/syncStatus';
import { colors, spacing } from '@/theme';
import { getActiveSyncEngine } from '@/sync/syncEngine';

/**
 * Compact outbox / connectivity indicator for the tabs shell.
 */
export function SyncStatusBanner() {
  const syncStatus = useSyncStatusStore((s) => s.syncStatus);
  const pendingCount = useSyncStatusStore((s) => s.pendingCount);
  const failedCount = useSyncStatusStore((s) => s.failedCount);
  const lastError = useSyncStatusStore((s) => s.lastError);

  if (
    syncStatus === 'IDLE' &&
    pendingCount === 0 &&
    failedCount === 0 &&
    !lastError
  ) {
    return null;
  }

  const label =
    syncStatus === 'SYNCING'
      ? 'Sincronizando…'
      : syncStatus === 'OFFLINE'
        ? `Offline · ${pendingCount} pendente(s)`
        : syncStatus === 'ERROR'
          ? `Erro de sync${pendingCount ? ` · ${pendingCount} pendente(s)` : ''}`
          : pendingCount > 0
            ? `${pendingCount} alteração(ões) aguardando sync`
            : failedCount > 0
              ? `${failedCount} falha(s) permanente(s)`
              : 'Sincronizado';

  return (
    <Pressable
      style={[
        styles.banner,
        syncStatus === 'ERROR' && styles.bannerError,
        syncStatus === 'OFFLINE' && styles.bannerOffline,
        syncStatus === 'SYNCING' && styles.bannerSyncing,
      ]}
      onPress={() => {
        void getActiveSyncEngine()?.syncNow();
      }}
      testID="sync-status-banner"
    >
      <View>
        <Text style={styles.label}>{label}</Text>
        {lastError ? (
          <Text style={styles.error} numberOfLines={1}>
            {lastError}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.surfaceElevated,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bannerSyncing: {
    borderBottomColor: colors.accentSoft,
  },
  bannerOffline: {
    borderBottomColor: colors.warning,
  },
  bannerError: {
    backgroundColor: colors.dangerContainer,
    borderBottomColor: colors.danger,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  error: {
    color: colors.dangerSoft,
    fontSize: 11,
    marginTop: 2,
  },
});
