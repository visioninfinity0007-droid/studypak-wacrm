-- Contact lists test (migration 066), run in CI after `supabase db reset`.
-- As college A's users it proves that:
--   * a contact can be in two lists, and lists are per college;
--   * college A can't see college B's lists, or put B's contact in A's list;
--   * an agent can't delete a list; an admin can;
--   * delete_contact_list(…, true) deletes only contacts in no other list.
DO $$
DECLARE
  v_a UUID := gen_random_uuid();
  v_agent UUID := gen_random_uuid();
  v_b UUID := gen_random_uuid();
  v_acc_a UUID;
  v_acc_b UUID;
  v_shared UUID;
  v_only_one UUID;
  v_contact_b UUID;
  v_list1 UUID;
  v_list2 UUID;
  v_list_b UUID;
  v_n INT;
  v_blocked BOOLEAN;
  v_step TEXT := 'setup';
BEGIN
  -- Hosted Supabase grants these; the local CI database doesn't (see
  -- verify-tenant-isolation.sql).
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts, public.profiles, public.contacts TO authenticated;

  INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES
    (v_a, 'lists-a@test.local', 'authenticated', 'authenticated',
     '{"platform_created":"true","college_name":"Lists A"}', '{}', now(), now()),
    (v_agent, 'lists-agent@test.local', 'authenticated', 'authenticated', '{}', '{}', now(), now()),
    (v_b, 'lists-b@test.local', 'authenticated', 'authenticated',
     '{"platform_created":"true","college_name":"Lists B"}', '{}', now(), now());
  SELECT account_id INTO v_acc_a FROM public.profiles WHERE user_id = v_a;
  SELECT account_id INTO v_acc_b FROM public.profiles WHERE user_id = v_b;
  -- The agent joins college A (its own self-signup account is dropped).
  UPDATE public.profiles SET account_id = v_acc_a, account_role = 'agent' WHERE user_id = v_agent;

  INSERT INTO public.contacts (user_id, account_id, phone, name)
  VALUES (v_a, v_acc_a, '+923001110001', 'In two lists') RETURNING id INTO v_shared;
  INSERT INTO public.contacts (user_id, account_id, phone, name)
  VALUES (v_a, v_acc_a, '+923001110002', 'In one list') RETURNING id INTO v_only_one;
  INSERT INTO public.contacts (user_id, account_id, phone, name)
  VALUES (v_b, v_acc_b, '+923001110003', 'College B student') RETURNING id INTO v_contact_b;
  INSERT INTO public.contact_lists (account_id, name) VALUES (v_acc_b, 'B list') RETURNING id INTO v_list_b;

  -- ---------- as college A's owner ----------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_step := 'create lists and memberships';
  INSERT INTO public.contact_lists (account_id, name) VALUES (v_acc_a, 'Rawalpindi Oct') RETURNING id INTO v_list1;
  INSERT INTO public.contact_lists (account_id, name) VALUES (v_acc_a, 'Lahore Nov') RETURNING id INTO v_list2;
  INSERT INTO public.contact_list_members (list_id, contact_id)
  VALUES (v_list1, v_shared), (v_list1, v_only_one), (v_list2, v_shared);
  SELECT count(*) INTO v_n FROM public.contact_list_members WHERE account_id = v_acc_a;
  IF v_n <> 3 THEN RAISE EXCEPTION 'expected 3 memberships with account_id filled in, got %', v_n; END IF;

  v_step := 'list names are unique per college';
  v_blocked := false;
  BEGIN
    INSERT INTO public.contact_lists (account_id, name) VALUES (v_acc_a, ' rawalpindi oct ');
  EXCEPTION WHEN unique_violation THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'duplicate list name was accepted'; END IF;

  v_step := 'tenant isolation of lists';
  SELECT count(*) INTO v_n FROM public.contact_lists;
  IF v_n <> 2 THEN RAISE EXCEPTION 'college A should see only its 2 lists, saw %', v_n; END IF;
  v_blocked := false;
  BEGIN
    INSERT INTO public.contact_list_members (list_id, contact_id) VALUES (v_list1, v_contact_b);
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'college A put college B''s contact in its list'; END IF;
  v_blocked := false;
  BEGIN
    INSERT INTO public.contact_list_members (list_id, contact_id) VALUES (v_list_b, v_shared);
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'college A added a contact to college B''s list'; END IF;

  -- ---------- as college A's agent ----------
  v_step := 'agent cannot delete a list';
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_blocked := false;
  BEGIN
    PERFORM public.delete_contact_list(v_list1, true);
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'an agent deleted a list'; END IF;
  SELECT count(*) INTO v_n FROM public.contacts WHERE id IN (v_shared, v_only_one);
  IF v_n <> 2 THEN RAISE EXCEPTION 'the refused delete still removed contacts (% left)', v_n; END IF;

  -- ---------- back as the owner ----------
  v_step := 'delete list with its own contacts';
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_n := public.delete_contact_list(v_list1, true);
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 contact deleted, got %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.contacts WHERE id = v_only_one) THEN
    RAISE EXCEPTION 'contact that was only in the deleted list survived';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contacts WHERE id = v_shared) THEN
    RAISE EXCEPTION 'contact that is also in another list was deleted';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contact_lists WHERE id = v_list1) THEN
    RAISE EXCEPTION 'the list itself was not deleted';
  END IF;

  v_step := 'delete list only';
  v_n := public.delete_contact_list(v_list2, false);
  IF v_n <> 0 OR NOT EXISTS (SELECT 1 FROM public.contacts WHERE id = v_shared) THEN
    RAISE EXCEPTION 'deleting a list without its contacts removed contacts';
  END IF;

  EXECUTE 'RESET ROLE';
  RAISE NOTICE 'contact lists: all checks passed';
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'contact lists test failed at step "%": % [SQLSTATE %]', v_step, SQLERRM, SQLSTATE;
END $$;
