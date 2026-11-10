-- ============================================================================
-- MIGRATION 0002: ROW LEVEL SECURITY (RLS) HELPER & MULTI-TENANT POLICIES
-- Target: Supabase PostgreSQL 15/16/17
-- ============================================================================

-- 1. Recursion-free SECURITY DEFINER helper with STABLE + initPlan (SELECT auth.uid())
CREATE OR REPLACE FUNCTION public.get_my_active_household_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT hm.household_id
  FROM public.household_members hm
  WHERE hm.user_id = (SELECT auth.uid())
    AND hm.revoked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.get_my_active_household_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_active_household_ids() TO authenticated;

-- 2. Enable strict Row Level Security on all 12 tables
ALTER TABLE public.households            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_invites     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_cards          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_card_invoices  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.installment_plans     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_rules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budgets               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_mutations   ENABLE ROW LEVEL SECURITY;

-- 3. Grant table-level privileges to authenticated role (strictly filtered by RLS)
GRANT SELECT, UPDATE ON public.households TO authenticated;
GRANT SELECT, UPDATE ON public.household_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.household_invites TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_cards TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_card_invoices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.installment_plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recurring_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.budgets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.processed_mutations TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.global_sync_seq TO authenticated;

-- 4. Policies for households, household_members, and household_invites
DROP POLICY IF EXISTS pol_households_select ON public.households;
CREATE POLICY pol_households_select ON public.households
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_households_update ON public.households;
CREATE POLICY pol_households_update ON public.households
  FOR UPDATE TO authenticated
  USING (id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_household_members_select ON public.household_members;
CREATE POLICY pol_household_members_select ON public.household_members
  FOR SELECT TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()));

-- Allows FOUNDER to revoke partner access or any active member to update their own display_name/color_hex
-- (Non-owner permission/role changes are additionally blocked by trg_enforce_member_permissions)
DROP POLICY IF EXISTS pol_household_members_update ON public.household_members;
CREATE POLICY pol_household_members_update ON public.household_members
  FOR UPDATE TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (household_id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_household_invites_all ON public.household_invites;
CREATE POLICY pol_household_invites_all ON public.household_invites
  FOR ALL TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (
    household_id IN (SELECT public.get_my_active_household_ids())
    AND created_by_user_id = (SELECT auth.uid())
  );

-- 5. Multi-tenant isolation policies for financial domain tables
DROP POLICY IF EXISTS pol_accounts_isolation ON public.accounts;
CREATE POLICY pol_accounts_isolation ON public.accounts
  FOR ALL TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (household_id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_categories_isolation ON public.categories;
CREATE POLICY pol_categories_isolation ON public.categories
  FOR ALL TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (household_id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_credit_cards_isolation ON public.credit_cards;
CREATE POLICY pol_credit_cards_isolation ON public.credit_cards
  FOR ALL TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (household_id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_invoices_isolation ON public.credit_card_invoices;
CREATE POLICY pol_invoices_isolation ON public.credit_card_invoices
  FOR ALL TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (household_id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_installment_plans_isolation ON public.installment_plans;
CREATE POLICY pol_installment_plans_isolation ON public.installment_plans
  FOR ALL TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (household_id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_recurring_rules_isolation ON public.recurring_rules;
CREATE POLICY pol_recurring_rules_isolation ON public.recurring_rules
  FOR ALL TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (household_id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_transactions_isolation ON public.transactions;
CREATE POLICY pol_transactions_isolation ON public.transactions
  FOR ALL TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (household_id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_budgets_isolation ON public.budgets;
CREATE POLICY pol_budgets_isolation ON public.budgets
  FOR ALL TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (household_id IN (SELECT public.get_my_active_household_ids()));

DROP POLICY IF EXISTS pol_processed_mutations_isolation ON public.processed_mutations;
CREATE POLICY pol_processed_mutations_isolation ON public.processed_mutations
  FOR ALL TO authenticated
  USING (household_id IN (SELECT public.get_my_active_household_ids()))
  WITH CHECK (
    household_id IN (SELECT public.get_my_active_household_ids())
    AND user_id = (SELECT auth.uid())
  );
