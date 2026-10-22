import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveConfigForPhoneNumber } from './number-routing';

type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, failTable?: string) {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const run = () => {
        if (table === failTable) return { data: null, error: { message: 'relation does not exist' } };
        return { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
      };
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
        maybeSingle: () => {
          const r = run();
          return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error });
        },
        then: (resolve: (x: unknown) => unknown) => Promise.resolve(resolve(run())),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const tables = {
  whatsapp_config: [
    { id: 'cfg-watim', account_id: 'watim', phone_number_id: '1378420525354337', user_id: 'u1' },
    { id: 'cfg-other', account_id: 'other', phone_number_id: '1366111143256348', user_id: 'u2' },
  ],
  whatsapp_additional_numbers: [{ phone_number_id: '1280271028514037', account_id: 'watim' }],
};

describe('resolveConfigForPhoneNumber', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});

  it('matches a college\'s main number directly', async () => {
    const r = await resolveConfigForPhoneNumber(fakeDb(tables), '1378420525354337');
    expect(r).toEqual({ config: tables.whatsapp_config[0], viaAdditional: false });
  });

  it('routes an additional number to its college, with the college\'s main config', async () => {
    const r = await resolveConfigForPhoneNumber(fakeDb(tables), '1280271028514037');
    expect(r).toEqual({ config: tables.whatsapp_config[0], viaAdditional: true });
  });

  it('drops a number that belongs to no college', async () => {
    expect(await resolveConfigForPhoneNumber(fakeDb(tables), '999999999')).toBeNull();
  });

  it('drops an additional number whose college has no main config', async () => {
    const t = { ...tables, whatsapp_additional_numbers: [{ phone_number_id: '555', account_id: 'nobody' }] };
    expect(await resolveConfigForPhoneNumber(fakeDb(t), '555')).toBeNull();
  });

  it('drops a number claimed by two configs', async () => {
    const t = { ...tables, whatsapp_config: [...tables.whatsapp_config, { id: 'dup', account_id: 'x', phone_number_id: '1378420525354337' }] };
    expect(await resolveConfigForPhoneNumber(fakeDb(t), '1378420525354337')).toBeNull();
  });

  it('treats a missing additional-numbers table (pre-065) as unknown', async () => {
    expect(await resolveConfigForPhoneNumber(fakeDb(tables, 'whatsapp_additional_numbers'), '1280271028514037')).toBeNull();
  });

  it('returns null without a phone number id', async () => {
    expect(await resolveConfigForPhoneNumber(fakeDb(tables), undefined)).toBeNull();
  });
});
