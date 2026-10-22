import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const engineSendText = vi.fn();
let sendFails = false;
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: async (...a: unknown[]) => {
    if (sendFails) throw new Error('meta down');
    return engineSendText(...a);
  },
}));

const { handleOptKeyword, OPT_OUT_CONFIRMATION, OPT_IN_CONFIRMATION } = await import('./opt-keywords');

function recordingDb() {
  const calls: { table: string; op: string; payload?: unknown; filters: [string, unknown][] }[] = [];
  const db = {
    from(table: string) {
      const call = { table, op: '', payload: undefined as unknown, filters: [] as [string, unknown][] };
      calls.push(call);
      const b = {
        upsert(payload: unknown) { call.op = 'upsert'; call.payload = payload; return b; },
        delete() { call.op = 'delete'; return b; },
        update(payload: unknown) { call.op = 'update'; call.payload = payload; return b; },
        eq(c: string, v: unknown) { call.filters.push([c, v]); return b; },
        then: (resolve: (x: unknown) => unknown) => Promise.resolve(resolve({ error: null })),
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const base = {
  accountId: 'acc', userId: 'u', contactId: 'c1', conversationId: 'conv', contactPhone: '+92 300 1112233',
};

beforeEach(() => {
  sendFails = false;
  engineSendText.mockReset().mockResolvedValue({ whatsapp_message_id: 'w' });
});

describe('handleOptKeyword', () => {
  it('ignores ordinary messages', async () => {
    const { db, calls } = recordingDb();
    expect(await handleOptKeyword(db, { ...base, text: 'When does admission open?' })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(engineSendText).not.toHaveBeenCalled();
  });

  it('STOP adds the digits-only number to the exclusion list and confirms', async () => {
    const { db, calls } = recordingDb();
    expect(await handleOptKeyword(db, { ...base, text: 'STOP' })).toBe(true);
    expect(calls[0]).toMatchObject({
      table: 'contact_exclusions', op: 'upsert',
      payload: { account_id: 'acc', phone_normalized: '923001112233', reason: 'opt_out' },
    });
    expect(engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: OPT_OUT_CONFIRMATION, contactId: 'c1' }));
  });

  it('START removes the exclusion, records consent from the reply and confirms', async () => {
    const { db, calls } = recordingDb();
    expect(await handleOptKeyword(db, { ...base, text: 'start' })).toBe(true);
    expect(calls[0]).toMatchObject({ table: 'contact_exclusions', op: 'delete' });
    expect(calls[0].filters).toEqual([['account_id', 'acc'], ['phone_normalized', '923001112233']]);
    expect(calls[1]).toMatchObject({ table: 'contacts', op: 'update', payload: { consent_status: 'granted', consent_source: 'start_reply' } });
    expect(engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: OPT_IN_CONFIRMATION }));
  });

  it('still reports the opt-out as handled when the confirmation fails to send', async () => {
    sendFails = true;
    const { db } = recordingDb();
    expect(await handleOptKeyword(db, { ...base, text: 'unsubscribe' })).toBe(true);
  });

  it('does nothing for a contact with no phone number', async () => {
    const { db, calls } = recordingDb();
    expect(await handleOptKeyword(db, { ...base, contactPhone: '', text: 'STOP' })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
