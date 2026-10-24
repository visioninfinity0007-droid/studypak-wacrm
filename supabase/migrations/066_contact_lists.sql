-- Contact lists (client request, 2026-10-24).
--
-- A college keeps its students in named lists — typically one per
-- uploaded sheet ("Rawalpindi Oct"). A student can be in several lists;
-- the contact itself stays unique per college (phone_normalized), so a
-- number that appears in two sheets is one contact in two lists. Lists
-- are shared by everyone in the college, like contacts.
--
--   contact_lists          — the named list.
--   contact_list_members   — which contacts are in which list. account_id
--                            is copied from the list by a trigger, which
--                            also refuses a contact from another college.
--   delete_contact_list()  — deletes a list and, optionally, the contacts
--                            that were in no other list. SECURITY INVOKER,
--                            so the caller's own RLS decides what it may
--                            delete.

CREATE TABLE IF NOT EXISTS public.contact_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_lists_account_name
  ON public.contact_lists (account_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.contact_list_members (
  list_id UUID NOT NULL REFERENCES public.contact_lists(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (list_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_list_members_contact
  ON public.contact_list_members (contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_members_account
  ON public.contact_list_members (account_id);

-- Membership integrity: the row belongs to the list's college, and the
-- contact must be in that same college. Runs as the caller, so a list
-- or contact the caller can't see reads as missing.
CREATE OR REPLACE FUNCTION public.contact_list_members_set_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_list_account UUID;
  v_contact_account UUID;
BEGIN
  SELECT account_id INTO v_list_account FROM contact_lists WHERE id = NEW.list_id;
  SELECT account_id INTO v_contact_account FROM contacts WHERE id = NEW.contact_id;
  IF v_list_account IS NULL OR v_contact_account IS NULL
     OR v_list_account <> v_contact_account THEN
    RAISE EXCEPTION 'Contact and list must belong to the same college'
      USING ERRCODE = '42501';
  END IF;
  NEW.account_id := v_list_account;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_list_members_set_account ON public.contact_list_members;
CREATE TRIGGER contact_list_members_set_account
  BEFORE INSERT OR UPDATE ON public.contact_list_members
  FOR EACH ROW EXECUTE FUNCTION public.contact_list_members_set_account();

CREATE OR REPLACE FUNCTION public.contact_lists_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_lists_touch ON public.contact_lists;
CREATE TRIGGER contact_lists_touch
  BEFORE UPDATE ON public.contact_lists
  FOR EACH ROW EXECUTE FUNCTION public.contact_lists_touch();

-- RLS: everyone in the college sees lists; agents (who import) create,
-- rename and fill them; deleting a whole list is admin-only.
ALTER TABLE public.contact_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_list_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_lists_select ON public.contact_lists;
CREATE POLICY contact_lists_select ON public.contact_lists
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS contact_lists_insert ON public.contact_lists;
CREATE POLICY contact_lists_insert ON public.contact_lists
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS contact_lists_update ON public.contact_lists;
CREATE POLICY contact_lists_update ON public.contact_lists
  FOR UPDATE USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS contact_lists_delete ON public.contact_lists;
CREATE POLICY contact_lists_delete ON public.contact_lists
  FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS contact_list_members_select ON public.contact_list_members;
CREATE POLICY contact_list_members_select ON public.contact_list_members
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS contact_list_members_insert ON public.contact_list_members;
CREATE POLICY contact_list_members_insert ON public.contact_list_members
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS contact_list_members_delete ON public.contact_list_members;
CREATE POLICY contact_list_members_delete ON public.contact_list_members
  FOR DELETE USING (is_account_member(account_id, 'agent'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_lists TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.contact_list_members TO authenticated;
GRANT ALL ON public.contact_lists TO service_role;
GRANT ALL ON public.contact_list_members TO service_role;

-- Delete a list; with p_delete_contacts, also delete its contacts that
-- are in no other list. Returns how many contacts were deleted. Their
-- conversations go with them (existing cascade); campaign statistics
-- stay (broadcast_recipients.contact_id is SET NULL, migration 004).
CREATE OR REPLACE FUNCTION public.delete_contact_list(
  p_list_id UUID,
  p_delete_contacts BOOLEAN DEFAULT false
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER := 0;
  v_n INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contact_lists WHERE id = p_list_id) THEN
    RAISE EXCEPTION 'List not found' USING ERRCODE = '22023';
  END IF;

  IF p_delete_contacts THEN
    DELETE FROM contacts c
    WHERE c.id IN (SELECT contact_id FROM contact_list_members WHERE list_id = p_list_id)
      AND NOT EXISTS (
        SELECT 1 FROM contact_list_members other
        WHERE other.contact_id = c.id AND other.list_id <> p_list_id
      );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  DELETE FROM contact_lists WHERE id = p_list_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    -- RLS hid the row from DELETE: not an admin of this college. The
    -- exception also rolls back any contacts deleted above.
    RAISE EXCEPTION 'Only college admins can delete a list' USING ERRCODE = '42501';
  END IF;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_contact_list(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_contact_list(UUID, BOOLEAN) TO authenticated;

-- redeem_invitation: an account that owns lists is not "empty" (same
-- body as 065 plus the two list tables).
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
    UNION ALL SELECT 1 FROM whatsapp_additional_numbers WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_lists WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_list_members WHERE account_id = v_old_account_id
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
