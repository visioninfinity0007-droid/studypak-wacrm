import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { askAgent, dispatchToElevenLabsAgent, historyNote, parseBridgeAgents } from './agent-bridge';

const ACCOUNT = '7a9296cc-ba03-45a8-aa5e-bf20bc5a5aab';
const AGENT = 'agent_qasim';

/** A socket that plays the agent: greets on connect, answers user messages. */
function fakeAgent(opts: { greet?: boolean; answer?: (text: string) => string | null } = {}) {
  const sent: Record<string, unknown>[] = [];
  const ws = {
    onopen: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
    onclose: null as ((ev: unknown) => void) | null,
    closed: false,
    emit(msg: unknown) {
      queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify(msg) }));
    },
    send(data: string) {
      const msg = JSON.parse(data);
      sent.push(msg);
      if (msg.type === 'conversation_initiation_client_data') {
        ws.emit({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: {} });
        ws.emit({ type: 'ping', ping_event: { event_id: 7 } });
        if (opts.greet !== false) ws.emit({ type: 'agent_response', agent_response_event: { agent_response: 'Welcome!' } });
      }
      if (msg.type === 'user_message') {
        const answer = (opts.answer ?? ((t: string) => `Answer to: ${t}`))(msg.text);
        if (answer !== null) ws.emit({ type: 'agent_response', agent_response_event: { agent_response: answer } });
      }
    },
    close() {
      ws.closed = true;
    },
  };
  // Opens once askAgent has attached its handlers, like a real socket.
  const open = () => {
    setTimeout(() => ws.onopen?.({}), 0);
    return ws;
  };
  return { ws, sent, open };
}

const signedUrl = vi.fn(async () => new Response(JSON.stringify({ signed_url: 'wss://agent.example/x' })));

describe('parseBridgeAgents', () => {
  it('reads account=agent pairs and skips junk', () => {
    const map = parseBridgeAgents(` ${ACCOUNT}=${AGENT} , broken, =x, acc2 = agent2 `);
    expect([...map.entries()]).toEqual([
      [ACCOUNT, AGENT],
      ['acc2', 'agent2'],
    ]);
    expect(parseBridgeAgents(undefined).size).toBe(0);
  });
});

describe('historyNote', () => {
  it('labels the turns and is null without history', () => {
    expect(historyNote([])).toBeNull();
    expect(
      historyNote([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ]),
    ).toMatch(/Student: Hi\nCollege: Hello$/);
  });
});

describe('askAgent', () => {
  it('lets the greeting pass, sends the history, and returns the answer', async () => {
    const { ws, sent, open } = fakeAgent();
    const answer = await askAgent({
      apiKey: 'k',
      agentId: AGENT,
      text: 'MBBS fee?',
      history: [{ role: 'user', content: 'Hi' }],
      fetchImpl: signedUrl as never,
      openSocket: open,
    });
    expect(answer).toBe('Answer to: MBBS fee?');
    expect(signedUrl).toHaveBeenCalledWith(expect.stringContaining(`agent_id=${AGENT}`), expect.anything());
    expect(sent.map((m) => m.type)).toEqual([
      'conversation_initiation_client_data',
      'pong',
      'contextual_update',
      'user_message',
    ]);
    expect(ws.closed).toBe(true);
  });

  it('asks anyway when the agent does not greet', async () => {
    const { open } = fakeAgent({ greet: false });
    const answer = await askAgent({
      apiKey: 'k',
      agentId: AGENT,
      text: 'Hello',
      history: [],
      fetchImpl: signedUrl as never,
      openSocket: open,
      greetingWaitMs: 5,
    });
    expect(answer).toBe('Answer to: Hello');
  });

  it('gives up with null when the agent stays silent', async () => {
    const { ws, open } = fakeAgent({ answer: () => null });
    const answer = await askAgent({
      apiKey: 'k',
      agentId: AGENT,
      text: 'Hello',
      history: [],
      fetchImpl: signedUrl as never,
      openSocket: open,
      timeoutMs: 30,
    });
    expect(answer).toBeNull();
    expect(ws.closed).toBe(true);
  });
});

function fakeDb(opts: { disabled?: boolean; newest?: string; context?: { sender_type: string; content_text: string }[] }) {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = vi.fn(chain);
      b.maybeSingle = async () => ({ data: { ai_autoreply_disabled: !!opts.disabled }, error: null });
      b.then = (resolve: (v: unknown) => unknown) => {
        // messages: newest-first for both the context and the newer-inbound check
        const rows =
          table === 'messages'
            ? opts.context
              ? [...opts.context].reverse().map((m) => ({ ...m, message_id: opts.newest ?? 'wamid.1' }))
              : [{ message_id: opts.newest ?? 'wamid.1', sender_type: 'customer', content_text: 'x' }]
            : [];
        return Promise.resolve(resolve({ data: rows, error: null }));
      };
      return b;
    },
  };
}

describe('dispatchToElevenLabsAgent', () => {
  beforeEach(() => {
    vi.stubEnv('ELEVENLABS_BRIDGE_AGENTS', `${ACCOUNT}=${AGENT}`);
    vi.stubEnv('ELEVENLABS_API_KEY', 'sk_test');
  });
  afterEach(() => vi.unstubAllEnvs());

  const base = {
    accountId: ACCOUNT,
    conversationId: 'conv-1',
    contactId: 'contact-1',
    configOwnerUserId: 'user-1',
    text: 'MBBS fee?',
    inboundMessageId: 'wamid.1',
  };

  it('leaves accounts that are not bridged alone', async () => {
    const ask = vi.fn();
    const handled = await dispatchToElevenLabsAgent(
      { ...base, accountId: 'other', db: fakeDb({}) as never },
      { ask, send: vi.fn() },
    );
    expect(handled).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('sends the agent answer from the college number as a bot reply', async () => {
    const ask = vi.fn(async () => 'Rs 1.8m per year');
    const send = vi.fn(async () => ({}));
    const db = fakeDb({
      context: [
        { sender_type: 'customer', content_text: 'Hi' },
        { sender_type: 'bot', content_text: 'Welcome' },
        { sender_type: 'customer', content_text: 'MBBS fee?' },
      ],
    });
    expect(await dispatchToElevenLabsAgent({ ...base, db: db as never }, { ask, send })).toBe(true);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        apiKey: 'sk_test',
        text: 'MBBS fee?',
        // the new message is not repeated as history
        history: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Welcome' },
        ],
      }),
    );
    expect(send).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      text: 'Rs 1.8m per year',
      aiGenerated: true,
    });
  });

  it('stays quiet when the bot is switched off for the chat', async () => {
    const ask = vi.fn();
    await dispatchToElevenLabsAgent({ ...base, db: fakeDb({ disabled: true }) as never }, { ask, send: vi.fn() });
    expect(ask).not.toHaveBeenCalled();
  });

  it('skips the send when the student wrote again meanwhile', async () => {
    const send = vi.fn();
    await dispatchToElevenLabsAgent(
      { ...base, db: fakeDb({ newest: 'wamid.2' }) as never },
      { ask: async () => 'answer', send },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the agent fails', async () => {
    const send = vi.fn();
    const handled = await dispatchToElevenLabsAgent(
      { ...base, db: fakeDb({}) as never },
      {
        ask: async () => {
          throw new Error('down');
        },
        send,
      },
    );
    expect(handled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});
