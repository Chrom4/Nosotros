-- ============================================================================
-- MIGRATION 0004: OFFLINE-FIRST SYNC RPCS (sync_push_batch / sync_pull_changes)
-- Target: Supabase PostgreSQL 15/16/17
--
-- Wire contract (client <-> server):
--   * Row payloads are snake_case full rows; `field_hlc` carries one HLC per written column.
--   * `deleted_at` is a timestamptz on the server. The client derives it from the delete HLC
--     (first 24 chars) on push and restores the HLC from `field_hlc.deleted_at` on pull.
--   * Merge rules: per-field HLC (a column without its own incoming HLC is never written),
--     Tombstone Precedence (only a RESTORE with a newer `deleted_at` HLC lifts a tombstone),
--     idempotency via `processed_mutations`, fresh `server_seq` from `global_sync_seq`.
-- ============================================================================

-- 1. Idempotency ledger (already created in 0001; kept idempotent for fresh databases)
CREATE TABLE IF NOT EXISTS public.processed_mutations (
    mutation_id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.processed_mutations ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_processed_mutations_household
    ON public.processed_mutations (household_id, processed_at);

-- 2. Table metadata helpers (whitelist + FK topological priority + mergeable columns)
CREATE OR REPLACE FUNCTION public.sync_table_priority(p_table TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table
    WHEN 'accounts' THEN 1
    WHEN 'categories' THEN 2
    WHEN 'credit_cards' THEN 3
    WHEN 'credit_card_invoices' THEN 4
    WHEN 'installment_plans' THEN 5
    WHEN 'recurring_rules' THEN 6
    WHEN 'transactions' THEN 7
    WHEN 'budgets' THEN 8
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.sync_mutable_columns(p_table TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table
    WHEN 'accounts' THEN ARRAY[
      'owner_user_id', 'name', 'type', 'initial_balance_cents',
      'include_in_net_worth', 'is_archived']
    WHEN 'categories' THEN ARRAY[
      'parent_id', 'name', 'color_hex', 'icon_name']
    WHEN 'credit_cards' THEN ARRAY[
      'owner_user_id', 'default_payment_account_id', 'name', 'limit_cents',
      'closing_day', 'due_day', 'is_archived']
    WHEN 'credit_card_invoices' THEN ARRAY['status']
    WHEN 'installment_plans' THEN ARRAY[
      'owner_user_id', 'category_id', 'description', 'total_amount_cents',
      'total_installments', 'purchase_date']
    WHEN 'recurring_rules' THEN ARRAY[
      'owner_user_id', 'type', 'account_id', 'credit_card_id', 'category_id',
      'description', 'amount_cents', 'frequency', 'day_of_month', 'start_month',
      'end_month', 'is_active']
    WHEN 'transactions' THEN ARRAY[
      'owner_user_id', 'status', 'amount_cents', 'transaction_date',
      'competence_month', 'description', 'notes', 'account_id',
      'transfer_account_id', 'category_id', 'is_household_contribution']
    WHEN 'budgets' THEN ARRAY['owner_user_id', 'limit_cents']
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.sync_is_valid_hlc(p_hlc TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_hlc IS NOT NULL
     AND p_hlc ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

REVOKE ALL ON FUNCTION public.sync_table_priority(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_mutable_columns(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_is_valid_hlc(TEXT) FROM PUBLIC;

-- 3. Internal: applies ONE mutation to its domain table (never physically deletes).
--    Returns the new server_seq, or NULL when the mutation changed nothing.
CREATE OR REPLACE FUNCTION public.sync_apply_mutation(
  p_household_id UUID,
  p_mutation JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table TEXT := p_mutation ->> 'table_name';
  v_id UUID := (p_mutation ->> 'record_id')::uuid;
  v_op TEXT := p_mutation ->> 'operation';
  v_payload JSONB := COALESCE(p_mutation -> 'payload', '{}'::jsonb);
  v_in_field_hlc JSONB := COALESCE(p_mutation -> 'field_hlc', '{}'::jsonb);
  v_in_hlc TEXT := p_mutation ->> 'hlc_timestamp';
  v_existing JSONB;
  v_row JSONB;
  v_patch JSONB := '{}'::jsonb;
  v_field_hlc JSONB;
  v_ex_hlc TEXT;
  v_col TEXT;
  v_cur TEXT;
  v_inc TEXT;
  v_in_del_hlc TEXT;
  v_cur_del_hlc TEXT;
  v_in_deleted TEXT;
  v_ex_deleted TEXT;
  v_deleted_changed BOOLEAN := FALSE;
  v_new_deleted TEXT;
  v_new_updated_at TEXT;
  v_new_row_hlc TEXT;
  v_set_clause TEXT;
  v_seq BIGINT;
BEGIN
  IF public.sync_table_priority(v_table) IS NULL THEN
    RAISE EXCEPTION 'INVALID_MUTATION: unsupported table %', v_table;
  END IF;
  IF v_op IS NULL OR v_op NOT IN ('UPSERT', 'SOFT_DELETE', 'RESTORE') THEN
    RAISE EXCEPTION 'INVALID_MUTATION: unsupported operation %', v_op;
  END IF;
  IF jsonb_typeof(v_payload) <> 'object' OR jsonb_typeof(v_in_field_hlc) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_MUTATION: payload and field_hlc must be JSON objects';
  END IF;
  IF NOT public.sync_is_valid_hlc(v_in_hlc) THEN
    RAISE EXCEPTION 'INVALID_MUTATION: malformed hlc_timestamp';
  END IF;
  IF v_payload ? 'household_id'
     AND (v_payload ->> 'household_id')::uuid IS DISTINCT FROM p_household_id THEN
    RAISE EXCEPTION 'INVALID_MUTATION: payload household_id mismatch';
  END IF;
  IF v_payload ? 'id' AND (v_payload ->> 'id')::uuid IS DISTINCT FROM v_id THEN
    RAISE EXCEPTION 'INVALID_MUTATION: payload id mismatch';
  END IF;

  FOR v_col, v_inc IN SELECT key, value FROM jsonb_each_text(v_in_field_hlc) LOOP
    IF NOT public.sync_is_valid_hlc(v_inc) THEN
      RAISE EXCEPTION 'INVALID_MUTATION: malformed field_hlc for column %', v_col;
    END IF;
  END LOOP;

  v_seq := nextval('public.global_sync_seq');

  EXECUTE format(
    'SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1 FOR UPDATE',
    v_table
  ) INTO v_existing USING v_id;

  v_in_del_hlc := COALESCE(v_in_field_hlc ->> 'deleted_at', v_in_hlc);
  v_in_deleted := NULLIF(v_payload ->> 'deleted_at', '');

  -- ---------------------------------------------------------------- INSERT --
  IF v_existing IS NULL THEN
    v_field_hlc := v_in_field_hlc;
    IF v_in_deleted IS NOT NULL AND NOT (v_field_hlc ? 'deleted_at') THEN
      v_field_hlc := jsonb_set(v_field_hlc, ARRAY['deleted_at'], to_jsonb(v_in_hlc));
    END IF;

    v_row := (v_payload - 'server_seq' - 'hlc_timestamp' - 'field_hlc')
      || jsonb_build_object(
        'id', v_id,
        'household_id', p_household_id,
        'hlc_timestamp', v_in_hlc,
        'field_hlc', v_field_hlc,
        'server_seq', v_seq
      );

    EXECUTE format(
      'INSERT INTO public.%1$I SELECT * FROM jsonb_populate_record(NULL::public.%1$I, $1)',
      v_table
    ) USING v_row;

    RETURN v_seq;
  END IF;

  -- ----------------------------------------------------------------- MERGE --
  IF (v_existing ->> 'household_id')::uuid IS DISTINCT FROM p_household_id THEN
    RAISE EXCEPTION 'FORBIDDEN: record % belongs to another household', v_id;
  END IF;

  v_field_hlc := COALESCE(v_existing -> 'field_hlc', '{}'::jsonb);
  v_ex_hlc := v_existing ->> 'hlc_timestamp';
  v_ex_deleted := v_existing ->> 'deleted_at';

  -- Per-field HLC merge: only columns carrying their own incoming HLC may win.
  FOREACH v_col IN ARRAY public.sync_mutable_columns(v_table) LOOP
    IF v_payload ? v_col AND v_in_field_hlc ? v_col THEN
      v_cur := COALESCE(v_field_hlc ->> v_col, v_ex_hlc);
      v_inc := v_in_field_hlc ->> v_col;
      IF v_inc COLLATE "C" > v_cur COLLATE "C" THEN
        v_patch := v_patch || jsonb_build_object(v_col, v_payload -> v_col);
        v_field_hlc := jsonb_set(v_field_hlc, ARRAY[v_col], to_jsonb(v_inc));
      END IF;
    END IF;
  END LOOP;

  -- Tombstone Precedence. field_hlc.deleted_at records the newest delete OR restore HLC, so a
  -- restore that arrives before an older delete is remembered (delivery-order independent).
  v_cur_del_hlc := COALESCE(v_field_hlc ->> 'deleted_at', v_ex_hlc);
  v_new_deleted := v_ex_deleted;

  IF v_op = 'RESTORE' THEN
    IF v_ex_deleted IS NOT NULL THEN
      IF v_in_del_hlc COLLATE "C" > v_cur_del_hlc COLLATE "C" THEN
        v_new_deleted := NULL;
        v_deleted_changed := TRUE;
        v_field_hlc := jsonb_set(v_field_hlc, ARRAY['deleted_at'], to_jsonb(v_in_del_hlc));
      END IF;
    ELSIF NOT (v_field_hlc ? 'deleted_at')
       OR v_in_del_hlc COLLATE "C" > (v_field_hlc ->> 'deleted_at') COLLATE "C" THEN
      v_deleted_changed := TRUE;
      v_field_hlc := jsonb_set(v_field_hlc, ARRAY['deleted_at'], to_jsonb(v_in_del_hlc));
    END IF;
  ELSIF v_in_deleted IS NOT NULL THEN
    IF v_ex_deleted IS NOT NULL THEN
      IF v_in_del_hlc COLLATE "C" > v_cur_del_hlc COLLATE "C" THEN
        v_new_deleted := GREATEST(v_ex_deleted::timestamptz, v_in_deleted::timestamptz)::text;
        v_deleted_changed := TRUE;
        v_field_hlc := jsonb_set(v_field_hlc, ARRAY['deleted_at'], to_jsonb(v_in_del_hlc));
      END IF;
    ELSIF NOT (v_field_hlc ? 'deleted_at')
       OR v_in_del_hlc COLLATE "C" >= (v_field_hlc ->> 'deleted_at') COLLATE "C" THEN
      -- A delete older than a recorded restore is ignored; otherwise the tombstone wins.
      v_new_deleted := v_in_deleted;
      v_deleted_changed := TRUE;
      v_field_hlc := jsonb_set(v_field_hlc, ARRAY['deleted_at'], to_jsonb(v_in_del_hlc));
    END IF;
  END IF;

  IF v_patch = '{}'::jsonb AND NOT v_deleted_changed THEN
    RETURN NULL; -- stale/duplicate content: nothing to write, no server_seq bump
  END IF;

  v_new_updated_at := GREATEST(
    (v_existing ->> 'updated_at')::timestamptz,
    COALESCE(NULLIF(v_payload ->> 'updated_at', '')::timestamptz, (v_existing ->> 'updated_at')::timestamptz)
  )::text;
  v_new_row_hlc := CASE
    WHEN v_in_hlc COLLATE "C" > v_ex_hlc COLLATE "C" THEN v_in_hlc
    ELSE v_ex_hlc
  END;

  v_patch := v_patch || jsonb_build_object(
    'deleted_at', v_new_deleted,
    'updated_at', v_new_updated_at,
    'hlc_timestamp', v_new_row_hlc,
    'field_hlc', v_field_hlc,
    'server_seq', v_seq
  );

  SELECT string_agg(format('%I = r.%I', k, k), ', ')
    INTO v_set_clause
    FROM jsonb_object_keys(v_patch) AS k;

  EXECUTE format(
    'UPDATE public.%1$I t SET %2$s FROM jsonb_populate_record(NULL::public.%1$I, $1) r WHERE t.id = $2',
    v_table,
    v_set_clause
  ) USING v_patch, v_id;

  RETURN v_seq;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_apply_mutation(UUID, JSONB) FROM PUBLIC;

-- 4. sync_push_batch: transactional, idempotent, epoch-guarded batch upload (<= 100)
CREATE OR REPLACE FUNCTION public.sync_push_batch(
  p_household_id UUID,
  p_sync_epoch INTEGER,
  p_mutations JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_server_epoch INTEGER;
  v_accepted INTEGER := 0;
  v_skipped INTEGER := 0;
  v_seq_max BIGINT := 0;
  v_seq BIGINT;
  v_inserted INTEGER;
  v_mutation JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  IF NOT (p_household_id IN (SELECT public.get_my_active_household_ids())) THEN
    RAISE EXCEPTION 'FORBIDDEN: Access revoked or user not in household %', p_household_id;
  END IF;

  SELECT h.sync_epoch INTO v_server_epoch
  FROM public.households h
  WHERE h.id = p_household_id
  FOR SHARE;

  IF v_server_epoch IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: household % not found', p_household_id;
  END IF;

  IF p_sync_epoch IS DISTINCT FROM v_server_epoch THEN
    RAISE EXCEPTION 'EPOCH_MISMATCH: client epoch % differs from server epoch %',
      p_sync_epoch, v_server_epoch;
  END IF;

  IF p_mutations IS NULL OR jsonb_typeof(p_mutations) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_MUTATION: p_mutations must be a JSON array';
  END IF;

  IF jsonb_array_length(p_mutations) > 100 THEN
    RAISE EXCEPTION 'BATCH_TOO_LARGE: at most 100 mutations per batch';
  END IF;

  -- Defensive FK ordering (parents first); ties keep the client's order.
  FOR v_mutation IN
    SELECT e.value
    FROM jsonb_array_elements(p_mutations) WITH ORDINALITY AS e(value, ord)
    ORDER BY
      public.sync_table_priority(e.value ->> 'table_name') NULLS LAST,
      CASE
        WHEN e.value ->> 'table_name' = 'categories'
         AND (e.value -> 'payload' ->> 'parent_id') IS NOT NULL THEN 1
        ELSE 0
      END,
      e.ord
  LOOP
    INSERT INTO public.processed_mutations (mutation_id, household_id, user_id)
    VALUES ((v_mutation ->> 'mutation_id')::uuid, p_household_id, v_user_id)
    ON CONFLICT (mutation_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_seq := public.sync_apply_mutation(p_household_id, v_mutation);
    v_accepted := v_accepted + 1;
    IF v_seq IS NOT NULL AND v_seq > v_seq_max THEN
      v_seq_max := v_seq;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'accepted', v_accepted,
    'skipped_idempotent', v_skipped,
    'server_seq_max', v_seq_max
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_push_batch(UUID, INTEGER, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_push_batch(UUID, INTEGER, JSONB) TO authenticated;

-- 5. sync_pull_changes: incremental, ordered, paginated downlink
CREATE OR REPLACE FUNCTION public.sync_pull_changes(
  p_household_id UUID,
  p_last_server_seq BIGINT,
  p_limit INTEGER DEFAULT 500
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_epoch INTEGER;
  v_last BIGINT := COALESCE(p_last_server_seq, 0);
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 500);
  v_total INTEGER;
  v_changes JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  IF NOT (p_household_id IN (SELECT public.get_my_active_household_ids())) THEN
    RAISE EXCEPTION 'FORBIDDEN: Access revoked or user not in household %', p_household_id;
  END IF;

  SELECT h.sync_epoch INTO v_epoch
  FROM public.households h
  WHERE h.id = p_household_id;

  IF v_epoch IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: household % not found', p_household_id;
  END IF;

  WITH unioned AS (
    (SELECT 'accounts'::text AS table_name, t.id AS record_id, t.server_seq, to_jsonb(t) AS row_json
       FROM public.accounts t WHERE t.household_id = p_household_id AND t.server_seq > v_last
       ORDER BY t.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'categories', t.id, t.server_seq, to_jsonb(t)
       FROM public.categories t WHERE t.household_id = p_household_id AND t.server_seq > v_last
       ORDER BY t.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'credit_cards', t.id, t.server_seq, to_jsonb(t)
       FROM public.credit_cards t WHERE t.household_id = p_household_id AND t.server_seq > v_last
       ORDER BY t.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'credit_card_invoices', t.id, t.server_seq, to_jsonb(t)
       FROM public.credit_card_invoices t WHERE t.household_id = p_household_id AND t.server_seq > v_last
       ORDER BY t.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'installment_plans', t.id, t.server_seq, to_jsonb(t)
       FROM public.installment_plans t WHERE t.household_id = p_household_id AND t.server_seq > v_last
       ORDER BY t.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'recurring_rules', t.id, t.server_seq, to_jsonb(t)
       FROM public.recurring_rules t WHERE t.household_id = p_household_id AND t.server_seq > v_last
       ORDER BY t.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'transactions', t.id, t.server_seq, to_jsonb(t)
       FROM public.transactions t WHERE t.household_id = p_household_id AND t.server_seq > v_last
       ORDER BY t.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'budgets', t.id, t.server_seq, to_jsonb(t)
       FROM public.budgets t WHERE t.household_id = p_household_id AND t.server_seq > v_last
       ORDER BY t.server_seq LIMIT v_limit + 1)
  ),
  page AS (
    SELECT u.*, row_number() OVER (ORDER BY u.server_seq, u.table_name) AS rn
    FROM (
      SELECT * FROM unioned ORDER BY server_seq, table_name LIMIT v_limit + 1
    ) u
  )
  SELECT
    COUNT(*)::integer,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'table_name', p.table_name,
          'record_id', p.record_id,
          'server_seq', p.server_seq,
          'operation', CASE
            WHEN p.row_json ->> 'deleted_at' IS NOT NULL THEN 'SOFT_DELETE'
            WHEN (p.row_json -> 'field_hlc') ? 'deleted_at' THEN 'RESTORE'
            ELSE 'UPSERT'
          END,
          'payload', p.row_json - 'field_hlc' - 'hlc_timestamp' - 'server_seq',
          'field_hlc', p.row_json -> 'field_hlc',
          'hlc_timestamp', p.row_json ->> 'hlc_timestamp',
          'deleted_at', p.row_json ->> 'deleted_at'
        )
        ORDER BY p.rn
      ) FILTER (WHERE p.rn <= v_limit),
      '[]'::jsonb
    )
  INTO v_total, v_changes
  FROM page p;

  RETURN jsonb_build_object(
    'sync_epoch', v_epoch,
    'changes', v_changes,
    'has_more', v_total > v_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_pull_changes(UUID, BIGINT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_pull_changes(UUID, BIGINT, INTEGER) TO authenticated;
