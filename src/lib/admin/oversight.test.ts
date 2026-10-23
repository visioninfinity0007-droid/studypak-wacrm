import { describe, expect, it } from 'vitest';

import {
  mergeCollegeActivity,
  parseCollegeFilter,
  summarizeFailures,
  toAdminBroadcast,
  type BroadcastRow,
} from './oversight';

const WATIM = { id: '4ed7c8c0-e30b-4e60-b55f-e3cf5f19a573', name: 'Watim' };
const OTHER = { id: '7a9296cc-ba03-45a8-aa5e-bf20bc5a5aab', name: 'Other' };

describe('parseCollegeFilter', () => {
  it('treats a missing, empty or "all" filter as every college', () => {
    expect(parseCollegeFilter('https://x/api/admin/broadcasts')).toEqual({ ok: true, collegeId: null });
    expect(parseCollegeFilter('https://x/a?college=')).toEqual({ ok: true, collegeId: null });
    expect(parseCollegeFilter('https://x/a?college=all')).toEqual({ ok: true, collegeId: null });
  });

  it('accepts a college id', () => {
    expect(parseCollegeFilter(`https://x/a?college=${WATIM.id.toUpperCase()}`)).toEqual({ ok: true, collegeId: WATIM.id });
  });

  it('rejects anything that is not a uuid', () => {
    expect(parseCollegeFilter('https://x/a?college=1;drop')).toEqual({ ok: false });
  });
});

describe('mergeCollegeActivity', () => {
  it('merges newest first, tags the college, drops links and keeps ids unique', () => {
    const merged = mergeCollegeActivity(
      [
        { college: WATIM, items: [{ id: 'contact-1', kind: 'contact', text: 'A', at: '2026-10-22T10:00:00Z', href: '/contacts' }] },
        { college: OTHER, items: [
          { id: 'contact-1', kind: 'contact', text: 'B', at: '2026-10-22T11:00:00Z', href: '/contacts' },
          { id: 'broadcast-9', kind: 'broadcast', text: 'C', at: '2026-10-22T09:00:00Z' },
        ] },
      ],
      2,
    );
    expect(merged).toEqual([
      { id: `${OTHER.id}:contact-1`, kind: 'contact', text: 'B', at: '2026-10-22T11:00:00Z', college: OTHER },
      { id: `${WATIM.id}:contact-1`, kind: 'contact', text: 'A', at: '2026-10-22T10:00:00Z', college: WATIM },
    ]);
  });
});

describe('toAdminBroadcast', () => {
  const row: BroadcastRow = {
    id: 'b1', account_id: WATIM.id, name: 'Admissions open', template_name: 'admissions_2026',
    status: 'sent', total_recipients: 100, sent_count: 98, delivered_count: 95, read_count: 80,
    replied_count: 4, failed_count: 2, created_at: '2026-10-22T10:00:00Z', scheduled_at: null,
  };

  it('names the college and estimates cost from messages sent', () => {
    const b = toAdminBroadcast(row, new Map([[WATIM.id, { ...WATIM, ratePkr: 2.5 }]]));
    expect(b.college).toEqual(WATIM);
    expect(b.sent).toBe(98);
    expect(b.estimatedCostPkr).toBe(245);
  });

  it('leaves the cost empty when the college has no rate, and tolerates null counts', () => {
    const b = toAdminBroadcast({ ...row, sent_count: null }, new Map([[WATIM.id, { ...WATIM, ratePkr: null }]]));
    expect(b.sent).toBe(0);
    expect(b.estimatedCostPkr).toBeNull();
  });
});

describe('summarizeFailures', () => {
  it('groups by reason, most common first, with blank reasons as null', () => {
    expect(
      summarizeFailures([
        { error_message: 'Not a WhatsApp user' },
        { error_message: ' ' },
        { error_message: 'Not a WhatsApp user' },
        { error_message: 'Rate limit' },
      ]),
    ).toEqual([
      { reason: 'Not a WhatsApp user', count: 2 },
      { reason: null, count: 1 },
      { reason: 'Rate limit', count: 1 },
    ]);
  });
});
