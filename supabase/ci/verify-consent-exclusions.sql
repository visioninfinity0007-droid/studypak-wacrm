-- Consent + exclusions test (contract requirement 3), run in CI after
-- `supabase db reset`. As college A's authenticated user it proves that:
--   * excluding a number revokes consent on the matching contact;
--   * an excluded contact can't be marked consented again;
--   * removing the exclusion allows consent to be recorded again;
--   * college A can't read or add exclusions for college B.
DO $$
DECLARE
  v_a UUID := gen_random_uuid();
  v_b UUID := gen_random_uuid();
  v_acc_a UUID;
  v_acc_b UUID;
  v_contact UUID;
  v_status TEXT;
  v_n INT;
  v_blocked BOOLEAN;
  v_step TEXT := 'setup';
BEGIN
  -- Hosted Supabase grants these; the local CI database doesn't (see
  -- verify-tenant-isolation.sql).
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts, public.profiles, public.contacts TO authenticated;

  INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES
    (v_a, 'consent-a@test.local', 'authenticated', 'authenticated',
     '{"platform_created":"true","college_name":"Consent A"}', '{}', now(), now()),
    (v_b, 'consent-b@test.local', 'authenticated', 'authenticated',
     '{"platform_created":"true","college_name":"Consent B"}', '{}', now(), now());
  SELECT account_id INTO v_acc_a FROM public.profiles WHERE user_id = v_a;
  SELECT account_id INTO v_acc_b FROM public.profiles WHERE user_id = v_b;

  INSERT INTO public.contacts (user_id, account_id, phone, name, consent_status, consent_source)
  VALUES (v_a, v_acc_a, '+923001112233', 'Student', 'granted', 'test')
  RETURNING id INTO v_contact;
  INSERT INTO public.contact_exclusions (account_id, phone_normalized, reason)
  VALUES (v_acc_b, '923009998877', 'manual');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_step := 'exclusion revokes consent';
  INSERT INTO public.contact_exclusions (account_id, phone_normalized, reason)
  VALUES (v_acc_a, '923001112233', 'opt_out');
  SELECT consent_status INTO v_status FROM public.contacts WHERE id = v_contact;
  IF v_status <> 'revoked' THEN RAISE EXCEPTION 'exclusion did not revoke consent (got %)', v_status; END IF;

  v_step := 'excluded contact cannot be re-granted';
  UPDATE public.contacts SET consent_status = 'granted' WHERE id = v_contact;
  SELECT consent_status INTO v_status FROM public.contacts WHERE id = v_contact;
  IF v_status <> 'revoked' THEN RAISE EXCEPTION 'excluded contact was re-granted consent'; END IF;

  v_step := 'tenant isolation of exclusions';
  SELECT count(*) INTO v_n FROM public.contact_exclusions;
  IF v_n <> 1 THEN RAISE EXCEPTION 'college A should see only its own exclusion, saw %', v_n; END IF;
  v_blocked := false;
  BEGIN
    INSERT INTO public.contact_exclusions (account_id, phone_normalized, reason)
    VALUES (v_acc_b, '923004445566', 'manual');
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'college A added an exclusion to college B'; END IF;

  v_step := 'removing exclusion allows consent again';
  DELETE FROM public.contact_exclusions WHERE account_id = v_acc_a AND phone_normalized = '923001112233';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'owner could not remove an exclusion'; END IF;
  UPDATE public.contacts SET consent_status = 'granted', consent_source = 'start_reply' WHERE id = v_contact;
  SELECT consent_status INTO v_status FROM public.contacts WHERE id = v_contact;
  IF v_status <> 'granted' THEN RAISE EXCEPTION 'consent could not be recorded after the exclusion was removed'; END IF;

  EXECUTE 'RESET ROLE';
  RAISE NOTICE 'consent + exclusions: all checks passed';
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'consent/exclusions test failed at step "%": % [SQLSTATE %]', v_step, SQLERRM, SQLSTATE;
END $$;
