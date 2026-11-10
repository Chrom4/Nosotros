# Checklist de Release de Produção — No$otros Mobile (Fase 11–12)

**Data de Validação:** 10 de Novembro de 2026  
**Versão:** 1.0.0 (Build 1)  
**Pacote Android:** `com.nosotros.app`  

---

## 1. Verificações de Hardening & Segurança

- [x] **Auditoria de Logs Sensíveis:** Nenhuma chamada crua de `console.log` com payloads financeiros, tokens ou credenciais no diretório `src/`. (`./scripts/check-no-sensitive-logs.sh` = 0 violações).
- [x] **Bloqueio de Chave `service_role`:** Cliente Supabase em `src/auth/supabaseClient.ts` rejeita explicitamente qualquer inicialização com JWT contendo `service_role`.
- [x] **Lista de Dependências Proibidas:** Verificado que `googleapis`, `@powersync/*` e `@shopify/react-native-skia` estão ausentes do `package.json` e `yarn.lock`.
- [x] **Criptografia Local:** Banco de dados SQLite criptografado com SQLCipher (`useSQLCipher: true`) e chave AES-256 derivada via `expo-crypto` e mantida no `expo-secure-store`.
- [x] **Backup Externo Seguro:** Exportação de backup para Google Drive criptografada com `AES-256-GCM`, PBKDF2-HMAC-SHA256 (210.000 iterações), IV aleatório de 12 bytes e Salt de 16 bytes.
- [x] **Biometria:** Bloqueio biométrico automático configurado por tempo de inatividade em segundo plano (DEC-03).

---

## 2. Qualidade de Código e Testes Automatizados

- [x] **Suíte de Testes Automatizados (`yarn test`):**
  - **16 Test Suites** aprovadas.
  - **107 Testes unitários e de integração** aprovados (100% de sucesso).
- [x] **Tipagem Estrita (`yarn typecheck`):** TypeScript v6 configurado em modo estrito, 0 erros encontrados.
- [x] **Linter do Projeto (`yarn lint`):** ESLint Expo aprovado sem avisos ou erros.

---

## 3. Integridade Contábil e Regras de Negócio

- [x] **Valores Monetários em Centavos:** Todos os montantes persistem como inteiros positivos (`amount_cents > 0`).
- [x] **Invariantes de Ponteiros Contábeis:**
  - `INCOME`/`EXPENSE`: exigem `account_id` e `category_id`, sem `credit_card_id` ou `invoice_id`.
  - `TRANSFER`: exige `account_id` e `transfer_account_id` distintos, sem `category_id`.
  - `CREDIT_PURCHASE`: exige `credit_card_id` e `invoice_id`, sem `account_id`.
  - `INVOICE_PAYMENT`: exige `account_id`, `credit_card_id` e `invoice_id`, sem `category_id`.
- [x] **Divisão de Parcelas:** Resto da divisão inteira de centavos alocado obrigatoriamente na 1ª parcela.
- [x] **Deduplicação de Recorrências:** Transações mensais geradas via `UUIDv5` determinístico prevenindo duplicatas offline entre os aparelhos.
- [x] **Tombstone Precedence:** Nenhuma exclusão física em tabelas sincronizadas (`deleted_at NOT NULL`).

---

## 4. Configuração EAS & Prontidão para Build

- [x] **`app.json`:**
  - `name`: "No$otros"
  - `package`: "com.nosotros.app"
  - `versionCode`: 1
  - `permissions`: `INTERNET`, `USE_BIOMETRIC`, `USE_FINGERPRINT`
  - `plugins`: `expo-router`, `expo-sqlite` (SQLCipher), `expo-secure-store`, `expo-local-authentication`, `expo-splash-screen`
  - `newArchEnabled`: `true`
- [x] **`eas.json`:**
  - Profile `preview`: Gera APK standalone para teste direto nos dispositivos do casal sem necessidade de submissão à Google Play Store.
  - Profile `production`: Gera `.aab` (Android App Bundle) assinado para publicação.
- [x] **Scripts de Build no `package.json`:**
  - `yarn build:preview`
  - `yarn build:prod`
  - `yarn security:audit`

---

## 5. Sinalização Final para Release

| Etapa | Responsável | Status |
|---|---|---|
| Auditoria de Segurança & Logs | Engenharia | ✅ APROVADO |
| Validação Contábil & Testes | QA / Test Suite | ✅ APROVADO |
| Verificação de Consumo/Perf | Engenharia | ✅ APROVADO |
| Assinatura e Build EAS | EAS Cloud / Local | 🟡 PRONTO PARA DISPARO |
| Pareamento & Smoke Test nos Aparelhos | Casal | ⏳ AGUARDANDO INSTALAÇÃO |
