# TEST-SEC-01 — Evidência de Auditoria de Segurança, RLS, Pareamento e Keep-Alive (Fase 3)

## 1. Escopo Validado
Verificação executada contra motor PostgreSQL real (`@electric-sql/pglite` / PostgreSQL 16+) aplicando integralmente as migrações:
- `supabase/migrations/0001_init_schema.sql` (12 tabelas de domínio e sincronização, sequência `public.global_sync_seq`, índices secundários parciais e triggers `trg_max_two_members` / `trg_enforce_member_permissions`).
- `supabase/migrations/0002_rls_policies.sql` (função `public.get_my_active_household_ids()` `SECURITY DEFINER STABLE` com `(SELECT auth.uid())` e políticas RLS em todas as 12 tabelas).
- `supabase/migrations/0003_invite_rpcs.sql` (RPCs `assert_active_household_member`, `create_household_with_founder`, `create_partner_invite`, `accept_partner_invite`, `revoke_household_member` e `keepalive_ping`).

Suíte automatizada correspondente: `tests/security/test-sec-01.test.ts`.

---

## 2. Resultado dos Gates de Aceitação (Fase 3)

| Gate | Critério | Resultado | Evidência Automatizada |
|---|---|---|---|
| **GATE-3.1** | `TEST-SEC-01`: utilizador externo (`User C`) lê `0 rows` de todas as 12 tabelas do `Household AB` e é bloqueado em `INSERT`/`UPDATE`; `User A` (`FOUNDER`) e `User B` (`PARTNER`) consultam `household_members` sem recursão infinita (`42P17`). | **PASS** | `tests/security/test-sec-01.test.ts` (`GATE-3.1`) |
| **GATE-3.2** | Inserção de 3.º membro ativo no mesmo `household_id` falha com `HOUSEHOLD_FULL`; trigger `BEFORE UPDATE` (`trg_enforce_member_permissions`) bloqueia alteração de `role` ou `revoked_at` por não-proprietários (`PARTNER`). | **PASS** | `tests/security/test-sec-01.test.ts` (`GATE-3.2`) |
| **GATE-3.3** | Membro revogado (`revoked_at IS NOT NULL`) recebe `FORBIDDEN` nas RPCs protegidas, perde visibilidade RLS (`0 rows`) e preserva integridade referencial histórica em `transactions`. | **PASS** | `tests/security/test-sec-01.test.ts` (`GATE-3.3`) |
| **GATE-3.4** | `EXPLAIN` confirma `InitPlan` na avaliação de `(SELECT auth.uid())` e subplano em cache para `public.get_my_active_household_ids()`. | **PASS** | `tests/security/test-sec-01.test.ts` (`GATE-3.4`) |
| **GATE-3.5** | Workflow `.github/workflows/supabase-keepalive.yml` presente com agendamento a cada 5 dias (`0 6 */5 * *`), sem exposição de `service_role`, e RPC `public.keepalive_ping()` operacional. | **PASS** | `tests/security/test-sec-01.test.ts` (`GATE-3.5`) |

---

## 3. Evidência do Plano de Execução (`EXPLAIN`) — GATE-3.4

### 3.1 Avaliação `InitPlan` na resolução de identidade e helper RLS
```sql
EXPLAIN (COSTS OFF)
SELECT hm.household_id
FROM public.household_members hm
WHERE hm.user_id = (SELECT auth.uid())
  AND hm.revoked_at IS NULL;
```
Plano gerado pelo PostgreSQL:
```text
Index Only Scan using idx_household_members_user_active on household_members hm
  Index Cond: (user_id = $0)
  InitPlan 1 (returns $0)
    ->  Result
```

### 3.2 Avaliação com política RLS ativa em `public.transactions`
```sql
EXPLAIN (VERBOSE, COSTS OFF)
SELECT * FROM public.transactions
WHERE household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
```
Plano gerado pelo PostgreSQL:
```text
Index Scan using idx_transactions_recurring_rule on public.transactions
  Index Cond: (transactions.household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid)
  Filter: (ANY (transactions.household_id = (hashed SubPlan 1).col1))
  SubPlan 1
    ->  ProjectSet
          Output: get_my_active_household_ids()
          ->  Result
```

### 3.3 Avaliação `InitPlan` na política `WITH CHECK` de `public.processed_mutations`
```sql
EXPLAIN (COSTS OFF)
INSERT INTO public.processed_mutations (mutation_id, household_id, user_id)
VALUES ('99992222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111');
```
Plano gerado pelo PostgreSQL:
```text
Insert on processed_mutations
  InitPlan 2 (returns $1)
    ->  Result
  ->  Result
        SubPlan 1
          ->  ProjectSet
                ->  Result
```

---

## 4. Reprodução Local
```bash
yarn test tests/security/test-sec-01.test.ts
```
