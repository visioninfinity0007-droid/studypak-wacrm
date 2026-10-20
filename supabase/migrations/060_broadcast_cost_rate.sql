-- Contract requirement 6: configurable per-college indicative cost in PKR.
-- NULL means not configured, not free. Does not assert Meta's tariff.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS broadcast_rate_pkr NUMERIC(12,4);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_broadcast_rate_pkr_valid'
      AND conrelid = 'public.accounts'::regclass
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_broadcast_rate_pkr_valid
      CHECK (broadcast_rate_pkr IS NULL OR
             (broadcast_rate_pkr >= 0 AND broadcast_rate_pkr <= 99999));
  END IF;
END $$;
