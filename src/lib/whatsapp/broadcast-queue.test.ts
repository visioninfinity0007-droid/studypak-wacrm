import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `dec:${v}` }));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: async () => ({ row: null, language: 'en', malformed: false }),
}));

const { MetaApiError } = await import('@/lib/whatsapp/meta-api');
const {
  drainBroadcast, runQueueTick, INTERRUPTED_MESSAGE, MAX_ATTEMPTS, QUEUE_LEASE_MS,
} = await import('./broadcast-queue');

// ------------------------------------------------------------
// In-memory PostgREST-ish fake: enough of the builder for the queue,
// consent-server and finalizeBroadcastStatus.
// ------------------------------------------------------------
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>) {
  const cmp = (a: unknown, b: unknown) => String(a ?? '').localeCompare(String(b ?? ''));
  function parseOr(expr: string): (r: Row) => boolean {
    const parts = expr.split(',').map((p) => {
      const [col, op, ...rest] = p.split('.');
      const val = rest.join('.');
      if (op === 'is' && val === 'null') return (r: Row) => r[col] == null;
      if (op === 'lt') return (r: Row) => r[col] != null && cmp(r[col], val) < 0;
      if (op === 'lte') return (r: Row) => r[col] != null && cmp(r[col], val) <= 0;
      throw new Error(`unsupported or(): ${p}`);
    });
    return (r) => parts.some((f) => f(r));
  }
  const db = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let mode: 'select' | 'update' = 'select';
      let payload: Row = {};
      let cols = '*';
      let head = false;
      let count = false;
      let returning = false;
      let limitN = Infinity;
      const orders: string[] = [];
      const rowsOf = () => (tables[table] ??= []);
      const project = (r: Row): Row => {
        if (!cols.includes('contact:contacts')) return r;
        const contact = (tables.contacts ?? []).find((c) => c.id === r.contact_id) ?? null;
        return { ...r, contact: contact ? { phone: contact.phone } : null };
      };
      const exec = () => {
        let matched = rowsOf().filter((r) => filters.every((f) => f(r)));
        if (mode === 'update') {
          for (const r of matched) Object.assign(r, payload);
          return { data: returning ? matched.map((r) => ({ ...r })) : null, error: null };
        }
        for (const o of [...orders].reverse()) matched = [...matched].sort((a, b) => cmp(a[o], b[o]));
        const total = matched.length;
        if (head) return { data: null, count: total, error: null };
        return { data: matched.slice(0, limitN).map(project), count: count ? total : null, error: null };
      };
      const b = {
        select(c = '*', opts?: { count?: string; head?: boolean }) {
          if (mode === 'update') returning = true; else cols = c;
          head = !!opts?.head; count = opts?.count === 'exact';
          return b;
        },
        update(p: Row) { mode = 'update'; payload = p; return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        in(c: string, vs: unknown[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return b; },
        not(c: string, op: string, v: unknown) {
          if (op === 'is' && v === null) filters.push((r) => r[c] != null);
          return b;
        },
        or(expr: string) { filters.push(parseOr(expr)); return b; },
        order(c: string) { orders.push(c); return b; },
        limit(n: number) { limitN = n; return b; },
        maybeSingle: () => { const r = exec(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: null }); },
        then: (resolve: (x: unknown) => unknown) => Promise.resolve(resolve(exec())),
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return db;
}

// ------------------------------------------------------------
const T0 = Date.parse('2026-10-22T10:00:00Z');
let clock = T0;
const now = () => clock;
const sleep = vi.fn(async (ms: number) => { clock += ms; });

function world(opts: { recipients?: Partial<Row>[]; consent?: string; lockedAt?: string | null } = {}) {
  const contacts: Row[] = [];
  const recipients: Row[] = (opts.recipients ?? [{}, {}]).map((over, i) => {
    const phone = `+92300000000${i}`;
    contacts.push({
      id: `c${i}`, account_id: 'acc', phone, phone_normalized: phone.replace(/\D/g, ''),
      consent_status: opts.consent ?? 'granted',
    });
    return {
      id: `r${i}`, broadcast_id: 'b1', contact_id: `c${i}`, status: 'pending', attempt_count: 0,
      next_attempt_at: null, attempt_started_at: null, template_params: ['Ali'],
      created_at: `2026-10-22T09:00:0${i}Z`, ...over,
    };
  });
  const tables: Record<string, Row[]> = {
    broadcasts: [{
      id: 'b1', account_id: 'acc', status: 'sending', scheduled_at: null, template_name: 'tpl',
      template_language: 'en', send_params: null, delivery_locked_at: opts.lockedAt ?? null, updated_at: 'x',
    }],
    broadcast_recipients: recipients,
    contacts,
    contact_exclusions: [],
    whatsapp_config: [{ account_id: 'acc', phone_number_id: 'pn', access_token: 'enc' }],
  };
  return { db: fakeDb(tables), tables };
}

const metaErr = (code: number, httpStatus = 400) => new MetaApiError(`meta ${code}`, { code, httpStatus });

beforeEach(() => { clock = T0; sleep.mockClear(); delete process.env.BROADCAST_SENDING_PAUSED; });
afterEach(() => { delete process.env.BROADCAST_MESSAGES_PER_SECOND; });

describe('drainBroadcast', () => {
  it('sends every pending recipient from the server, paced, then finalizes and releases the lease', async () => {
    const { db, tables } = world();
    const send = vi.fn(async () => ({ messageId: `wamid.${send.mock.calls.length}` }));
    const res = await drainBroadcast(db, 'b1', T0 + 60_000, { send, sleep, now });

    expect(res).toMatchObject({ sent: 2, failed: 0, retrying: 0, remaining: 0, finished: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({ phoneNumberId: 'pn', accessToken: 'dec:enc', to: '923000000000', params: ['Ali'] });
    expect(sleep).toHaveBeenCalledWith(100); // default 10 msg/s
    expect(tables.broadcast_recipients.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(tables.broadcast_recipients[0]).toMatchObject({ attempt_started_at: null, attempt_count: 1, whatsapp_message_id: 'wamid.1' });
    expect(tables.broadcasts[0]).toMatchObject({ status: 'sent', delivery_locked_at: null });
  });

  it('respects BROADCAST_MESSAGES_PER_SECOND', async () => {
    process.env.BROADCAST_MESSAGES_PER_SECOND = '4';
    const { db } = world();
    await drainBroadcast(db, 'b1', T0 + 60_000, { send: async () => ({ messageId: 'w' }), sleep, now });
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('does nothing while another worker holds a fresh lease', async () => {
    const { db } = world({ lockedAt: new Date(T0 - 10_000).toISOString() });
    const send = vi.fn();
    expect(await drainBroadcast(db, 'b1', T0 + 60_000, { send, sleep, now })).toMatchObject({ skipped: 'locked' });
    expect(send).not.toHaveBeenCalled();
  });

  it('takes over a crashed worker\'s expired lease and does not resend the in-flight row', async () => {
    const { db, tables } = world({
      lockedAt: new Date(T0 - QUEUE_LEASE_MS - 1).toISOString(),
      recipients: [{ attempt_started_at: new Date(T0 - 200_000).toISOString(), attempt_count: 1 }, {}],
    });
    const send = vi.fn(async () => ({ messageId: 'w' }));
    const res = await drainBroadcast(db, 'b1', T0 + 60_000, { send, sleep, now });
    expect(res).toMatchObject({ recoveredInterrupted: 1, sent: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(tables.broadcast_recipients[0]).toMatchObject({ status: 'failed', error_message: INTERRUPTED_MESSAGE });
    expect(tables.broadcast_recipients[1]).toMatchObject({ status: 'sent' });
  });

  it('retries a temporary Meta error later instead of failing it', async () => {
    const { db, tables } = world({ recipients: [{}] });
    const res = await drainBroadcast(db, 'b1', T0 + 60_000, { send: async () => { throw metaErr(131000, 500); }, sleep, now });
    expect(res).toMatchObject({ retrying: 1, failed: 0, remaining: 1, finished: false });
    const row = tables.broadcast_recipients[0];
    expect(row).toMatchObject({ status: 'pending', attempt_count: 1, attempt_started_at: null });
    expect(Date.parse(String(row.next_attempt_at))).toBe(T0 + 60_000);
    expect(tables.broadcasts[0].status).toBe('sending');
  });

  it('treats a network failure as retryable', async () => {
    const { db, tables } = world({ recipients: [{}] });
    await drainBroadcast(db, 'b1', T0 + 60_000, { send: async () => { throw new TypeError('fetch failed'); }, sleep, now });
    expect(tables.broadcast_recipients[0].status).toBe('pending');
  });

  it('fails a permanent Meta error immediately with Meta\'s message', async () => {
    const { db, tables } = world({ recipients: [{}] });
    const res = await drainBroadcast(db, 'b1', T0 + 60_000, { send: async () => { throw metaErr(132001); }, sleep, now });
    expect(res).toMatchObject({ failed: 1, retrying: 0, finished: true });
    expect(tables.broadcast_recipients[0]).toMatchObject({ status: 'failed', error_message: 'meta 132001' });
    expect(tables.broadcasts[0].status).toBe('failed');
  });

  it('stops the whole pass on a rate-limit error and backs off', async () => {
    const { db, tables } = world();
    const send = vi.fn(async () => { throw metaErr(130429, 429); });
    const res = await drainBroadcast(db, 'b1', T0 + 60_000, { send, sleep, now });
    expect(send).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ retrying: 1, remaining: 2 });
    expect(tables.broadcast_recipients[1]).toMatchObject({ status: 'pending', attempt_count: 0 });
  });

  it('gives up after MAX_ATTEMPTS', async () => {
    const { db, tables } = world({ recipients: [{ attempt_count: MAX_ATTEMPTS - 1 }] });
    await drainBroadcast(db, 'b1', T0 + 60_000, { send: async () => { throw metaErr(131000, 500); }, sleep, now });
    expect(tables.broadcast_recipients[0]).toMatchObject({ status: 'failed', attempt_count: MAX_ATTEMPTS });
  });

  it('skips rows whose retry is not yet due', async () => {
    const { db } = world({ recipients: [{ next_attempt_at: new Date(T0 + 30_000).toISOString() }] });
    const send = vi.fn();
    const res = await drainBroadcast(db, 'b1', T0 + 60_000, { send, sleep, now });
    expect(send).not.toHaveBeenCalled();
    expect(res).toMatchObject({ remaining: 1, finished: false });
  });

  it('refuses contacts without recorded consent (requirement 3)', async () => {
    const { db, tables } = world({ recipients: [{}], consent: 'unknown' });
    const send = vi.fn();
    await drainBroadcast(db, 'b1', T0 + 60_000, { send, sleep, now });
    expect(send).not.toHaveBeenCalled();
    expect(tables.broadcast_recipients[0]).toMatchObject({ status: 'failed', error_message: 'Not sent: no recorded consent for this contact' });
  });

  it('stops at the deadline and leaves the rest pending for the next tick', async () => {
    const { db, tables } = world({ recipients: [{}, {}, {}] });
    const res = await drainBroadcast(db, 'b1', T0 + 150, { send: async () => ({ messageId: 'w' }), sleep, now });
    expect(res.sent).toBe(2);
    expect(res).toMatchObject({ remaining: 1, finished: false });
    expect(tables.broadcasts[0]).toMatchObject({ status: 'sending', delivery_locked_at: null });
  });

  it('sends nothing while BROADCAST_SENDING_PAUSED=true', async () => {
    process.env.BROADCAST_SENDING_PAUSED = 'true';
    const { db } = world();
    const send = vi.fn();
    expect(await drainBroadcast(db, 'b1', T0 + 60_000, { send, sleep, now })).toMatchObject({ skipped: 'paused' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('runQueueTick', () => {
  it('starts a scheduled broadcast once it is due, and leaves a future one alone', async () => {
    const { db, tables } = world({ recipients: [{}] });
    tables.broadcasts[0].status = 'scheduled';
    tables.broadcasts[0].scheduled_at = new Date(T0 + 3_600_000).toISOString();
    const send = vi.fn(async () => ({ messageId: 'w' }));
    expect(await runQueueTick(db, T0 + 50_000, { send, sleep, now })).toEqual([]);
    expect(send).not.toHaveBeenCalled();

    tables.broadcasts[0].scheduled_at = new Date(T0 - 1).toISOString();
    const [res] = await runQueueTick(db, T0 + 50_000, { send, sleep, now });
    expect(res).toMatchObject({ sent: 1, finished: true });
    expect(tables.broadcasts[0].status).toBe('sent');
  });
});
