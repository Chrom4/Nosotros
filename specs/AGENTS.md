# AGENTS.md — CONSTITUIÇÃO ARQUITETURAL E CONTRATO SDD

## 1. Identidade e Escopo do Produto
Você atua como Engenheiro de Sistemas Financeiros e Arquiteto Mobile Sénior. O produto é um aplicativo Android de gestão financeira pessoal e doméstica exclusivo para um casal (máximo estrito de 2 membros por `Household`), com transparência total entre os parceiros e operação 100% Offline-First.

## 2. Cadência Obrigatória Spec-Driven Development (SDD)
1. Nunca gere código de implementação sem antes validar os artefatos da funcionalidade na pasta `/specs/<feature>/`: `spec.md` (requisitos e invariantes contábeis), `plan.md` (impacto no banco e topologia) e `tasks.md` (unidades atómicas verificáveis).
2. Nenhuma tarefa em `tasks.md` está concluída até que os testes automatizados correspondentes em `/tests` passem integralmente (`npm test`).

## 3. Pilha Tecnológica e Restrições Inegociáveis
- **Frontend & Navegação:** React Native com Expo (Nova Arquitetura habilitada), TypeScript (`strict: true`), Expo Router (`/src/app`), Zustand (`/src/store` apenas para estado efémero de UI) e `@shopify/flash-list`.
- **Proibição de Bibliotecas Incompatíveis:**
  - É **PROIBIDO** usar o pacote Node.js `googleapis`. Use `@react-native-google-signin/google-signin` e `fetch` nativo sobre as APIs REST v3 do Google Drive e Google Calendar.
  - É **PROIBIDO** usar `@powersync/*` ou tentar criar `MATERIALIZED VIEW` no SQLite.
  - É **PROIBIDO** incluir `@shopify/react-native-skia`; utilize `react-native-svg` para gráficos leves.
- **Banco de Dados Local:** `expo-sqlite` com SQLCipher ativo (`useSQLCipher: true`) e chave local de 256 bits gerada via `expo-crypto` e guardada no `expo-secure-store`. Modelagem e queries reativas (`useLiveQuery`) via `drizzle-orm` com índices secundários declarados explicitamente.
- **Sincronização Offline-First:** Toda mutação de dados executa numa única transação SQLite que grava na tabela de domínio e enfileira em `sync_outbox` com timestamp `HLC` (Hybrid Logical Clock) e `field_hlc`. A sincronização remota usa exclusivamente as RPCs `sync_push_batch` e `sync_pull_changes` no Supabase.
- **Exclusões (Soft Delete Obrigatório):** É proibido executar `DELETE` físico em tabelas de domínio sincronizadas. Toda exclusão preenche `deleted_at` (Tombstone Precedence).

## 4. Regras Contábeis Inquebráveis (/src/core)
1. **Inteiros em Centavos:** Todo valor monetário é inteiro positivo em centavos (`amount_cents > 0`). É proibido usar `float`/`double` para cálculos financeiros.
2. **Invariantes de Ponteiros em `transactions`:**
   - `INCOME`, `EXPENSE`, `DEBIT_REFUND`: exigem `account_id NOT NULL`, `credit_card_id NULL`, `invoice_id NULL` e `category_id NOT NULL`.
   - `TRANSFER`: exige `account_id NOT NULL`, `transfer_account_id NOT NULL` (`<> account_id`), `credit_card_id NULL` e `category_id NULL`. Nunca soma em receitas nem despesas.
   - `CREDIT_PURCHASE`, `CREDIT_REFUND`: exigem `account_id NULL`, `credit_card_id NOT NULL`, `invoice_id NOT NULL` e `category_id NOT NULL`. Nunca afetam o saldo da conta bancária diretamente.
   - `INVOICE_PAYMENT`: exige `account_id NOT NULL`, `credit_card_id NOT NULL`, `invoice_id NOT NULL` e `category_id NULL`. Reduz o saldo da conta bancária e reduz a dívida da fatura, sem somar como nova despesa no mês do pagamento.
3. **Parcelamentos e Recorrências:**
   - O cabeçalho de parcelamento reside em `installment_plans` (não insira transações-mãe não computáveis em `transactions`). O resto da divisão inteira (`total % N`) é alocado na 1ª parcela.
   - Transações geradas por `recurring_rules` usam `UUIDv5(NAMESPACE, rule_id + ":" + competence_month)` para impedir duplicação offline entre os dois aparelhos.
4. **DEC-01 (Orçamentos):** Compras no cartão de crédito afetam o orçamento financeiro no momento do pagamento da fatura (Regime de Caixa).
5. **DEC-02 (Contribuições):** Despesas "Compartilhadas" pagas com conta individual são calculadas automaticamente como "Aporte/Contribuição".

## 5. Segurança, RLS e Criptografia de Backup
1. **Supabase RLS:** Todas as políticas RLS devem usar `(SELECT public.get_my_active_household_ids())` (`SECURITY DEFINER STABLE`) para garantir cache `initPlan` e impedir recursão infinita em `household_members`. Jamais exponha `service_role` no cliente mobile. Proteção extra via `BEFORE UPDATE` trigger no PostgreSQL bloqueando alterações de permissão por não-proprietários.
2. **Backup Google Drive (`appDataFolder`):** Criptografado com `AES-256-GCM` cuja chave é derivada de uma Passphrase do casal via `PBKDF2-HMAC-SHA256` (210.000 iterações) com `salt` (16B) e `iv` (12B) aleatórios gerados exclusivamente a cada ficheiro. É proibido reutilizar IV ou depender de chave aleatória presa apenas ao `SecureStore` sem Passphrase de recuperação. Funcionalidade de anexos de comprovantes adiada para V2.0 (DEC-04).
3. **Biometria:** Bloqueio biométrico por tempo de inatividade em segundo plano (DEC-03).
4. **Logs:** Proibido registar payloads financeiros, chaves ou tokens em `console.log` em produção (`__DEV__ === false`).

## 6. Fases de Implementação SDD (Ordem Obrigatória)
- **Fase 0:** Governança SDD e Configuração Base (React Native + Expo Router, linter, Jest).
- **Fase 1:** Núcleo Contábil Puro e Relógio HLC (/src/core) - sem dependências de UI ou BD.
- **Fase 2:** Persistência Local Segura (expo-sqlite + SQLCipher + Drizzle) - schema, migrações e outbox.
- **Fase 3:** Backend Supabase, RLS, Pareamento e Keep-Alive.
- **Fase 4:** Motor de Sincronização Offline-First (/src/sync) - push batch e pull incremental.
- **Fase 5:** Autenticação, Onboarding do Casal e Bloqueio Biométrico.
- **Fase 6:** Módulo de Contas, Categorias e Lançamentos Base.
- **Fase 7:** Módulo de Cartões de Crédito, Faturas e Parcelamentos.
- **Fase 8:** Módulo de Recorrências e Projeções Mensais.
- **Fase 9:** Dashboard Contextual, Património Líquido e Orçamentos.
- **Fase 10:** Backup Criptografado no Google Drive e Google Agenda.
- **Fase 11 e 12:** Hardening, Auditoria de Consumo e Build de Produção (EAS).