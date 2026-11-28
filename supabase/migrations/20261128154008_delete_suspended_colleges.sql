-- A suspended college stays locked while its files are removed through
-- the Storage API. The final step removes CRM records and Auth users
-- together, so a failed transaction leaves enough state for a retry.
ALTER TABLE public.accounts
  ADD COLUMN deletion_started_at timestamptz,
  ADD CONSTRAINT accounts_delete_only_suspended
    CHECK (deletion_started_at IS NULL OR status = 'suspended');

CREATE FUNCTION public.protect_college_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.deletion_started_at IS NOT NULL
     OR current_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'College deletion state is platform-managed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_college_deletion() FROM PUBLIC;

CREATE TRIGGER protect_college_deletion
BEFORE UPDATE OF deletion_started_at ON public.accounts
FOR EACH ROW
WHEN (OLD.deletion_started_at IS DISTINCT FROM NEW.deletion_started_at)
EXECUTE FUNCTION public.protect_college_deletion();

CREATE FUNCTION public.lock_college_membership_during_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_account_id uuid;
  v_account record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_account_id := OLD.account_id;
    IF NEW.account_id IS NOT DISTINCT FROM v_old_account_id THEN
      RETURN NEW;
    END IF;
  END IF;

  FOR v_account IN
    SELECT a.deletion_started_at FROM public.accounts a
    WHERE a.id IN (NEW.account_id, v_old_account_id)
    ORDER BY a.id
    FOR SHARE
  LOOP
    IF v_account.deletion_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'College deletion is in progress' USING ERRCODE = '23505';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.lock_college_membership_during_deletion() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lock_college_membership_during_deletion()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER lock_college_membership_during_deletion
BEFORE INSERT OR UPDATE OF account_id ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.lock_college_membership_during_deletion();

-- Existing bucket policies still enforce ownership. These extra checks
-- prevent a browser with an old access token from uploading more files,
-- including avatars, during or after deletion.
CREATE POLICY college_storage_insert_while_retained ON storage.objects AS RESTRICTIVE
FOR INSERT TO authenticated WITH CHECK (
  bucket_id NOT IN ('avatars', 'chat-media', 'flow-media')
  OR EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = (SELECT auth.uid()) AND a.deletion_started_at IS NULL
  )
);

CREATE POLICY college_storage_update_while_retained ON storage.objects AS RESTRICTIVE
FOR UPDATE TO authenticated WITH CHECK (
  bucket_id NOT IN ('avatars', 'chat-media', 'flow-media')
  OR EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = (SELECT auth.uid()) AND a.deletion_started_at IS NULL
  )
);

CREATE FUNCTION public.delete_suspended_college(
  p_account_id uuid,
  p_actor_id uuid,
  p_confirmation text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_college public.accounts%ROWTYPE;
  v_users uuid[];
  v_user_paths text[];
  v_prefix text := 'account-' || p_account_id::text || '/';
  v_files jsonb;
  v_foreign_file boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = p_actor_id) THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_college FROM public.accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_college.status <> 'suspended' THEN
    RETURN jsonb_build_object('status', 'not_suspended');
  END IF;
  IF NULLIF(btrim(p_confirmation), '') IS DISTINCT FROM btrim(v_college.name) THEN
    RETURN jsonb_build_object('status', 'name_mismatch');
  END IF;

  SELECT array_agg(user_id), array_agg(user_id::text)
  INTO v_users, v_user_paths
  FROM (
    SELECT v_college.owner_user_id AS user_id
    UNION
    SELECT p.user_id FROM public.profiles p WHERE p.account_id = p_account_id
  ) members;

  -- New foreign-key references to these logins must wait until the
  -- cross-workspace checks and any Auth deletion have finished.
  PERFORM 1 FROM auth.users WHERE id = ANY(v_users) ORDER BY id FOR UPDATE;

  -- Some legacy rows cascade from their author's Auth user as well as
  -- from their workspace. Protect data created in a previous workspace.
  IF EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = ANY(v_users))
     OR EXISTS (SELECT 1 FROM public.accounts WHERE id <> p_account_id AND owner_user_id = ANY(v_users))
     OR EXISTS (SELECT 1 FROM public.profiles WHERE account_id IS DISTINCT FROM p_account_id AND user_id = ANY(v_users))
     OR EXISTS (
       SELECT 1 FROM (
         SELECT account_id, user_id FROM public.contacts
         UNION ALL SELECT account_id, user_id FROM public.conversations
         UNION ALL SELECT account_id, user_id FROM public.contact_notes
         UNION ALL SELECT account_id, user_id FROM public.tags
         UNION ALL SELECT account_id, user_id FROM public.custom_fields
         UNION ALL SELECT account_id, user_id FROM public.pipelines
         UNION ALL SELECT account_id, user_id FROM public.deals
         UNION ALL SELECT account_id, user_id FROM public.whatsapp_config
         UNION ALL SELECT account_id, user_id FROM public.message_templates
         UNION ALL SELECT account_id, user_id FROM public.broadcasts
         UNION ALL SELECT account_id, user_id FROM public.automations
         UNION ALL SELECT account_id, user_id FROM public.automation_logs
         UNION ALL SELECT account_id, user_id FROM public.automation_pending_executions
         UNION ALL SELECT account_id, user_id FROM public.flows
         UNION ALL SELECT account_id, user_id FROM public.flow_runs
         UNION ALL SELECT account_id, user_id FROM public.quick_replies
         UNION ALL SELECT account_id, user_id FROM public.notifications
         UNION ALL SELECT account_id, user_id FROM public.member_presence
       ) authored
       WHERE account_id IS DISTINCT FROM p_account_id AND user_id = ANY(v_users)
     ) THEN
    RETURN jsonb_build_object('status', 'protected');
  END IF;

  -- Storage metadata is read-only here. Physical deletion is performed
  -- by the Storage API. Older flow media and avatars use user folders.
  WITH candidates AS (
    SELECT o.bucket_id AS bucket, o.name AS path, scope.belongs_to_college
    FROM storage.objects o
    CROSS JOIN LATERAL (VALUES (
      COALESCE(
        (o.bucket_id IN ('chat-media', 'flow-media') AND o.name LIKE v_prefix || '%')
        OR (o.bucket_id IN ('avatars', 'flow-media')
            AND strpos(o.name, '/') > 0 AND split_part(o.name, '/', 1) = ANY(v_user_paths)),
        false
      )
    )) AS scope(belongs_to_college)
    WHERE scope.belongs_to_college OR o.owner = ANY(v_users) OR o.owner_id = ANY(v_user_paths)
  )
  SELECT EXISTS (
    SELECT 1 FROM candidates WHERE NOT belongs_to_college
  ), (
    SELECT jsonb_agg(files ORDER BY bucket, path)
    FROM (
      SELECT bucket, path FROM candidates WHERE belongs_to_college
      ORDER BY bucket, path LIMIT 200
    ) files
  ) INTO v_foreign_file, v_files;

  IF v_foreign_file THEN
    RETURN jsonb_build_object('status', 'protected');
  END IF;

  IF v_files IS NOT NULL THEN
    IF v_college.deletion_started_at IS NULL THEN
      UPDATE public.accounts SET deletion_started_at = now() WHERE id = p_account_id;
      -- Disable API integrations and stop routing background WhatsApp
      -- work to this workspace during file cleanup.
      DELETE FROM public.api_keys WHERE account_id = p_account_id;
      DELETE FROM public.whatsapp_additional_numbers WHERE account_id = p_account_id;
      DELETE FROM public.whatsapp_config WHERE account_id = p_account_id;
    END IF;
    RETURN jsonb_build_object('status', 'remove_files', 'objects', v_files);
  END IF;

  DELETE FROM public.accounts WHERE id = p_account_id;
  -- Includes Auth sessions, refresh tokens, and identities through Auth
  -- foreign keys. The account FK requires deleting the workspace first.
  DELETE FROM auth.users WHERE id = ANY(v_users);
  RETURN jsonb_build_object('status', 'deleted');
END;
$$;

ALTER FUNCTION public.delete_suspended_college(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_suspended_college(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_suspended_college(uuid, uuid, text) TO service_role;
