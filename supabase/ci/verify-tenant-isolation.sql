-- Two-college tenant isolation test (contract requirement 1).
--
-- Runs in CI after `supabase db reset` (see .github/workflows/migrations.yml)
-- against a throwaway local database. It creates two platform-created
-- colleges and one self-service signup, seeds each college with data as
-- postgres, then switches to the `authenticated` role with college A's JWT
-- claims and proves, through the real RLS policies and triggers, that A:
--   * sees only its own contacts, WhatsApp config, templates, broadcasts;
--   * cannot update, delete or insert into college B's rows;
--   * cannot change its own status or PKR rate (platform-managed);
--   * cannot read or grant itself platform admin.
-- Any failed expectation raises, which fails the CI job.
DO $$
DECLARE
  v_a UUID := gen_random_uuid();
  v_b UUID := gen_random_uuid();
  v_c UUID := gen_random_uuid();
  v_acc_a UUID;
  v_acc_b UUID;
  v_acc_c UUID;
  v_contact_b UUID;
  v_n INT;
  v_blocked BOOLEAN;
  v_status TEXT;
  v_name TEXT;
  v_step TEXT := 'start';
BEGIN
  -- ---------- setup (as postgres) ----------
  -- Hosted Supabase grants the Data API roles table privileges on public
  -- tables by default (that's how the live app reads them); the local CLI
  -- database used in CI does not. Mirror the hosted grants for the tables
  -- under test so that row-level security — the thing being tested — is
  -- what allows or denies each statement, not a missing GRANT.
  v_step := 'setup: mirror hosted Data API grants';
  GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.accounts, public.profiles, public.contacts, public.whatsapp_config,
       public.message_templates, public.broadcasts
    TO authenticated;
  v_step := 'setup: create auth users';
  INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES
    (v_a, 'college-a@isolation.test', 'authenticated', 'authenticated',
     '{"platform_created":"true","college_name":"College A"}', '{"full_name":"Admin A"}', now(), now()),
    (v_b, 'college-b@isolation.test', 'authenticated', 'authenticated',
     '{"platform_created":"true","college_name":"College B"}', '{"full_name":"Admin B"}', now(), now()),
    (v_c, 'walk-in@isolation.test', 'authenticated', 'authenticated',
     '{}', '{"full_name":"Walk In","platform_created":"true","college_name":"Fake"}', now(), now());

  SELECT account_id INTO v_acc_a FROM public.profiles WHERE user_id = v_a;
  SELECT account_id INTO v_acc_b FROM public.profiles WHERE user_id = v_b;
  SELECT account_id INTO v_acc_c FROM public.profiles WHERE user_id = v_c;
  IF v_acc_a IS NULL OR v_acc_b IS NULL OR v_acc_c IS NULL THEN
    RAISE EXCEPTION 'handle_new_user did not create accounts for the test users';
  END IF;

  SELECT name, status INTO v_name, v_status FROM public.accounts WHERE id = v_acc_a;
  IF v_name <> 'College A' OR v_status <> 'active' THEN
    RAISE EXCEPTION 'platform-created college should be active and named "College A", got % / %', v_name, v_status;
  END IF;
  -- user_metadata is client-writable, so claiming platform_created there must NOT activate.
  SELECT status INTO v_status FROM public.accounts WHERE id = v_acc_c;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'self-service signup should start pending, got %', v_status;
  END IF;

  v_step := 'setup: seed college data';
  INSERT INTO public.contacts (user_id, account_id, phone, name) VALUES
    (v_a, v_acc_a, '+920000000001', 'Student A');
  INSERT INTO public.contacts (user_id, account_id, phone, name) VALUES
    (v_b, v_acc_b, '+920000000002', 'Student B') RETURNING id INTO v_contact_b;
  INSERT INTO public.whatsapp_config (user_id, account_id, phone_number_id, access_token, status) VALUES
    (v_a, v_acc_a, 'iso-test-pn-a', 'enc-a', 'connected'),
    (v_b, v_acc_b, 'iso-test-pn-b', 'enc-b', 'connected');
  INSERT INTO public.message_templates (user_id, account_id, name, category, body_text) VALUES
    (v_a, v_acc_a, 'tpl_a', 'Utility', 'Hello A'),
    (v_b, v_acc_b, 'tpl_b', 'Utility', 'Hello B');
  INSERT INTO public.broadcasts (user_id, account_id, name, template_name) VALUES
    (v_a, v_acc_a, 'Campaign A', 'tpl_a'),
    (v_b, v_acc_b, 'Campaign B', 'tpl_b');

  -- ---------- act as college A ----------
  v_step := 'as A: switch role';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_step := 'as A: read own data';
  SELECT count(*) INTO v_n FROM public.contacts;
  IF v_n <> 1 THEN RAISE EXCEPTION 'college A should see exactly 1 contact, saw %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.contacts WHERE account_id = v_acc_b;
  IF v_n <> 0 THEN RAISE EXCEPTION 'college A can read college B contacts'; END IF;

  SELECT count(*) INTO v_n FROM public.whatsapp_config;
  IF v_n <> 1 THEN RAISE EXCEPTION 'college A should see exactly 1 WhatsApp config, saw %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.message_templates;
  IF v_n <> 1 THEN RAISE EXCEPTION 'college A should see exactly 1 template, saw %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.broadcasts;
  IF v_n <> 1 THEN RAISE EXCEPTION 'college A should see exactly 1 broadcast, saw %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.accounts;
  IF v_n <> 1 THEN RAISE EXCEPTION 'college A should see exactly 1 account, saw %', v_n; END IF;

  v_step := 'as A: write to college B';
  UPDATE public.contacts SET name = 'hijacked' WHERE id = v_contact_b;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'college A updated a college B contact'; END IF;

  DELETE FROM public.broadcasts WHERE account_id = v_acc_b;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'college A deleted a college B broadcast'; END IF;

  v_blocked := false;
  BEGIN
    INSERT INTO public.contacts (user_id, account_id, phone, name)
    VALUES (v_a, v_acc_b, '+920000000099', 'Planted');
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'college A inserted a contact into college B'; END IF;

  v_step := 'as A: change own status';
  v_blocked := false;
  BEGIN
    -- A real change (active → suspended); a no-op write is allowed by design.
    UPDATE public.accounts SET status = 'suspended' WHERE id = v_acc_a;
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'college admin changed its own account status'; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'accounts'
               AND column_name = 'broadcast_rate_pkr') THEN
    v_blocked := false;
    BEGIN
      EXECUTE format('UPDATE public.accounts SET broadcast_rate_pkr = 0 WHERE id = %L', v_acc_a);
    EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
    END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'college admin changed its own PKR rate'; END IF;
  END IF;

  SELECT count(*) INTO v_n FROM public.platform_admins;
  IF v_n <> 0 THEN RAISE EXCEPTION 'non-admin can read platform_admins rows'; END IF;
  v_blocked := false;
  BEGIN
    INSERT INTO public.platform_admins (user_id) VALUES (v_a);
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'college admin granted itself platform admin'; END IF;

  EXECUTE 'RESET ROLE';

  -- ---------- act as college B (mirror check) ----------
  v_step := 'as B: mirror check';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.contacts WHERE account_id = v_acc_a;
  IF v_n <> 0 THEN RAISE EXCEPTION 'college B can read college A contacts'; END IF;
  SELECT name INTO v_name FROM public.contacts WHERE id = v_contact_b;
  IF v_name <> 'Student B' THEN RAISE EXCEPTION 'college B contact was modified by college A'; END IF;
  SELECT count(*) INTO v_n FROM public.broadcasts;
  IF v_n <> 1 THEN RAISE EXCEPTION 'college B broadcast was deleted or leaked (saw %)', v_n; END IF;
  EXECUTE 'RESET ROLE';

  RAISE NOTICE 'tenant isolation: all checks passed';
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'tenant isolation failed at step "%": % [SQLSTATE %] (current_user=%, session_user=%, has SELECT on contacts as authenticated=%)',
    v_step, SQLERRM, SQLSTATE, current_user, session_user,
    has_table_privilege('authenticated', 'public.contacts', 'SELECT');
END $$;
