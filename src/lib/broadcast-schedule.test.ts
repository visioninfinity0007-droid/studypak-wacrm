import { describe, expect, it } from 'vitest';

import { checkScheduledAt, scheduleFromDelay } from './broadcast-schedule';

const NOW = Date.parse('2026-11-10T10:00:00Z');

describe('scheduleFromDelay', () => {
  it('adds minutes, hours and days', () => {
    expect(scheduleFromDelay(30, 'minutes', NOW).toISOString()).toBe('2026-11-10T10:30:00.000Z');
    expect(scheduleFromDelay(3, 'hours', NOW).toISOString()).toBe('2026-11-10T13:00:00.000Z');
    expect(scheduleFromDelay(2, 'days', NOW).toISOString()).toBe('2026-11-12T10:00:00.000Z');
  });
});

describe('checkScheduledAt', () => {
  it('accepts a time a few hours ahead and normalises it', () => {
    expect(checkScheduledAt('2026-11-10T18:00:00+05:00', NOW)).toEqual({
      ok: true,
      iso: '2026-11-10T13:00:00.000Z',
    });
  });

  it('refuses times in the past or too close', () => {
    expect(checkScheduledAt('2026-11-10T09:00:00Z', NOW)).toEqual({ ok: false, reason: 'too_soon' });
    expect(checkScheduledAt('2026-11-10T10:02:00Z', NOW)).toEqual({ ok: false, reason: 'too_soon' });
  });

  it('allows a minute of slack under the 5-minute lead', () => {
    expect(checkScheduledAt('2026-11-10T10:04:30Z', NOW).ok).toBe(true);
  });

  it('refuses more than 90 days ahead', () => {
    expect(checkScheduledAt('2027-03-01T10:00:00Z', NOW)).toEqual({ ok: false, reason: 'too_far' });
  });

  it('refuses garbage', () => {
    expect(checkScheduledAt('tomorrow', NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkScheduledAt(123, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkScheduledAt(undefined, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });
});
