-- ============================================================================
-- MIGRATION 0001: CONSOLIDATED POSTGRESQL SCHEMA, SEQUENCES, INDEXES & TRIGGERS
-- Target: Supabase PostgreSQL 15/16/17
-- ============================================================================

-- Global monotonic sequence for fast incremental sync (Pull Cursor)
CREATE SEQUENCE IF NOT EXISTS public.global_sync_seq START 1;

-- 1. Household (Espaço Financeiro Doméstico)
CREATE TABLE IF NOT EXISTS public.households (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    sync_epoch INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Household Members (Máximo estrito de 2 membros ativos por Household - Casal)
CREATE TABLE IF NOT EXISTS public.household_members (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('FOUNDER', 'PARTNER')),
    color_hex TEXT NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ NULL,
    UNIQUE (household_id, user_id)
);

-- 3. Household Pairing Invites (Convites Criptográficos de Pareamento do Casal)
CREATE TABLE IF NOT EXISTS public.household_invites (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    invited_email TEXT NOT NULL,
    invite_token_hash TEXT NOT NULL,
    created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Bank Accounts & Wallets (Contas Bancárias e Carteiras)
CREATE TABLE IF NOT EXISTS public.accounts (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    owner_user_id UUID NULL REFERENCES auth.users(id), -- NULL = Conta Conjunta / Doméstica
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('CHECKING', 'SAVINGS', 'WALLET', 'INVESTMENT')),
    initial_balance_cents BIGINT NOT NULL DEFAULT 0,
    include_in_net_worth BOOLEAN NOT NULL DEFAULT TRUE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL,
    hlc_timestamp TEXT NOT NULL,
    field_hlc JSONB NOT NULL DEFAULT '{}'::jsonb,
    server_seq BIGINT NOT NULL DEFAULT nextval('public.global_sync_seq')
);

-- 5. Categories & Subcategories (Categorias e Subcategorias)
CREATE TABLE IF NOT EXISTS public.categories (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    parent_id UUID NULL REFERENCES public.categories(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('INCOME', 'EXPENSE')),
    color_hex TEXT NOT NULL,
    icon_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL,
    hlc_timestamp TEXT NOT NULL,
    field_hlc JSONB NOT NULL DEFAULT '{}'::jsonb,
    server_seq BIGINT NOT NULL DEFAULT nextval('public.global_sync_seq')
);

-- 6. Credit Cards (Cartões de Crédito)
CREATE TABLE IF NOT EXISTS public.credit_cards (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    owner_user_id UUID NULL REFERENCES auth.users(id), -- NULL = Cartão Compartilhado da Casa
    default_payment_account_id UUID NOT NULL REFERENCES public.accounts(id),
    name TEXT NOT NULL,
    limit_cents BIGINT NOT NULL CHECK (limit_cents >= 0),
    closing_day INTEGER NOT NULL CHECK (closing_day BETWEEN 1 AND 31),
    due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL,
    hlc_timestamp TEXT NOT NULL,
    field_hlc JSONB NOT NULL DEFAULT '{}'::jsonb,
    server_seq BIGINT NOT NULL DEFAULT nextval('public.global_sync_seq')
);

-- 7. Credit Card Invoices (Faturas de Cartão de Crédito — Competências Imutáveis)
CREATE TABLE IF NOT EXISTS public.credit_card_invoices (
    id UUID PRIMARY KEY, -- Gerado via UUIDv5(credit_card_id + competence_month)
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    credit_card_id UUID NOT NULL REFERENCES public.credit_cards(id),
    competence_month TEXT NOT NULL CHECK (competence_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    closing_date DATE NOT NULL,
    due_date DATE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'PAID')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL,
    hlc_timestamp TEXT NOT NULL,
    field_hlc JSONB NOT NULL DEFAULT '{}'::jsonb,
    server_seq BIGINT NOT NULL DEFAULT nextval('public.global_sync_seq'),
    UNIQUE (credit_card_id, competence_month)
);

-- 8. Installment Plans (Cabeçalho de Rastreabilidade — Não Computável como Saldo)
CREATE TABLE IF NOT EXISTS public.installment_plans (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
    owner_user_id UUID NULL REFERENCES auth.users(id),
    credit_card_id UUID NULL REFERENCES public.credit_cards(id),
    account_id UUID NULL REFERENCES public.accounts(id),
    category_id UUID NOT NULL REFERENCES public.categories(id),
    description TEXT NOT NULL,
    total_amount_cents BIGINT NOT NULL CHECK (total_amount_cents > 0),
    total_installments INTEGER NOT NULL CHECK (total_installments >= 2),
    purchase_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL,
    hlc_timestamp TEXT NOT NULL,
    field_hlc JSONB NOT NULL DEFAULT '{}'::jsonb,
    server_seq BIGINT NOT NULL DEFAULT nextval('public.global_sync_seq'),
    CONSTRAINT chk_installment_plans_target CHECK (
        (credit_card_id IS NOT NULL AND account_id IS NULL)
        OR
        (credit_card_id IS NULL AND account_id IS NOT NULL)
    )
);

-- 9. Recurring Rules (Assinaturas, Salários, Contas Fixas)
CREATE TABLE IF NOT EXISTS public.recurring_rules (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
    owner_user_id UUID NULL REFERENCES auth.users(id),
    type TEXT NOT NULL CHECK (type IN ('INCOME', 'EXPENSE', 'CREDIT_PURCHASE')),
    account_id UUID NULL REFERENCES public.accounts(id),
    credit_card_id UUID NULL REFERENCES public.credit_cards(id),
    category_id UUID NOT NULL REFERENCES public.categories(id),
    description TEXT NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    frequency TEXT NOT NULL CHECK (frequency IN ('MONTHLY', 'YEARLY')),
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    start_month TEXT NOT NULL CHECK (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    end_month TEXT NULL CHECK (end_month IS NULL OR end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL,
    hlc_timestamp TEXT NOT NULL,
    field_hlc JSONB NOT NULL DEFAULT '{}'::jsonb,
    server_seq BIGINT NOT NULL DEFAULT nextval('public.global_sync_seq'),
    CONSTRAINT chk_recurring_rules_target CHECK (
        (type = 'CREDIT_PURCHASE' AND credit_card_id IS NOT NULL AND account_id IS NULL)
        OR
        (type IN ('INCOME', 'EXPENSE') AND account_id IS NOT NULL AND credit_card_id IS NULL)
    )
);

-- 10. Transactions Ledger (Livro-Razão de Transações)
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
    owner_user_id UUID NULL REFERENCES auth.users(id), -- NULL = Doméstico/Casal
    type TEXT NOT NULL CHECK (type IN (
        'INCOME',
        'EXPENSE',
        'TRANSFER',
        'CREDIT_PURCHASE',
        'CREDIT_REFUND',
        'DEBIT_REFUND',
        'INVOICE_PAYMENT'
    )),
    status TEXT NOT NULL DEFAULT 'CLEARED' CHECK (status IN ('PENDING', 'CLEARED')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    transaction_date DATE NOT NULL,
    competence_month TEXT NOT NULL CHECK (competence_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    description TEXT NOT NULL,
    notes TEXT NULL,
    account_id UUID NULL REFERENCES public.accounts(id),
    transfer_account_id UUID NULL REFERENCES public.accounts(id),
    credit_card_id UUID NULL REFERENCES public.credit_cards(id),
    invoice_id UUID NULL REFERENCES public.credit_card_invoices(id),
    category_id UUID NULL REFERENCES public.categories(id),
    installment_plan_id UUID NULL REFERENCES public.installment_plans(id),
    installment_number INTEGER NULL,
    total_installments INTEGER NULL,
    recurring_rule_id UUID NULL REFERENCES public.recurring_rules(id),
    refunded_transaction_id UUID NULL REFERENCES public.transactions(id),
    is_household_contribution BOOLEAN NOT NULL DEFAULT FALSE,
    calendar_event_id TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL,
    hlc_timestamp TEXT NOT NULL,
    field_hlc JSONB NOT NULL DEFAULT '{}'::jsonb,
    server_seq BIGINT NOT NULL DEFAULT nextval('public.global_sync_seq'),
    CONSTRAINT chk_accounting_invariants CHECK (
        (type IN ('INCOME', 'EXPENSE', 'DEBIT_REFUND') AND account_id IS NOT NULL AND transfer_account_id IS NULL AND credit_card_id IS NULL AND invoice_id IS NULL AND category_id IS NOT NULL)
        OR
        (type = 'TRANSFER' AND account_id IS NOT NULL AND transfer_account_id IS NOT NULL AND account_id <> transfer_account_id AND credit_card_id IS NULL AND invoice_id IS NULL AND category_id IS NULL)
        OR
        (type IN ('CREDIT_PURCHASE', 'CREDIT_REFUND') AND account_id IS NULL AND transfer_account_id IS NULL AND credit_card_id IS NOT NULL AND invoice_id IS NOT NULL AND category_id IS NOT NULL)
        OR
        (type = 'INVOICE_PAYMENT' AND account_id IS NOT NULL AND transfer_account_id IS NULL AND credit_card_id IS NOT NULL AND invoice_id IS NOT NULL AND category_id IS NULL)
    )
);

-- 11. Monthly Budgets (Orçamentos Mensais)
CREATE TABLE IF NOT EXISTS public.budgets (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    owner_user_id UUID NULL REFERENCES auth.users(id), -- NULL = Orçamento Conjunto da Casa
    category_id UUID NOT NULL REFERENCES public.categories(id),
    competence_month TEXT NOT NULL CHECK (competence_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    limit_cents BIGINT NOT NULL CHECK (limit_cents > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL,
    hlc_timestamp TEXT NOT NULL,
    field_hlc JSONB NOT NULL DEFAULT '{}'::jsonb,
    server_seq BIGINT NOT NULL DEFAULT nextval('public.global_sync_seq')
);

-- 12. Processed Mutations (Registro de Idempotência de Mutações Sincronizadas)
CREATE TABLE IF NOT EXISTS public.processed_mutations (
    mutation_id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECONDARY INDEXES (< 5ms local and remote query performance)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_household_members_household_active
    ON public.household_members (household_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_household_members_user_active
    ON public.household_members (user_id, household_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_household_invites_token_hash
    ON public.household_invites (invite_token_hash) WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_household_invites_household
    ON public.household_invites (household_id);

CREATE INDEX IF NOT EXISTS idx_accounts_household_seq
    ON public.accounts (household_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_accounts_household_active
    ON public.accounts (household_id, is_archived) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_household_owner
    ON public.accounts (household_id, owner_user_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_categories_household_seq
    ON public.categories (household_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_categories_household_kind_active
    ON public.categories (household_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_categories_household_parent
    ON public.categories (household_id, parent_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_credit_cards_household_seq
    ON public.credit_cards (household_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_credit_cards_household_active
    ON public.credit_cards (household_id, is_archived) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_credit_cards_household_owner
    ON public.credit_cards (household_id, owner_user_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_household_seq
    ON public.credit_card_invoices (household_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_invoices_household_card_status
    ON public.credit_card_invoices (household_id, credit_card_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_household_competence
    ON public.credit_card_invoices (household_id, competence_month) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_installment_plans_household_seq
    ON public.installment_plans (household_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_installment_plans_household_active
    ON public.installment_plans (household_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_recurring_rules_household_seq
    ON public.recurring_rules (household_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_recurring_rules_household_active
    ON public.recurring_rules (household_id, is_active) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_household_seq
    ON public.transactions (household_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_transactions_account_active
    ON public.transactions (household_id, account_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_transfer_active
    ON public.transactions (household_id, transfer_account_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_invoice_active
    ON public.transactions (household_id, invoice_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_competence_active
    ON public.transactions (household_id, competence_month, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_installment_plan
    ON public.transactions (household_id, installment_plan_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_recurring_rule
    ON public.transactions (household_id, recurring_rule_id, competence_month);

CREATE INDEX IF NOT EXISTS idx_budgets_household_seq
    ON public.budgets (household_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_budgets_household_competence
    ON public.budgets (household_id, competence_month, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_budgets_household_category
    ON public.budgets (household_id, category_id, competence_month) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_processed_mutations_household
    ON public.processed_mutations (household_id, processed_at);

-- ============================================================================
-- STRUCTURAL TRIGGERS ON household_members
-- ============================================================================

-- 1. Trigger to enforce the hard cap of 2 active members per Household (no race condition)
CREATE OR REPLACE FUNCTION public.enforce_max_two_household_members()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_count INTEGER;
BEGIN
  -- Serialize concurrent insertions/updates for the same household_id
  PERFORM 1 FROM public.households h WHERE h.id = NEW.household_id FOR UPDATE;

  IF NEW.revoked_at IS NULL THEN
    SELECT COUNT(*) INTO v_active_count
    FROM public.household_members hm
    WHERE hm.household_id = NEW.household_id
      AND hm.revoked_at IS NULL
      AND hm.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

    IF v_active_count >= 2 THEN
      RAISE EXCEPTION 'HOUSEHOLD_FULL: Maximum of 2 active members allowed per household.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_max_two_members ON public.household_members;
CREATE TRIGGER trg_max_two_members
BEFORE INSERT OR UPDATE ON public.household_members
FOR EACH ROW EXECUTE FUNCTION public.enforce_max_two_household_members();

-- 2. Trigger BEFORE UPDATE blocking permission changes or revocations by non-owners (AGENTS.md §5.1)
CREATE OR REPLACE FUNCTION public.enforce_household_member_permissions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := (SELECT auth.uid());
  v_is_founder BOOLEAN := FALSE;
BEGIN
  -- Immutable identity columns cannot be altered
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.household_id IS DISTINCT FROM OLD.household_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.joined_at IS DISTINCT FROM OLD.joined_at THEN
    RAISE EXCEPTION 'FORBIDDEN: Immutable member identity columns cannot be modified.';
  END IF;

  -- Enforce permission checks whenever executed by an authenticated/anon client or with JWT context
  IF v_caller_id IS NOT NULL OR current_user IN ('authenticated', 'anon') THEN
    IF v_caller_id IS NULL THEN
      RAISE EXCEPTION 'UNAUTHENTICATED';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.household_members hm
      WHERE hm.household_id = OLD.household_id
        AND hm.user_id = v_caller_id
        AND hm.role = 'FOUNDER'
        AND hm.revoked_at IS NULL
    ) INTO v_is_founder;

    -- Changing role, changing revoked_at, or updating another member's profile requires active FOUNDER
    IF (NEW.role IS DISTINCT FROM OLD.role
        OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR OLD.user_id IS DISTINCT FROM v_caller_id)
       AND NOT v_is_founder THEN
      RAISE EXCEPTION 'FORBIDDEN: Only the household FOUNDER (owner) can modify member permissions or revoke access.';
    END IF;

    -- Founder role cannot be downgraded
    IF OLD.role = 'FOUNDER' AND NEW.role IS DISTINCT FROM 'FOUNDER' THEN
      RAISE EXCEPTION 'FORBIDDEN: Founder role cannot be downgraded.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_member_permissions ON public.household_members;
CREATE TRIGGER trg_enforce_member_permissions
BEFORE UPDATE ON public.household_members
FOR EACH ROW EXECUTE FUNCTION public.enforce_household_member_permissions();
