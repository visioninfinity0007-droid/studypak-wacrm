import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadBroadcastEligibility } from './consent-server';

function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from(table: string) {
      const filters: ((r: Record<string, unknown>) => boolean)[] = [];
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
        in: (c: string, vs: unknown[]) => { const s = new Set(vs); filters.push((r) => s.has(r[c])); return b; },
        then: (resolve: (x: unknown) => unknown) =>
          Promise.resolve(resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null })),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('loadBroadcastEligibility', () => {
  const db = fakeDb({
    contacts: [
      { account_id: 'a', phone_normalized: '923001112233', consent_status: 'granted' },
      { account_id: 'a', phone_normalized: '923004445566', consent_status: 'unknown' },
      { account_id: 'a', phone_normalized: '923007778899', consent_status: 'granted' },
      { account_id: 'b', phone_normalized: '923000000000', consent_status: 'granted' },
    ],
    contact_exclusions: [{ account_id: 'a', phone_normalized: '923007778899' }],
  });

  it('allows consented, refuses unknown/excluded/unknown-contact, scoped to the account', async () => {
    const check = await loadBroadcastEligibility(db, 'a', [
      '+92 300 1112233', '923004445566', '+923007778899', '+923000000000', '+923009999999',
    ]);
    expect(check('+92 300 1112233')).toEqual({ eligible: true });
    expect(check('923004445566')).toEqual({ eligible: false, reason: 'no_consent' });
    expect(check('+923007778899')).toEqual({ eligible: false, reason: 'excluded' });
    // Another college's consented contact doesn't count for this one.
    expect(check('+923000000000')).toEqual({ eligible: false, reason: 'no_consent' });
    expect(check('+923009999999')).toEqual({ eligible: false, reason: 'no_consent' });
  });
});
