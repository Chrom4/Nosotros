-- ============================================================================
-- MIGRATION 0003: HOUSEHOLD LIFECYCLE, PAIRING INVITE & REVOCATION RPCS
-- Target: Supabase PostgreSQL 15/16/17
-- ============================================================================

-- 1. Protected membership guard for RPCs (raises FORBIDDEN if revoked or external)
CREATE OR REPLACE FUNCTION public.assert_active_household_member(
  p_household_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.household_members hm
    WHERE hm.household_id = p_household_id
      AND hm.user_id = v_user_id
      AND hm.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: Access revoked or user not in household %', p_household_id;
  END IF;

  RETURN v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_active_household_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_active_household_member(UUID) TO authenticated;

-- 2. Bootstrap Household with FOUNDER member
CREATE OR REPLACE FUNCTION public.create_household_with_founder(
  p_household_id UUID,
  p_household_name TEXT,
  p_member_id UUID,
  p_display_name TEXT,
  p_color_hex TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  INSERT INTO public.households (id, name, sync_epoch)
  VALUES (p_household_id, trim(p_household_name), 1);

  INSERT INTO public.household_members (
    id, household_id, user_id, display_name, role, color_hex
  ) VALUES (
    p_member_id, p_household_id, v_user_id, trim(p_display_name), 'FOUNDER', p_color_hex
  );

  RETURN p_household_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_household_with_founder(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_household_with_founder(UUID, TEXT, UUID, TEXT, TEXT) TO authenticated;

-- 3. Issue cryptographic partner invite (SHA-256 token hash, 24h default TTL)
CREATE OR REPLACE FUNCTION public.create_partner_invite(
  p_invite_id UUID,
  p_household_id UUID,
  p_invited_email TEXT,
  p_invite_token_hash TEXT,
  p_expires_in_hours INTEGER DEFAULT 24
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_active_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  -- Verify caller is an active FOUNDER of the household
  IF NOT EXISTS (
    SELECT 1
    FROM public.household_members hm
    WHERE hm.household_id = p_household_id
      AND hm.user_id = v_user_id
      AND hm.role = 'FOUNDER'
      AND hm.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: Access revoked or caller is not the FOUNDER of household %', p_household_id;
  END IF;

  -- Lock household row and ensure capacity for partner
  PERFORM 1 FROM public.households h WHERE h.id = p_household_id FOR UPDATE;

  SELECT COUNT(*) INTO v_active_count
  FROM public.household_members hm
  WHERE hm.household_id = p_household_id
    AND hm.revoked_at IS NULL;

  IF v_active_count >= 2 THEN
    RAISE EXCEPTION 'HOUSEHOLD_FULL: Maximum of 2 active members allowed per household.';
  END IF;

  IF trim(coalesce(p_invited_email, '')) = '' OR trim(coalesce(p_invite_token_hash, '')) = '' THEN
    RAISE EXCEPTION 'INVALID_INVITE_PARAMETERS';
  END IF;

  -- Expire any previous pending invites for this household
  UPDATE public.household_invites
  SET expires_at = NOW()
  WHERE household_id = p_household_id
    AND accepted_at IS NULL
    AND expires_at > NOW();

  INSERT INTO public.household_invites (
    id,
    household_id,
    invited_email,
    invite_token_hash,
    created_by_user_id,
    expires_at
  ) VALUES (
    p_invite_id,
    p_household_id,
    lower(trim(p_invited_email)),
    trim(p_invite_token_hash),
    v_user_id,
    NOW() + make_interval(hours => GREATEST(COALESCE(p_expires_in_hours, 24), 1))
  );

  RETURN p_invite_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_partner_invite(UUID, UUID, TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_partner_invite(UUID, UUID, TEXT, TEXT, INTEGER) TO authenticated;

-- 4. Accept partner invite and pair atomically as PARTNER
CREATE OR REPLACE FUNCTION public.accept_partner_invite(
  p_invite_token_hash TEXT,
  p_member_id UUID,
  p_display_name TEXT,
  p_color_hex TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_user_email TEXT := lower(coalesce((SELECT auth.jwt()) ->> 'email', ''));
  v_invite RECORD;
BEGIN
  IF v_user_id IS NULL OR v_user_email = '' THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  SELECT * INTO v_invite
  FROM public.household_invites hi
  WHERE hi.invite_token_hash = p_invite_token_hash
    AND lower(hi.invited_email) = v_user_email
    AND hi.accepted_at IS NULL
    AND hi.expires_at > NOW()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_OR_EXPIRED_INVITE';
  END IF;

  INSERT INTO public.household_members (
    id, household_id, user_id, display_name, role, color_hex
  ) VALUES (
    p_member_id, v_invite.household_id, v_user_id, trim(p_display_name), 'PARTNER', p_color_hex
  );

  UPDATE public.household_invites
  SET accepted_at = NOW()
  WHERE id = v_invite.id;

  RETURN v_invite.household_id;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_partner_invite(TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_partner_invite(TEXT, UUID, TEXT, TEXT) TO authenticated;

-- 5. Soft-revoke household member (FOUNDER only; preserves historical FK integrity)
CREATE OR REPLACE FUNCTION public.revoke_household_member(
  p_household_id UUID,
  p_target_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  -- Verify caller is an active FOUNDER of the household
  IF NOT EXISTS (
    SELECT 1
    FROM public.household_members hm
    WHERE hm.household_id = p_household_id
      AND hm.user_id = v_user_id
      AND hm.role = 'FOUNDER'
      AND hm.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: Access revoked or caller is not the FOUNDER of household %', p_household_id;
  END IF;

  IF p_target_user_id = v_user_id THEN
    RAISE EXCEPTION 'FORBIDDEN: Founder cannot revoke their own membership.';
  END IF;

  UPDATE public.household_members
  SET revoked_at = NOW()
  WHERE household_id = p_household_id
    AND user_id = p_target_user_id
    AND revoked_at IS NULL;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_household_member(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_household_member(UUID, UUID) TO authenticated;

-- 6. Lightweight keep-alive health RPC (`SELECT 1`) for 5-day GitHub Actions schedule
CREATE OR REPLACE FUNCTION public.keepalive_ping()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 1;
$$;

REVOKE ALL ON FUNCTION public.keepalive_ping() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.keepalive_ping() TO anon, authenticated;
