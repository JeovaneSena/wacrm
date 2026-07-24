-- ============================================================
-- 050 — fix remove_account_member for people who still own an
-- orphaned account.
--
-- Bug: `accounts` has UNIQUE(owner_user_id) (017, "one account per
-- user"). remove_account_member (018) always tries to INSERT a brand
-- new personal account for the removed user — but if that user was
-- moved into this account directly (not through the normal
-- revoke-membership flow, e.g. an admin merge) their OLD account
-- still exists with them as owner_user_id, and the INSERT hits the
-- unique violation. Surfaced to the caller as a generic
-- "Failed to update member".
--
-- Fix: reuse the existing orphaned account (owner_user_id = target,
-- currently no profile pointing at it) instead of creating a new one
-- when one exists. Bonus: the removed user lands back on their own
-- original data (contacts/conversations/WhatsApp config) instead of
-- a blank slate — which is arguably the more correct behavior anyway
-- for "undo a merge," not just a bug workaround.
-- ============================================================

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- the account id the user now belongs to
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_new_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
  INTO v_target_account_id, v_target_role, v_target_name, v_target_email
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  -- Reuse an existing orphaned account this user still owns (the
  -- UNIQUE(owner_user_id) constraint means there can be at most one),
  -- rather than always minting a new blank one.
  SELECT id INTO v_new_account_id
  FROM accounts
  WHERE owner_user_id = p_user_id;

  IF v_new_account_id IS NULL THEN
    INSERT INTO accounts (name, owner_user_id)
    VALUES (
      COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
      p_user_id
    )
    RETURNING id INTO v_new_account_id;
  END IF;

  UPDATE profiles
  SET account_id = v_new_account_id,
      account_role = 'owner',
      invited_by_user_id = NULL
  WHERE user_id = p_user_id;

  RETURN v_new_account_id;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;
