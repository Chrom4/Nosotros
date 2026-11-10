# Phase 5 — Evidência E2E de Pareamento do Casal, Bloqueio de 3.º Membro, Biometria (DEC-03) e Crypto-Shredding na Revogação

## 1. Escopo Validado
Verificação automatizada ponta a ponta (`tests/auth/phase5-auth-onboarding.test.ts`) integrando:
- Cliente Supabase Auth com armazenamento seguro em `expo-secure-store` (`src/auth/supabaseClient.ts`) e bloqueio estrito contra chaves `service_role`.
- Fluxo de Onboarding do Casal (`src/auth/onboardingService.ts`, `src/auth/inviteCodes.ts`) e telas Expo Router (`src/app/(auth)/login.tsx`, `src/app/(auth)/create-household.tsx`, `src/app/(auth)/accept-invite.tsx`).
- Guarda de Biometria/PIN no layout raiz (`src/app/_layout.tsx`, `src/auth/biometricGuard.ts`, `src/store/sessionUI.ts`) no arranque a frio (cold start) e após 2 minutos de inatividade em segundo plano (**DEC-03**).
- Revogação de acesso (`FORBIDDEN`) com **crypto-shredding** local (`cryptoShredLocalDatabase` em `src/data/db.ts`), destruição da chave de 256 bits do SQLCipher no `SecureStore`, truncamento atómico das tabelas SQLite locais e paragem imediata da sincronização (`isSyncHalted = true`).

---

## 2. Resultado dos Gates de Aceitação (Fase 5)

| Gate | Critério (`specs/05-auth-onboarding/spec.md`) | Resultado | Evidência Automatizada |
|---|---|---|---|
| **GATE-5.1** | Persistência de sessão no `SecureStore` (incluindo suporte a payloads grandes em múltiplos chunks) e bloqueio estrito contra exposição de `service_role` no cliente mobile. | **PASS** | `tests/auth/phase5-auth-onboarding.test.ts` (`T5.1`) |
| **GATE-5.2** | Geração, validação e hash SHA-256 de convite alfanumérico de 8 caracteres; pareamento E2E entre `User A` (`FOUNDER`) e `User B` (`PARTNER`). | **PASS** | `tests/auth/phase5-auth-onboarding.test.ts` (`T5.2`, `T5.4`) |
| **GATE-5.3** | Bloqueio de 3.º membro com mapeamento determinístico do erro `HOUSEHOLD_FULL` para a UX. | **PASS** | `tests/auth/phase5-auth-onboarding.test.ts` (`T5.2`, `T5.4`) |
| **GATE-5.4** | Bloqueio biométrico no cold start e após `>= 120.000 ms` (2 minutos) em background (**DEC-03**), mantendo desbloqueado em ausências curtas (`< 2 min`). | **PASS** | `tests/auth/phase5-auth-onboarding.test.ts` (`T5.3`) |
| **GATE-5.5** | Ao detetar revogação (`FORBIDDEN`) no arranque ou sincronização, o dispositivo revogado interrompe o sync, destrói a chave `local_sqlcipher_key_v1` no `SecureStore` e limpa todas as tabelas locais (`transactions`, `accounts`, `categories`, `households`, `household_members`, `sync_outbox`). | **PASS** | `tests/auth/phase5-auth-onboarding.test.ts` (`T5.4`) |

---

## 3. Reprodução Local
```bash
yarn test tests/auth/phase5-auth-onboarding.test.ts
```
