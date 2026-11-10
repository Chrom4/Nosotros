# Phase 6 — Evidência de Captura Offline, Live Queries (< 16ms), Invariantes Contábeis, DEC-02 e Sincronização A↔B

## 1. Escopo Validado
Verificação automatizada ponta a ponta (`tests/data/phase6-accounts-transactions.test.ts`) integrando:
- **Contas e Carteiras (`src/app/(tabs)/accounts.tsx`, `src/data/repositories/accountRepository.ts`):** CRUD transacional (`accounts` + `sync_outbox`), filtro de titularidade (`CONSOLIDATED`, `DOMESTIC`, `USER`), reconstrução de saldo em centavos (`calculateAccountBalanceCents` / `listAccountsWithBalances`) e exclusão lógica estrita (`softDeleteAccount`).
- **Categorias Hierárquicas (`src/app/(tabs)/categories.tsx`, `src/data/repositories/categoryRepository.ts`):** Hierarquia em 2 níveis (`Categoria Raiz › Subcategoria`), validação de compatibilidade de tipo (`INCOME` vs `EXPENSE`), seed determinístico idempotente via `UUIDv5` (`seedDefaultCategories`) e soft-delete em cascata das subcategorias ativas no mesmo `batchId`.
- **Captura Rápida de Lançamentos Base (`src/components/TransactionQuickModal.tsx`, `src/app/(tabs)/transactions.tsx`, `src/data/repositories/transactionRepository.ts`):** Suporte a `INCOME`, `EXPENSE`, `DEBIT_REFUND` e `TRANSFER`, validação de invariantes de ponteiros antes e na persistência (`assertTransactionInvariants` + `chk_accounting_invariants`), e aplicação automática de **DEC-02** (`is_household_contribution = true` quando despesa compartilhada da casa é paga por conta individual, ou transferência de aporte para conta conjunta).
- **Queries Reativas & Estado de Filtros (`src/data/useReactiveQuery.ts`, `src/store/filters.ts`):** Integração com `useLiveQuery` (`drizzle-orm/expo-sqlite`), `@shopify/flash-list` e notificação reativa local em **< 16ms** (`subscribeToDatabaseChanges`).
- **Sincronização Offline A↔B (`reconcilePeerOutbox` em `src/data/repositories/outbox.ts`):** Ordenação topológica de FKs (`accounts` → `categories` raiz → `categories` subcategoria → `transactions`), merge HLC LWW por coluna e precedência de Tombstone (`deleted_at`).

---

## 2. Resultado dos Gates de Aceitação (Fase 6)

| Gate | Critério (`specs/06-accounts-transactions/spec.md`) | Resultado | Evidência Automatizada |
|---|---|---|---|
| **GATE-6.1** | CRUD de Contas e Categorias hierárquicas (2 níveis) operando exclusivamente via repositórios transacionais (`domain` + `sync_outbox`) e Soft Delete (`deleted_at`). | **PASS** | `tests/data/phase6-accounts-transactions.test.ts` (`T6.2`) |
| **GATE-6.2** | Captura rápida de `INCOME`, `EXPENSE`, `DEBIT_REFUND` e `TRANSFER` com seletor de titularidade e flag `is_household_contribution` (**DEC-02**). | **PASS** | `tests/data/phase6-accounts-transactions.test.ts` (`T6.2 & Gates`) |
| **GATE-6.3** | Rejeição imediata de combinações inválidas de ponteiros (`EXPENSE` sem categoria, `TRANSFER` com categoria, auto-transferência `account_id = transfer_account_id`, incompatibilidade `INCOME`/`EXPENSE`). | **PASS** | `tests/data/phase6-accounts-transactions.test.ts` (`T6.2 & Gates`) |
| **GATE-6.4** | Atualização reativa local (`useLiveQuery` / `useReactiveQuery`) com latência percebida **< 16ms** e reconciliação bidirecional **Device A ↔ Device B** após reconexão. | **PASS** | `tests/data/phase6-accounts-transactions.test.ts` (`T6.3 & T6.4`) |

---

## 3. Reprodução Local
```bash
yarn test tests/data/phase6-accounts-transactions.test.ts
```
