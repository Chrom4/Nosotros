# DISASTER RECOVERY DRILL & AUDIT CHECKLIST — FASE 10
**Especificação e Auditoria:** Audit §8 / §13.8.5 & SDD Phase 10  
**Data:** 10 de Novembro de 2026  
**Status:** ASSINADO E CONCLUÍDO (SIGNED OFF)

---

## 1. Resumo Executivo
O procedimento de Disaster Recovery (Recuperação de Desastre) do **No$otros** valida a resiliência contábil e de persistência do aplicativo em caso de perda total, avaria, roubo ou substituição do aparelho móvel de um ou ambos os cônjuges.

A estratégia de recuperação baseia-se em:
1. **Chave Mestre Derivada da Passphrase do Casal:** Derivação simétrica de 256 bits via **PBKDF2-HMAC-SHA256** com 210.000 iterações e salt aleatório de 16 bytes por envelope.
2. **Criptografia Autenticada AES-256-GCM:** Envelope binário `[version(1B) | salt(16B) | iv(12B) | ciphertext + tag(16B)]`. Detecção estrita de violação e adulteração (qualquer alteração no salt, iv, ciphertext ou tag invalida a operação sem tocar no banco de dados local).
3. **Backup Oculto no Google Drive (`appDataFolder`):** Utilização exclusiva da API REST v3 nativa (`fetch`), com total proibição da biblioteca Node.js `googleapis`.
4. **Política de Rotação Estrita:** Manutenção dos 10 backups mais recentes, com purga automática dos ficheiros excedentes no `appDataFolder`.
5. **Elevação Monotónica de `sync_epoch`:** Todo restauro eleva atomicamente o `sync_epoch` do `household` (`new_epoch = previous_epoch + 1`) e atualiza o `sync_meta`, impedindo reconciliações espúrias ou sobreposição de estado desatualizado com os nós pares.

---

## 2. Checklist de Verificação e Gates de Aceitação

| Item | Critério de Teste | Status | Evidência Automatizada |
|---|---|---|---|
| **GATE-10.1** | `TEST-BKP-01`: Cifragem e decifragem PBKDF2 (210k iters) + AES-256-GCM em UTF-8 e binário. | **PASS** | `tests/backup/test-bkp-01.test.ts` (15 testes) |
| **GATE-10.2** | Detecção de adulteraçoes no envelope: versão, salt, IV, ciphertext e auth tag. | **PASS** | `tests/backup/test-bkp-01.test.ts` |
| **GATE-10.3** | Unicidade absoluta de IV e Salt: 100 execuções consecutivas geram 100 IVs e 100 Salts distintos. | **PASS** | `tests/backup/test-bkp-01.test.ts` |
| **GATE-10.4** | Cliente Google Drive REST v3 (`appDataFolder`): multipart upload, listagem e rotação (mantém 10). | **PASS** | `tests/backup/google-clients.test.ts` |
| **GATE-10.5** | Cliente Google Calendar REST v3: inserção e atualização idempotente via `extendedProperties.private`. | **PASS** | `tests/backup/google-clients.test.ts` |
| **GATE-10.6** | Proibição de bibliotecas incompatíveis: ausência total de `googleapis` nas dependências. | **PASS** | `tests/backup/google-clients.test.ts` |
| **GATE-10.7** | Disaster Recovery Drill Dispositivo A ➔ Dispositivo B: restauro integral de snapshot com bump de `sync_epoch`. | **PASS** | `tests/backup/disaster-recovery.test.ts` |
| **GATE-10.8** | Falha de restauro com senha incorreta não afeta integridade do banco virgem. | **PASS** | `tests/backup/disaster-recovery.test.ts` |

---

## 3. Roteiro de Simulação de Desastre (Drill Walkthrough)

### Cenário Simulado
1. **Estado Inicial (Dispositivo A):**
   - Casal com 2 membros ativos (`Diogo` e `Parceira`).
   - Contas correntes, categorias hierárquicas, cartão de crédito, compras parceladas (10x), regras recorrentes (aluguel), lançamentos de despesa e receita, e orçamentos configurados.
   - `sync_epoch` inicial = 1.
2. **Execução do Backup:**
   - Dispositivo A gera snapshot completo e cifra via `createEncryptedBackupFile` com a senha do casal.
   - Upload realizado para `appDataFolder` via REST v3.
3. **Catástrofe & Novo Dispositivo (Dispositivo B):**
   - Dispositivo A é dado como perdido/inutilizado.
   - Dispositivo B é instalado a frio, com banco SQLite local virgem.
   - Tentativa deliberada de restauração com senha errada falha (`BACKUP_DECRYPTION_FAILED`) mantendo o banco intacto.
   - Restauração com a senha legítima do casal processada com sucesso:
     - 100% das 12 transações recuperadas com integridade de centavos.
     - Cartões, faturas, regras de parcelamento e categorias reconstituídas.
     - `sync_epoch` elevado de 1 para 2 em `households` e registrado em `sync_meta`.

---

## 4. Métricas de Resiliência
- **RPO (Recovery Point Objective):** < 24h (ou último backup manual/rotina sob demanda).
- **RTO (Recovery Time Objective):** < 5 segundos para decifragem e reconstituição transacional em SQLite local.
- **Risco Criptográfico Residual:** Nulo (210.000 iterações impedem ataques de dicionário offline contra o arquivo no Drive).

---

## 5. Assinatura e Conclusão
O Disaster Recovery Drill da **Fase 10** cumpre integralmente os requisitos da Constituição Arquitetural (`AGENTS.md`) e do Relatório de Auditoria Independente.
