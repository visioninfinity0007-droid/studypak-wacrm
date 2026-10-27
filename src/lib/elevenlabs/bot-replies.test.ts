import { beforeEach, describe, expect, it, vi } from 'vitest';

const routing = vi.hoisted(() => ({
  resolveConfigForPhoneNumber: vi.fn(),
}));
vi.mock('@/lib/whatsapp/number-routing', () => routing);

const dedupe = vi.hoisted(() => ({
  findExistingContact: vi.fn(),
}));
vi.mock('@/lib/contacts/dedupe', () => dedupe);

import {
  __resetBotReplySyncForTests,
  botRepliesFromConversation,
  syncElevenLabsBotReplies,
  type ElevenLabsConversation,
} from './bot-replies';

const START = 1793104083;

function conversation(over: Partial<ElevenLabsConversation> = {}): ElevenLabsConversation {
  return {
    conversation_id: 'conv_1',
    metadata: {
      start_time_unix_secs: START,
      whatsapp: { whatsapp_phone_number_id: 'PN-1', whatsapp_user_id: '923001110001' },
    },
    transcript: [
      { id: 'u1', role: 'user', message: 'Private ha ya', time_in_call_secs: 0 },
      { id: 'a1', role: 'agent', message: 'It is a private college.', time_in_call_secs: 0 },
      { id: 't1', role: 'agent', message: null, time_in_call_secs: 5 },
      { id: 'u2', role: 'user', message: 'Fee?', time_in_call_secs: 17 },
      { id: 'a2', role: 'agent', message: ' Fee is on the website. ', time_in_call_secs: 17 },
    ],
    ...over,
  };
}

describe('botRepliesFromConversation', () => {
  it('keeps only the agent turns that have text, timed from the start', () => {
    expect(botRepliesFromConversation(conversation())).toEqual([
      {
        messageId: 'elevenlabs:a1',
        text: 'It is a private college.',
        createdAt: new Date(START * 1000).toISOString(),
      },
      {
        messageId: 'elevenlabs:a2',
        text: 'Fee is on the website.',
        createdAt: new Date((START + 17) * 1000).toISOString(),
      },
    ]);
  });

  it('falls back to conversation and position when a turn has no id', () => {
    const conv = conversation({ transcript: [{ role: 'agent', message: 'Hi' }] });
    expect(botRepliesFromConversation(conv)[0].messageId).toBe('elevenlabs:conv_1:0');
  });
});

// ---------------------------------------------------------------- sync

let upserts: { rows: Record<string, unknown>[]; opts: unknown }[];
let chatUpdates: Record<string, unknown>[];
let chat: { id: string; last_message_at: string | null } | null;

function makeDb() {
  return {
    from: vi.fn((table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['select', 'eq', 'order']) b[m] = vi.fn(chain);
      b.limit = vi.fn(async () => ({ data: chat ? [chat] : [], error: null }));
      b.upsert = vi.fn((rows: Record<string, unknown>[], opts: unknown) => {
        upserts.push({ rows, opts });
        return { select: async () => ({ data: rows.map((_, i) => ({ id: `m${i}` })), error: null }) };
      });
      b.update = vi.fn((patch: Record<string, unknown>) => {
        if (table === 'conversations') chatUpdates.push(patch);
        return { eq: async () => ({ error: null }) };
      });
      return b;
    }),
  };
}

function fetchFor(list: unknown[], detail: ElevenLabsConversation) {
  return vi.fn(async (url: string) => {
    const body = url.includes('/conversations?') ? { conversations: list, has_more: false } : detail;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  __resetBotReplySyncForTests();
  upserts = [];
  chatUpdates = [];
  chat = { id: 'chat-1', last_message_at: '2026-10-27T12:28:40.000+00:00' };
  routing.resolveConfigForPhoneNumber.mockReset();
  routing.resolveConfigForPhoneNumber.mockResolvedValue({ config: { account_id: 'acct-1' }, viaAdditional: false });
  dedupe.findExistingContact.mockReset();
  dedupe.findExistingContact.mockResolvedValue({ id: 'contact-1', phone: '+923001110001' });
});

describe('syncElevenLabsBotReplies', () => {
  const list = [{ conversation_id: 'conv_1', message_count: 5 }];

  it('copies the agent replies into the student’s chat as bot messages', async () => {
    const fetchImpl = fetchFor(list, conversation());
    const db = makeDb();
    const res = await syncElevenLabsBotReplies(db as never, { apiKey: 'k', fetchImpl: fetchImpl as never });

    expect(res).toEqual({ conversations: 1, fetched: 1, inserted: 2, skipped: 0 });
    expect(routing.resolveConfigForPhoneNumber).toHaveBeenCalledWith(db, 'PN-1');
    expect(dedupe.findExistingContact).toHaveBeenCalledWith(db, 'acct-1', '+923001110001');
    expect(upserts[0].opts).toEqual({ onConflict: 'conversation_id,message_id', ignoreDuplicates: true });
    expect(upserts[0].rows[0]).toMatchObject({
      conversation_id: 'chat-1',
      sender_type: 'bot',
      message_id: 'elevenlabs:a1',
    });
    expect(chatUpdates).toEqual([]); // the chat's last message is newer than the bot's
  });

  it('does not refetch a conversation whose message count has not changed', async () => {
    const fetchImpl = fetchFor(list, conversation());
    const db = makeDb();
    await syncElevenLabsBotReplies(db as never, { apiKey: 'k', fetchImpl: fetchImpl as never });
    const again = await syncElevenLabsBotReplies(db as never, { apiKey: 'k', fetchImpl: fetchImpl as never });
    expect(again.fetched).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // list, detail, list
  });

  it('skips and retries later when the student has no portal chat yet', async () => {
    chat = null;
    const fetchImpl = fetchFor(list, conversation());
    const db = makeDb();
    const first = await syncElevenLabsBotReplies(db as never, { apiKey: 'k', fetchImpl: fetchImpl as never });
    expect(first.skipped).toBe(1);
    expect(upserts).toHaveLength(0);
    const second = await syncElevenLabsBotReplies(db as never, { apiKey: 'k', fetchImpl: fetchImpl as never });
    expect(second.fetched).toBe(1);
  });

  it('ignores a number that belongs to no college', async () => {
    routing.resolveConfigForPhoneNumber.mockResolvedValue(null);
    const fetchImpl = fetchFor(list, conversation());
    const res = await syncElevenLabsBotReplies(makeDb() as never, { apiKey: 'k', fetchImpl: fetchImpl as never });
    expect(res.inserted).toBe(0);
    expect(dedupe.findExistingContact).not.toHaveBeenCalled();
  });

  it('updates the chat preview when the bot spoke last', async () => {
    chat = { id: 'chat-1', last_message_at: '2026-10-01T00:00:00+00:00' };
    const fetchImpl = fetchFor(list, conversation());
    await syncElevenLabsBotReplies(makeDb() as never, { apiKey: 'k', fetchImpl: fetchImpl as never });
    expect(chatUpdates).toEqual([
      {
        last_message_text: 'Fee is on the website.',
        last_message_at: new Date((START + 17) * 1000).toISOString(),
      },
    ]);
  });

  it('lists from `sinceUnix` when given, otherwise a week back', async () => {
    const fetchImpl = fetchFor([], conversation());
    const nowMs = Date.UTC(2026, 9, 27);
    await syncElevenLabsBotReplies(makeDb() as never, { apiKey: 'k', nowMs, fetchImpl: fetchImpl as never });
    await syncElevenLabsBotReplies(makeDb() as never, { apiKey: 'k', sinceUnix: 1792627200, fetchImpl: fetchImpl as never });
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain(`call_start_after_unix=${nowMs / 1000 - 7 * 86400}`);
    expect(urls[1]).toContain('call_start_after_unix=1792627200');
  });

  it('throws on an ElevenLabs error so the route answers 500', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(
      syncElevenLabsBotReplies(makeDb() as never, { apiKey: 'bad', fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/ElevenLabs 401/);
  });
});
