BEGIN;

GRANT SELECT ON public.profiles, public.accounts TO authenticated;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT INSERT ON storage.objects TO authenticated;

DO $$
DECLARE
  v_admin uuid := gen_random_uuid();
  v_owner uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_admin_account uuid;
  v_college uuid;
  v_member_account uuid;
  v_other_account uuid;
  v_contact uuid;
  v_conversation uuid;
  v_other_contact uuid;
  v_file text;
  v_avatar text;
  v_legacy_file text;
  v_other_file text;
  v_result jsonb;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_admin, 'delete-platform@test.local', 'authenticated', 'authenticated',
     '{"platform_created":"true","college_name":"Platform"}', '{}'),
    (v_owner, 'delete-owner@test.local', 'authenticated', 'authenticated',
     '{"platform_created":"true","college_name":"Delete Me"}', '{}'),
    (v_member, 'delete-member@test.local', 'authenticated', 'authenticated', '{}', '{}'),
    (v_other, 'delete-other@test.local', 'authenticated', 'authenticated',
     '{"platform_created":"true","college_name":"Other College"}', '{}');

  INSERT INTO public.platform_admins (user_id) VALUES (v_admin);
  SELECT account_id INTO STRICT v_admin_account FROM public.profiles WHERE user_id = v_admin;
  SELECT account_id INTO STRICT v_college FROM public.profiles WHERE user_id = v_owner;
  SELECT account_id INTO STRICT v_member_account FROM public.profiles WHERE user_id = v_member;
  SELECT account_id INTO STRICT v_other_account FROM public.profiles WHERE user_id = v_other;
  UPDATE public.profiles SET account_id = v_college, account_role = 'agent' WHERE user_id = v_member;
  DELETE FROM public.accounts WHERE id = v_member_account;

  IF has_function_privilege('authenticated', 'public.delete_suspended_college(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.delete_suspended_college(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.delete_suspended_college(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'College deletion RPC grants are incorrect';
  END IF;
  BEGIN
    PERFORM public.delete_suspended_college(v_college, v_owner, 'Delete Me');
    RAISE EXCEPTION 'A college owner could delete their college';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  IF public.delete_suspended_college(v_college, v_admin, 'Delete Me')->>'status' <> 'not_suspended' THEN
    RAISE EXCEPTION 'An active college could be deleted';
  END IF;
  UPDATE public.accounts SET status = 'suspended' WHERE id IN (v_college, v_admin_account);
  IF public.delete_suspended_college(v_college, v_admin, 'Other College')->>'status' <> 'name_mismatch' THEN
    RAISE EXCEPTION 'An incorrect confirmation was accepted';
  END IF;
  IF public.delete_suspended_college(v_admin_account, v_admin, 'Platform')->>'status' <> 'protected' THEN
    RAISE EXCEPTION 'A platform administrator could be deleted';
  END IF;

  INSERT INTO public.contacts (account_id, user_id, name, phone)
    VALUES (v_other_account, v_member, 'Shared author', '+923000001001') RETURNING id INTO v_other_contact;
  IF public.delete_suspended_college(v_college, v_admin, 'Delete Me')->>'status' <> 'protected' THEN
    RAISE EXCEPTION 'A member with data in a different college could be deleted';
  END IF;
  UPDATE public.contacts SET user_id = v_other WHERE id = v_other_contact;

  INSERT INTO public.contacts (account_id, user_id, name, phone)
    VALUES (v_college, v_owner, 'Target contact', '+923000001002') RETURNING id INTO v_contact;
  INSERT INTO public.conversations (account_id, user_id, contact_id)
    VALUES (v_college, v_owner, v_contact) RETURNING id INTO v_conversation;
  INSERT INTO public.messages (conversation_id, sender_type, content_text)
    VALUES (v_conversation, 'customer', 'Test message');

  v_file := 'account-' || v_college || '/inbound/test.jpg';
  v_avatar := v_member || '/avatar.png';
  v_legacy_file := v_owner || '/legacy.png';
  v_other_file := 'account-' || v_other_account || '/inbound/keep.jpg';
  INSERT INTO storage.objects (bucket_id, name, owner_id)
    VALUES
      ('avatars', v_avatar, v_member::text),
      ('chat-media', v_file, v_owner::text),
      ('chat-media', v_other_file, v_other::text),
      ('flow-media', v_legacy_file, v_owner::text);
  v_result := public.delete_suspended_college(v_college, v_admin, 'Delete Me');
  IF v_result IS DISTINCT FROM jsonb_build_object(
    'status', 'remove_files', 'objects', jsonb_build_array(
      jsonb_build_object('bucket', 'avatars', 'path', v_avatar),
      jsonb_build_object('bucket', 'chat-media', 'path', v_file),
      jsonb_build_object('bucket', 'flow-media', 'path', v_legacy_file)
    )
  ) THEN
    RAISE EXCEPTION 'Unexpected file cleanup selection: %', v_result;
  END IF;

  BEGIN
    UPDATE public.accounts SET status = 'active' WHERE id = v_college;
    RAISE EXCEPTION 'A college being deleted could be reactivated';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE public.profiles SET account_id = v_other_account WHERE user_id = v_member;
    RAISE EXCEPTION 'A profile could leave a college being deleted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  PERFORM set_config('request.jwt.claim.sub', v_member::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('avatars', v_member || '/new.png');
    RAISE EXCEPTION 'A college member could upload files during deletion';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  -- Model the Storage API removing the test fixture before retrying.
  DELETE FROM storage.objects WHERE name IN (v_file, v_avatar, v_legacy_file);
  IF public.delete_suspended_college(v_college, v_admin, 'Delete Me')->>'status' <> 'deleted' THEN
    RAISE EXCEPTION 'The college could not finish deleting after its file was removed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounts WHERE id = v_college)
     OR EXISTS (SELECT 1 FROM auth.users WHERE id IN (v_owner, v_member))
     OR EXISTS (SELECT 1 FROM public.profiles WHERE account_id = v_college)
     OR EXISTS (SELECT 1 FROM public.contacts WHERE id = v_contact)
     OR EXISTS (SELECT 1 FROM public.messages WHERE conversation_id = v_conversation) THEN
    RAISE EXCEPTION 'College data survived deletion';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contacts WHERE id = v_other_contact)
     OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_other)
     OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = v_other_file) THEN
    RAISE EXCEPTION 'Data in a different college was removed';
  END IF;
END;
$$;

ROLLBACK;
