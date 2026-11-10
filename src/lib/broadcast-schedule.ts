// ============================================================
// Scheduled broadcasts — the one place that decides what send time is
// acceptable. The wizard uses it to show the time before saving, and
// the queue/schedule routes use it to refuse anything else, so the
// browser and the server can't disagree.
//
// A scheduled campaign is an ordinary broadcast with status
// 'scheduled' and a scheduled_at: its recipients are stored when it is
// created, and the queue worker (runs every minute) starts sending once
// scheduled_at has passed — see src/lib/whatsapp/broadcast-queue.ts.
// ============================================================

/** Earliest send time: a little ahead, so the minute tick can't miss it. */
export const SCHEDULE_MIN_LEAD_MS = 5 * 60_000;
/** Latest send time. Templates and audiences go stale beyond this. */
export const SCHEDULE_MAX_AHEAD_MS = 90 * 24 * 60 * 60_000;

export type DelayUnit = 'minutes' | 'hours' | 'days';

const UNIT_MS: Record<DelayUnit, number> = {
  minutes: 60_000,
  hours: 60 * 60_000,
  days: 24 * 60 * 60_000,
};

/** "Send after 3 hours" → the absolute send time. */
export function scheduleFromDelay(amount: number, unit: DelayUnit, nowMs: number): Date {
  return new Date(nowMs + amount * UNIT_MS[unit]);
}

export type ScheduleCheck =
  | { ok: true; iso: string }
  | { ok: false; reason: 'invalid' | 'too_soon' | 'too_far' };

export function checkScheduledAt(value: unknown, nowMs: number): ScheduleCheck {
  if (typeof value !== 'string' && !(value instanceof Date)) return { ok: false, reason: 'invalid' };
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return { ok: false, reason: 'invalid' };
  // A minute's slack: the time was valid when the user clicked, and
  // inserting the recipients before the request can take a while.
  if (ms < nowMs + SCHEDULE_MIN_LEAD_MS - 60_000) return { ok: false, reason: 'too_soon' };
  if (ms > nowMs + SCHEDULE_MAX_AHEAD_MS) return { ok: false, reason: 'too_far' };
  return { ok: true, iso: new Date(ms).toISOString() };
}

export const SCHEDULE_ERROR_MESSAGES: Record<'invalid' | 'too_soon' | 'too_far', string> = {
  invalid: 'Send time is not a valid date',
  too_soon: 'Send time must be at least 5 minutes from now',
  too_far: 'Send time must be within 90 days',
};
