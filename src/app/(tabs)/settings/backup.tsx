import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getActiveDatabase, useReactiveQuery } from '@/data';
import * as schema from '@/data/schema';
import { useSessionUIStore } from '@/store';
import {
  clearBackupPassphrase,
  getBackupPassphrase,
  saveBackupPassphrase,
} from '@/sync/backupCrypto';
import {
  createEncryptedBackupFile,
  restoreDatabaseFromBackup,
  type RestoreBackupResult,
} from '@/sync/backupService';
import {
  syncRemindersToCalendar,
  type CalendarEventPayload,
} from '@/sync/googleCalendarClient';
import {
  downloadBackupFromDrive,
  listBackupsFromDrive,
  rotateDriveBackups,
  uploadBackupToDrive,
  type DriveFileMetadata,
} from '@/sync/googleDriveClient';

export default function BackupSettingsScreen() {
  const activeHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const db = getActiveDatabase();

  const [hasStoredPassphrase, setHasStoredPassphrase] = useState<boolean>(false);
  const [passphraseInput, setPassphraseInput] = useState<string>('');
  const [isEditingPassphrase, setIsEditingPassphrase] = useState<boolean>(false);
  const [googleAccessToken, setGoogleAccessToken] = useState<string>('');

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [driveBackups, setDriveBackups] = useState<DriveFileMetadata[]>([]);
  const [lastRestoreResult, setLastRestoreResult] =
    useState<RestoreBackupResult | null>(null);

  // Reactive query on local household to inspect sync_epoch
  const { data: householdList } = useReactiveQuery(
    () =>
      db && activeHouseholdId
        ? db
            .select()
            .from(schema.households)
        : null,
    [db, activeHouseholdId],
  );

  const currentHousehold = householdList?.find((h) => h.id === activeHouseholdId);

  useEffect(() => {
    async function checkPassphrase() {
      try {
        const stored = await getBackupPassphrase();
        setHasStoredPassphrase(Boolean(stored));
      } catch {
        setHasStoredPassphrase(false);
      }
    }
    void checkPassphrase();
  }, []);

  const handleSavePassphrase = async () => {
    if (!passphraseInput || passphraseInput.trim().length < 8) {
      setErrorMessage('A senha de recuperação deve ter pelo menos 8 caracteres.');
      return;
    }

    try {
      setIsLoading(true);
      setErrorMessage(null);
      await saveBackupPassphrase(passphraseInput.trim());
      setHasStoredPassphrase(true);
      setIsEditingPassphrase(false);
      setPassphraseInput('');
      setStatusMessage('Senha de recuperação salva com sucesso no SecureStore.');
    } catch (err: unknown) {
      setErrorMessage(
        `Erro ao salvar senha: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearPassphrase = async () => {
    Alert.alert(
      'Remover Senha',
      'Tem certeza de que deseja remover a senha de recuperação salva?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Remover',
          style: 'destructive',
          onPress: async () => {
            await clearBackupPassphrase();
            setHasStoredPassphrase(false);
            setStatusMessage('Senha de recuperação removida do dispositivo.');
          },
        },
      ],
    );
  };

  const handleBackupNow = async () => {
    if (!db || !activeHouseholdId) {
      setErrorMessage('Nenhum banco ou household ativo selecionado.');
      return;
    }

    const passphrase = (await getBackupPassphrase()) || passphraseInput;
    if (!passphrase) {
      setErrorMessage(
        'Informe a senha de recuperação do casal para criptografar o backup.',
      );
      return;
    }

    try {
      setIsLoading(true);
      setErrorMessage(null);
      setStatusMessage('Gerando snapshot criptografado (PBKDF2 210k + AES-256-GCM)...');

      const { filename, envelope } = await createEncryptedBackupFile(
        db,
        activeHouseholdId,
        passphrase,
      );

      if (googleAccessToken) {
        setStatusMessage('Enviando para Google Drive (appDataFolder)...');
        await uploadBackupToDrive({
          accessToken: googleAccessToken,
          filename,
          content: envelope,
        });

        setStatusMessage('Rotacionando backups no Drive (mantendo últimos 10)...');
        await rotateDriveBackups({
          accessToken: googleAccessToken,
          keepCount: 10,
        });

        setStatusMessage(`Backup concluído e sincronizado com o Drive: ${filename}`);
      } else {
        setStatusMessage(
          `Backup criptografado gerado com sucesso localmente: ${filename} (${envelope.length} bytes). Para enviar à nuvem, insira o token Google.`,
        );
      }
    } catch (err: unknown) {
      setErrorMessage(
        `Falha no backup: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleSyncCalendar = async () => {
    if (!db || !activeHouseholdId) {
      setErrorMessage('Nenhum household ativo.');
      return;
    }
    if (!googleAccessToken) {
      setErrorMessage('Insira o token de acesso do Google para sincronizar a agenda.');
      return;
    }

    try {
      setIsLoading(true);
      setErrorMessage(null);
      setStatusMessage('Buscando vencimentos de faturas e contas recorrentes...');

      const invoices = await db
        .select()
        .from(schema.creditCardInvoices);

      const reminders: CalendarEventPayload[] = invoices.map((inv) => ({
        summary: `Fatura Cartão — Competência ${inv.competenceMonth}`,
        description: `Vencimento da fatura com status ${inv.status}.`,
        dueDate: inv.dueDate,
        nosotrosEventId: `invoice:${inv.id}`,
      }));

      setStatusMessage(`Sincronizando ${reminders.length} lembretes com Google Calendar...`);
      const result = await syncRemindersToCalendar({
        accessToken: googleAccessToken,
        reminders,
      });

      setStatusMessage(
        `Agenda sincronizada! ${result.created} criados, ${result.updated} atualizados (${result.failed} falhas).`,
      );
    } catch (err: unknown) {
      setErrorMessage(
        `Falha na sincronização com Calendar: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleListDriveBackups = async () => {
    if (!googleAccessToken) {
      setErrorMessage('Informe o token de acesso do Google.');
      return;
    }

    try {
      setIsLoading(true);
      setErrorMessage(null);
      const list = await listBackupsFromDrive({
        accessToken: googleAccessToken,
      });
      setDriveBackups(list);
      setStatusMessage(`${list.length} backups encontrados no appDataFolder.`);
    } catch (err: unknown) {
      setErrorMessage(
        `Erro ao listar backups: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestoreFromDrive = async (file: DriveFileMetadata) => {
    if (!db) {
      setErrorMessage('Banco de dados local não disponível.');
      return;
    }

    const passphrase = (await getBackupPassphrase()) || passphraseInput;
    if (!passphrase) {
      setErrorMessage('Informe a senha de recuperação do casal para restaurar.');
      return;
    }

    Alert.alert(
      'Restaurar Backup',
      `Deseja restaurar o backup ${file.name}? O sync_epoch será elevado atomicamente.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Restaurar',
          style: 'destructive',
          onPress: async () => {
            try {
              setIsLoading(true);
              setErrorMessage(null);
              setStatusMessage(`Baixando backup ${file.name}...`);

              const envelope = await downloadBackupFromDrive({
                accessToken: googleAccessToken,
                fileId: file.id,
              });

              setStatusMessage('Descriptografando e restaurando banco local...');
              const result = await restoreDatabaseFromBackup(
                db,
                envelope,
                passphrase,
              );

              setLastRestoreResult(result);
              setStatusMessage(
                `Restauro concluído! Novo sync_epoch: ${result.newSyncEpoch}. Lançamentos: ${result.recordCounts.transactions}.`,
              );
            } catch (err: unknown) {
              setErrorMessage(
                `Falha no restauro: ${err instanceof Error ? err.message : String(err)}`,
              );
            } finally {
              setIsLoading(false);
            }
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Backup Criptografado & Google Drive</Text>
      <Text style={styles.subtitle}>
        Segurança PBKDF2-HMAC-SHA256 (210.000 iterações) + AES-256-GCM. Operação
        100% Offline-First sem bibliotecas proibidas (`googleapis`).
      </Text>

      {/* Household Sync Epoch Badge */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Status do Household</Text>
        <Text style={styles.infoText}>
          Household ID: <Text style={styles.bold}>{activeHouseholdId ?? 'Nenhum'}</Text>
        </Text>
        <Text style={styles.infoText}>
          Sync Epoch Atual: <Text style={styles.bold}>{currentHousehold?.syncEpoch ?? 1}</Text>
        </Text>
      </View>

      {/* Passphrase Section */}
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Senha Mestra do Casal</Text>
          <View
            style={[
              styles.badge,
              hasStoredPassphrase ? styles.badgeSuccess : styles.badgeWarning,
            ]}
          >
            <Text style={styles.badgeText}>
              {hasStoredPassphrase ? 'Configurada' : 'Não Configurada'}
            </Text>
          </View>
        </View>

        <Text style={styles.description}>
          A senha do casal é a chave mestre exclusiva necessária para restaurar backups.
          Ela deriva a chave de 256 bits com 210.000 iterações e salt único por arquivo.
        </Text>

        {isEditingPassphrase || !hasStoredPassphrase ? (
          <View style={styles.inputGroup}>
            <TextInput
              style={styles.input}
              placeholder="Digite a senha de recuperação do casal"
              placeholderTextColor="#94A3B8"
              secureTextEntry
              value={passphraseInput}
              onChangeText={setPassphraseInput}
            />
            <View style={styles.row}>
              <Pressable
                style={[styles.button, styles.buttonPrimary]}
                onPress={handleSavePassphrase}
                disabled={isLoading}
              >
                <Text style={styles.buttonText}>Salvar Senha</Text>
              </Pressable>
              {hasStoredPassphrase && (
                <Pressable
                  style={[styles.button, styles.buttonSecondary]}
                  onPress={() => setIsEditingPassphrase(false)}
                >
                  <Text style={styles.buttonTextSecondary}>Cancelar</Text>
                </Pressable>
              )}
            </View>
          </View>
        ) : (
          <View style={styles.row}>
            <Pressable
              style={[styles.button, styles.buttonSecondary]}
              onPress={() => setIsEditingPassphrase(true)}
            >
              <Text style={styles.buttonTextSecondary}>Alterar Senha</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.buttonDanger]}
              onPress={handleClearPassphrase}
            >
              <Text style={styles.buttonTextDanger}>Remover</Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Google Services Token & Actions */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Integração Google REST (v3)</Text>
        <Text style={styles.description}>
          Conexão direta via REST fetch com Bearer Token (sem pacote node `googleapis`).
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Google OAuth Access Token (opcional para teste local)"
          placeholderTextColor="#94A3B8"
          value={googleAccessToken}
          onChangeText={setGoogleAccessToken}
          autoCapitalize="none"
        />

        <View style={styles.buttonStack}>
          <Pressable
            style={[styles.button, styles.buttonPrimary]}
            onPress={handleBackupNow}
            disabled={isLoading}
          >
            <Text style={styles.buttonText}>Fazer Backup Agora</Text>
          </Pressable>

          <Pressable
            style={[styles.button, styles.buttonSecondary]}
            onPress={handleListDriveBackups}
            disabled={isLoading}
          >
            <Text style={styles.buttonTextSecondary}>Listar Backups no Drive</Text>
          </Pressable>

          <Pressable
            style={[styles.button, styles.buttonAccent]}
            onPress={handleSyncCalendar}
            disabled={isLoading}
          >
            <Text style={styles.buttonText}>Sincronizar Google Agenda</Text>
          </Pressable>
        </View>
      </View>

      {/* Messages */}
      {isLoading && <ActivityIndicator size="small" color="#818CF8" style={styles.loader} />}

      {statusMessage && (
        <View style={styles.statusBox}>
          <Text style={styles.statusText}>{statusMessage}</Text>
        </View>
      )}

      {errorMessage && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      )}

      {/* Restore Result Card */}
      {lastRestoreResult && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Último Restauro Concluído</Text>
          <Text style={styles.infoText}>
            Sync Epoch Anterior: <Text style={styles.bold}>{lastRestoreResult.previousSyncEpoch}</Text> ➔ Novo Sync Epoch: <Text style={styles.bold}>{lastRestoreResult.newSyncEpoch}</Text>
          </Text>
          <Text style={styles.infoText}>
            Lançamentos restaurados: {lastRestoreResult.recordCounts.transactions}
          </Text>
          <Text style={styles.infoText}>
            Contas: {lastRestoreResult.recordCounts.accounts} | Cartões: {lastRestoreResult.recordCounts.creditCards} | Categorias: {lastRestoreResult.recordCounts.categories}
          </Text>
        </View>
      )}

      {/* List of Drive Backups */}
      {driveBackups.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Backups Disponíveis no Drive ({driveBackups.length})</Text>
          <Text style={styles.description}>Toque em um arquivo para restaurar com elevação de sync_epoch.</Text>
          {driveBackups.map((bkp) => (
            <Pressable
              key={bkp.id}
              style={styles.backupItem}
              onPress={() => handleRestoreFromDrive(bkp)}
            >
              <View style={styles.flex1}>
                <Text style={styles.backupName}>{bkp.name}</Text>
                <Text style={styles.backupDate}>
                  Criado em: {bkp.createdTime ?? 'Desconhecido'}
                </Text>
              </View>
              <View style={styles.restoreAction}>
                <Text style={styles.backupSize}>
                  {bkp.size ? `${(bkp.size / 1024).toFixed(1)} KB` : ''}
                </Text>
                <Text style={styles.restoreLink}>Restaurar</Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#F8FAFC',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    color: '#94A3B8',
    marginBottom: 16,
    lineHeight: 18,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#F8FAFC',
    marginBottom: 8,
  },
  description: {
    fontSize: 13,
    color: '#94A3B8',
    marginBottom: 12,
    lineHeight: 18,
  },
  infoText: {
    fontSize: 14,
    color: '#CBD5E1',
    marginBottom: 4,
  },
  bold: {
    fontWeight: '700',
    color: '#818CF8',
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  inputGroup: {
    marginTop: 8,
  },
  input: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#F8FAFC',
    fontSize: 14,
    marginBottom: 10,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeSuccess: {
    backgroundColor: '#065F46',
  },
  badgeWarning: {
    backgroundColor: '#854D0E',
  },
  badgeText: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '600',
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: {
    backgroundColor: '#4F46E5',
  },
  buttonSecondary: {
    backgroundColor: '#334155',
  },
  buttonAccent: {
    backgroundColor: '#059669',
  },
  buttonDanger: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#EF4444',
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  buttonTextSecondary: {
    color: '#E2E8F0',
    fontWeight: '600',
    fontSize: 14,
  },
  buttonTextDanger: {
    color: '#EF4444',
    fontWeight: '600',
    fontSize: 14,
  },
  buttonStack: {
    gap: 10,
    marginTop: 6,
  },
  loader: {
    marginVertical: 12,
  },
  statusBox: {
    backgroundColor: '#064E3B',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#059669',
  },
  statusText: {
    color: '#D1FAE5',
    fontSize: 13,
  },
  errorBox: {
    backgroundColor: '#7F1D1D',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#DC2626',
  },
  errorText: {
    color: '#FEE2E2',
    fontSize: 13,
  },
  backupItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  flex1: {
    flex: 1,
  },
  restoreAction: {
    alignItems: 'flex-end',
  },
  restoreLink: {
    color: '#818CF8',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  backupName: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '500',
  },
  backupDate: {
    color: '#94A3B8',
    fontSize: 12,
  },
  backupSize: {
    color: '#818CF8',
    fontSize: 12,
  },
});
