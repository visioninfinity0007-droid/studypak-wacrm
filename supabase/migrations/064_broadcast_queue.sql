-- Contract requirement 4: broadcasts are sent by a persistent server-side
-- queue (src/lib/whatsapp/broadcast-queue.ts), not by the browser tab.
--
-- broadcast_recipients gets retry bookkeeping:
--   attempt_count       sends attempted so far (capped retries)
--   next_attempt_at     when a retryable failure may be tried again
--   attempt_started_at  set just before a send, cleared once its outcome
--                       is written. A row still carrying it when a new
--                       queue lease is taken was in flight when the
--                       previous worker died: Meta may already have
--                       delivered it, so it is NOT resent automatically
--                       (no duplicates) — it's marked failed with that
--                       reason and can be retried on purpose.
-- broadcasts gets send_params: the campaign-wide send-time values (e.g.
-- a media header URL) the browser used to pass on every batch.
-- broadcasts.delivery_locked_at (038) is reused as the queue lease.

ALTER TABLE public.broadcast_recipients
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_started_at TIMESTAMPTZ;

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS send_params JSONB;

-- Queue scan: pending rows of one broadcast, due first.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_queue
  ON public.broadcast_recipients (broadcast_id, next_attempt_at)
  WHERE status = 'pending';

-- Worker tick: broadcasts that may have work.
CREATE INDEX IF NOT EXISTS idx_broadcasts_queue_active
  ON public.broadcasts (status, scheduled_at)
  WHERE status IN ('sending', 'scheduled');
