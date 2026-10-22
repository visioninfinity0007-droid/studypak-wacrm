-- Contract requirement 1: central college administration.
--
-- Each college is an `accounts` row (tenant). A platform administrator
-- (Study in Pakistan) creates, approves and suspends colleges from the
-- /admin area, which talks to the database with the service role.
--
-- 1. platform_admins  — who may use /admin. Readable only for your own
--                       row; written only by postgres/service_role.
-- 2. accounts.status  — 'active' | 'pending' | 'suspended'. Existing
--                       accounts stay active. Tenants cannot change it.
-- 3. handle_new_user  — a college created by the platform (service-role
--                       admin.createUser with app_metadata) starts
--                       'active' under the college name; any other
--                       self-service signup starts 'pending' until a
--                       platform admin approves it. app_metadata is not
--                       writable by end users, so a signup cannot claim
--                       to be platform-created.

-- ------------------------------------------------------------
-- 1. platform_admins
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admins_select_self ON public.platform_admins;
CREATE POLICY platform_admins_select_self ON public.platform_admins
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.platform_admins FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.platform_admins FROM authenticated;
GRANT SELECT ON public.platform_admins TO authenticated;

-- ------------------------------------------------------------
-- 2. accounts.status
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_status_valid'
      AND conrelid = 'public.accounts'::regclass
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_status_valid
      CHECK (status IN ('active', 'pending', 'suspended'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_account_status_platform_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND current_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'accounts.status is platform-managed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_account_status_platform_only() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_account_status_platform_only ON public.accounts;
CREATE TRIGGER enforce_account_status_platform_only
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_account_status_platform_only();

-- ------------------------------------------------------------
-- 3. handle_new_user: platform-created colleges start active,
--    self-service signups start pending.
--    Same body as 017 otherwise (trigger on_auth_user_created is
--    unchanged and keeps pointing at this function).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_college_name TEXT;
  v_platform_created BOOLEAN;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
  v_platform_created := COALESCE(NEW.raw_app_meta_data->>'platform_created', '') = 'true';
  v_college_name := NULLIF(btrim(COALESCE(NEW.raw_app_meta_data->>'college_name', '')), '');

  INSERT INTO public.accounts (name, owner_user_id, status)
  VALUES (
    COALESCE(
      CASE WHEN v_platform_created THEN v_college_name END,
      NULLIF(v_full_name, ''),
      NEW.email,
      'My account'
    ),
    NEW.id,
    CASE WHEN v_platform_created THEN 'active' ELSE 'pending' END
  )
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
