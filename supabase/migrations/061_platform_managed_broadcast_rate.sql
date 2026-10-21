-- Platform-controlled broadcast pricing: a tenant member (including its owner)
-- must not change the quoted per-message rate through an accounts UPDATE.
-- Existing account settings remain editable under their existing RLS policy.
-- Privileged maintenance performed as postgres/service_role is unaffected.
-- Enforcement is on the database write path, not only in the browser.
CREATE OR REPLACE FUNCTION public.enforce_broadcast_rate_platform_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.broadcast_rate_pkr IS DISTINCT FROM OLD.broadcast_rate_pkr
     AND current_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'broadcast_rate_pkr is platform-managed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_broadcast_rate_platform_only() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_broadcast_rate_platform_only ON public.accounts;
CREATE TRIGGER enforce_broadcast_rate_platform_only
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_broadcast_rate_platform_only();
