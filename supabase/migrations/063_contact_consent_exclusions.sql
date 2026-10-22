-- Contract requirement 3: consent evidence and exclusions.
--
-- Owning a student's phone number is not permission to message them.
-- Broadcasts only go to contacts whose consent is recorded ('granted')
-- and whose number is not on the account's exclusion list.
--
-- 1. contacts consent columns — status + where it came from + evidence.
-- 2. contact_exclusions — per-account list of numbers that must never be
--    broadcast to (replied STOP, or excluded by staff). Keyed by the
--    digits-only phone so it survives the contact being deleted and
--    re-imported.
-- 3. Triggers keep the two consistent:
--    * adding an exclusion revokes consent on the matching contact;
--    * a contact whose number is excluded can't be (re)marked granted —
--      the exclusion has to be removed first (START reply, or an admin).

-- ------------------------------------------------------------
-- 1. contacts consent
-- ------------------------------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS consent_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS consent_source TEXT,
  ADD COLUMN IF NOT EXISTS consent_evidence TEXT,
  ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consent_recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_consent_status_valid'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_consent_status_valid
      CHECK (consent_status IN ('unknown', 'granted', 'revoked'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_account_consent
  ON public.contacts (account_id, consent_status);

-- ------------------------------------------------------------
-- 2. contact_exclusions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_exclusions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  phone_normalized TEXT NOT NULL CHECK (phone_normalized ~ '^[0-9]{8,15}$'),
  reason TEXT NOT NULL CHECK (reason IN ('opt_out', 'manual')),
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contact_exclusions_account_phone_unique UNIQUE (account_id, phone_normalized)
);

ALTER TABLE public.contact_exclusions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_exclusions_select ON public.contact_exclusions;
CREATE POLICY contact_exclusions_select ON public.contact_exclusions
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS contact_exclusions_insert ON public.contact_exclusions;
CREATE POLICY contact_exclusions_insert ON public.contact_exclusions
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

-- Removing someone from the do-not-message list is an admin decision.
DROP POLICY IF EXISTS contact_exclusions_delete ON public.contact_exclusions;
CREATE POLICY contact_exclusions_delete ON public.contact_exclusions
  FOR DELETE USING (is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, DELETE ON public.contact_exclusions TO authenticated;
GRANT ALL ON public.contact_exclusions TO service_role;

-- ------------------------------------------------------------
-- 3a. exclusion added → revoke consent on matching contacts
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_consent_on_exclusion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.contacts
     SET consent_status = 'revoked',
         consent_at = now(),
         consent_source = CASE WHEN NEW.reason = 'opt_out' THEN 'opt_out_reply' ELSE 'excluded_by_staff' END
   WHERE account_id = NEW.account_id
     AND phone_normalized = NEW.phone_normalized
     AND consent_status <> 'revoked';
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.revoke_consent_on_exclusion() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.revoke_consent_on_exclusion() FROM PUBLIC;

DROP TRIGGER IF EXISTS revoke_consent_on_exclusion ON public.contact_exclusions;
CREATE TRIGGER revoke_consent_on_exclusion
  AFTER INSERT ON public.contact_exclusions
  FOR EACH ROW EXECUTE FUNCTION public.revoke_consent_on_exclusion();

-- ------------------------------------------------------------
-- 3b. excluded number can't be marked granted
--     (phone_normalized is a generated column and isn't computed yet in
--      a BEFORE trigger, so normalise NEW.phone here the same way.)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_consent_for_excluded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.consent_status = 'granted' AND EXISTS (
    SELECT 1 FROM public.contact_exclusions e
     WHERE e.account_id = NEW.account_id
       AND e.phone_normalized = regexp_replace(NEW.phone, '\D', '', 'g')
  ) THEN
    NEW.consent_status := 'revoked';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_consent_for_excluded() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_consent_for_excluded() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_consent_for_excluded ON public.contacts;
CREATE TRIGGER guard_consent_for_excluded
  BEFORE INSERT OR UPDATE OF consent_status, phone ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.guard_consent_for_excluded();

-- ------------------------------------------------------------
-- 4. redeem_invitation: an account holding an opt-out list is not
--    "empty". Same body as 047 plus the contact_exclusions check, so
--    joining a college by invite can never cascade-delete exclusions.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_exclusions WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
