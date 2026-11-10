import { beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny table store the user client (RLS) and the service client share.
type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  drain: vi.fn(),
  afterFns: [] as (() => Promise<void>)[],
}));

function fakeClient() {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let mode: 'select' | 'update' | 'delete' = 'select';
      let patch: Row = {};
      const rows = () => (h.tables[table] ??= []);
      const run = () => {
        const hit = rows().filter((r) => filters.every((f) => f(r)));
        if (mode === 'update') hit.forEach((r) => Object.assign(r, patch));
        if (mode === 'delete') h.tables[table] = rows().filter((r) => !hit.includes(r));
        return hit;
      };
      const b = {
        select() { return b; },
        update(p: Row) { mode = 'update'; patch = p; return b; },
        delete() { mode = 'delete'; return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (x: unknown) => unknown) =>
          Promise.resolve(resolve({ data: run().map((r) => ({ id: r.id })), error: null })),
      };
      return b;
    },
  };
}

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
  after: (fn: () => Promise<void>) => { h.afterFns.push(fn); },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'acc-1', userId: 'u1', role: 'agent', supabase: fakeClient() }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 500,
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseServiceRole: () => fakeClient() }));

vi.mock('@/lib/whatsapp/broadcast-queue', () => ({
  drainBroadcast: h.drain,
  isSendingPaused: () => false,
}));

import { POST as schedulePOST } from './route';
import { POST as queuePOST } from '../queue/route';

type Res = Promise<{ status: number; body: Record<string, unknown> }>;
const call = (handler: typeof schedulePOST, body: unknown) =>
  handler(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'b1' }) },
  ) as unknown as Res;

const inHours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

beforeEach(() => {
  h.afterFns = [];
  h.drain.mockReset();
  h.tables = {
    broadcasts: [{ id: 'b1', account_id: 'acc-1', status: 'scheduled', scheduled_at: inHours(2), total_recipients: 2 }],
    broadcast_recipients: [
      { id: 'r1', broadcast_id: 'b1', status: 'pending' },
      { id: 'r2', broadcast_id: 'b1', status: 'pending' },
      { id: 'r3', broadcast_id: 'other', status: 'pending' },
    ],
  };
});

describe('POST /api/whatsapp/broadcast/[id]/schedule', () => {
  it('moves the send time', async () => {
    const at = inHours(5);
    const res = await call(schedulePOST, { action: 'reschedule', scheduledAt: at });
    expect(res.status).toBe(200);
    expect(h.tables.broadcasts[0].scheduled_at).toBe(at);
    expect(h.tables.broadcasts[0].status).toBe('scheduled');
  });

  it('refuses a send time in the past', async () => {
    const before = h.tables.broadcasts[0].scheduled_at;
    const res = await call(schedulePOST, { action: 'reschedule', scheduledAt: inHours(-1) });
    expect(res.status).toBe(400);
    expect(h.tables.broadcasts[0].scheduled_at).toBe(before);
  });

  it('starts sending at once on send_now', async () => {
    const res = await call(schedulePOST, { action: 'send_now' });
    expect(res.status).toBe(202);
    expect(h.tables.broadcasts[0].status).toBe('sending');
    await Promise.all(h.afterFns.map((f) => f()));
    expect(h.drain).toHaveBeenCalledWith(expect.anything(), 'b1', expect.any(Number));
  });

  it('cancel turns it back into a draft and drops only its recipients', async () => {
    const res = await call(schedulePOST, { action: 'cancel' });
    expect(res.status).toBe(200);
    expect(h.tables.broadcasts[0]).toMatchObject({ status: 'draft', scheduled_at: null, total_recipients: 0 });
    expect(h.tables.broadcast_recipients.map((r) => r.id)).toEqual(['r3']);
  });

  it('leaves a campaign alone once it is no longer scheduled', async () => {
    h.tables.broadcasts[0].status = 'sending';
    for (const action of ['send_now', 'cancel', 'reschedule'] as const) {
      const res = await call(schedulePOST, { action, scheduledAt: inHours(3) });
      expect(res.status).toBe(409);
    }
    expect(h.tables.broadcast_recipients).toHaveLength(3);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('rejects unknown actions', async () => {
    expect((await call(schedulePOST, { action: 'delete' })).status).toBe(400);
  });
});

describe('POST /api/whatsapp/broadcast/[id]/queue with a send time', () => {
  beforeEach(() => {
    h.tables.broadcasts[0] = { id: 'b1', account_id: 'acc-1', status: 'draft', scheduled_at: null };
  });

  it('parks a new campaign as scheduled without sending', async () => {
    const at = inHours(3);
    const res = await call(queuePOST, { scheduledAt: at });
    expect(res.status).toBe(202);
    expect(h.tables.broadcasts[0]).toMatchObject({ status: 'scheduled', scheduled_at: at });
    expect(h.afterFns).toHaveLength(0);
  });

  it('refuses a time that is too soon and leaves the campaign untouched', async () => {
    const res = await call(queuePOST, { scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    expect(res.status).toBe(400);
    expect(h.tables.broadcasts[0].status).toBe('draft');
  });

  it('still sends at once without a send time', async () => {
    const res = await queuePOST(new Request('http://x', { method: 'POST' }), {
      params: Promise.resolve({ id: 'b1' }),
    }) as unknown as Awaited<Res>;
    expect(res.status).toBe(202);
    expect(h.tables.broadcasts[0].status).toBe('sending');
    expect(h.afterFns).toHaveLength(1);
  });
});
