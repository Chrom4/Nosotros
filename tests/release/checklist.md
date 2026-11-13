# Checklist de Release de Produção — No$otros Mobile (Fase 11–12)

**Data de Validação:** 12 de Novembro de 2026  
**Versão:** 1.0.0 (Build 1)  
**Pacote Android:** `com.nosotros.app`  

---

## 1. Verificações de Hardening & Segurança

- [x] **Auditoria de Logs Sensíveis:** `./scripts/check-no-sensitive-logs.sh` cobre `console.log|info|debug|dir|warn|error` em `src/` e chamações de `logger.*` com chaves sensíveis óbvias.
- [x] **Bloqueio de Chave `service_role`:** Cliente Supabase em `src/auth/supabaseClient.ts` rejeita inicialização com JWT `service_role`.
- [x] **Lista de Dependências Proibidas:** `googleapis`, `@powersync/*` e `@shopify/react-native-skia` ausentes do `package.json` / `yarn.lock`.
- [x] **Criptografia Local:** SQLite + SQLCipher (`useSQLCipher: true`) com chave AES-256 em `expo-secure-store`.
- [x] **Backup Externo Seguro:** AES-256-GCM + PBKDF2-HMAC-SHA256 (210k) com salt/IV aleatórios; OAuth via `@react-native-google-signin/google-signin` + REST fetch.
- [x] **Biometria:** DEC-03 com preferência ligada/desligada em Ajustes.

---

## 2. Qualidade de Código e Testes Automatizados

- [ ] **Suíte de Testes Automatizados (`yarn test`):** Revalidar contagem após Onda 4 (`tests/sync`). Não afirmar “107/107” sem rerun atual.
- [ ] **Tipagem Estrita (`yarn typecheck`):** Deve passar em CI/local antes do build EAS.
- [ ] **Linter (`yarn lint`):** Deve passar sem erros (warnings de unused devem ser zerados).

---

## 3. Integridade Contábil e Regras de Negócio

- [x] **Valores Monetários em Centavos:** Inteiros positivos (`amount_cents > 0`).
- [x] **Invariantes de Ponteiros Contábeis:** Cobertos por `src/core` + testes de Fase 6/7.
- [x] **Divisão de Parcelas:** Resto na 1ª parcela.
- [x] **Deduplicação de Recorrências:** UUIDv5 por regra + competência.
- [x] **Tombstone Precedence:** Soft-delete apenas em tabelas sincronizadas.

---

## 4. Sincronização Offline-First (Fase 4)

- [x] **RPCs** `sync_push_batch` / `sync_pull_changes` em `supabase/migrations/0004_sync_rpcs.sql` (aplicar no projeto Supabase remoto ainda é passo operacional).
- [x] **Cliente** `src/sync/syncEngine.ts` com NetInfo, IN_FLIGHT→PENDING no boot, indicador `SyncStatusBanner`.
- [x] **Suite** `tests/sync` (TEST-SYNC-A..GH) verde contra gateway em memória.

> Aplicar a migration `0004` no Supabase do casal e validar smoke A↔B nos aparelhos antes do release.

---

## 5. Configuração EAS & Prontidão para Build

- [x] **`app.json`:** package `com.nosotros.app`, biometria, SQLCipher, Expo Router.
- [x] **`eas.json`:** profiles `preview` (APK) e `production` (AAB).
- [x] **Scripts:** `yarn build:preview`, `yarn build:prod`, `yarn security:audit`.

---

## 6. Sinalização Final para Release

| Etapa | Responsável | Status |
|---|---|---|
| Auditoria de Segurança & Logs | Engenharia | 🟡 PARCIAL (script ok; revalidar em CI) |
| Validação Contábil & Testes | QA / Test Suite | 🟡 AGUARDANDO rerun + Fase 4 |
| Sync Offline-First (2 aparelhos) | Engenharia | 🟡 Código + testes ok; falta `db push` + smoke nos aparelhos |
| Assinatura e Build EAS | EAS Cloud / Local | 🟡 PRONTO APÓS gates verdes |
| Pareamento & Smoke Test nos Aparelhos | Casal | ⏳ AGUARDANDO |
