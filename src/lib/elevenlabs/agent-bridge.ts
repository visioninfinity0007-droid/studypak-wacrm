// Answer a college's WhatsApp messages with its ElevenLabs agent, through
// the portal.
//
// ElevenLabs' own WhatsApp integration only hears a number when its app is
// subscribed to that number's WhatsApp Business Account in Meta. When that
// can't be arranged (0323's account was linked to the wrong WABA), the
// portal does the relaying instead: every customer message the webhook
// receives for a bridged account is sent to the agent as a text chat, and
// the agent's answer goes back to the customer from the college's own
// number, saved in the Inbox as a bot reply (blue bubble).
//
// Which accounts are bridged, and to which agent, comes from
// ELEVENLABS_BRIDGE_AGENTS: comma-separated `<account id>=<agent id>`
// pairs. An account that isn't listed is never touched, so a number that
// ElevenLabs already answers directly (0310) must NOT be listed, or the
// customer gets two answers.
//
// Never throws: a failing or slow agent must not affect the webhook.

import type { SupabaseClient } from '@supabase/supabase-js';

import { buildConversationContext } from '@/lib/ai/context';
import type { ChatMessage } from '@/lib/ai/types';

const API_BASE = 'https://api.elevenlabs.io/v1/convai';
/** Give up on the agent after this long; the message stays in the Inbox. */
const ANSWER_TIMEOUT_MS = 45_000;
/** How long to wait for the agent's greeting before asking anyway. */
const GREETING_WAIT_MS = 3_000;
/** Earlier turns handed to the agent so it can follow the chat. */
const HISTORY_LIMIT = 20;

/** `<account id>=<agent id>` pairs from ELEVENLABS_BRIDGE_AGENTS. */
export function parseBridgeAgents(raw: string | undefined | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const [accountId, agentId] = pair.split('=').map((s) => s?.trim());
    if (accountId && agentId) map.set(accountId, agentId);
  }
  return map;
}

export function bridgeAgentForAccount(accountId: string): string | null {
  return parseBridgeAgents(process.env.ELEVENLABS_BRIDGE_AGENTS).get(accountId) ?? null;
}

/** The earlier turns, as a note the agent reads before the new message. */
export function historyNote(history: ChatMessage[]): string | null {
  if (history.length === 0) return null;
  const lines = history.map((m) => `${m.role === 'user' ? 'Student' : 'College'}: ${m.content}`);
  return `This WhatsApp chat so far (continue it; don't greet again):\n${lines.join('\n')}`;
}

/** The agent events this bridge reads (the socket sends others too). */
interface AgentEvent {
  type?: string;
  ping_event?: { event_id?: number };
  agent_response_event?: { agent_response?: string };
}

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

export interface AskAgentArgs {
  apiKey: string;
  agentId: string;
  text: string;
  history: ChatMessage[];
  fetchImpl?: typeof fetch;
  openSocket?: (url: string) => WebSocketLike;
  timeoutMs?: number;
  greetingWaitMs?: number;
}

/**
 * One text exchange with the agent: open a conversation, let the agent's
 * opening greeting pass, hand it the chat so far, send the new message and
 * return its answer. Resolves null when the agent doesn't answer in time.
 */
export async function askAgent(args: AskAgentArgs): Promise<string | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${API_BASE}/conversation/get-signed-url?agent_id=${encodeURIComponent(args.agentId)}`,
    { headers: { 'xi-api-key': args.apiKey } },
  );
  if (!res.ok) throw new Error(`signed URL request answered ${res.status}`);
  const { signed_url: url } = (await res.json()) as { signed_url?: string };
  if (!url) throw new Error('no signed URL');

  const openSocket = args.openSocket ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
  const ws = openSocket(url);
  const note = historyNote(args.history);

  return new Promise<string | null>((resolve, reject) => {
    let asked = false;
    let done = false;
    const finish = (answer: string | null, err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      clearTimeout(greetingTimer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve(answer);
    };
    const ask = () => {
      if (asked || done) return;
      asked = true;
      if (note) ws.send(JSON.stringify({ type: 'contextual_update', text: note }));
      ws.send(JSON.stringify({ type: 'user_message', text: args.text }));
    };
    const timeout = setTimeout(() => finish(null), args.timeoutMs ?? ANSWER_TIMEOUT_MS);
    let greetingTimer: ReturnType<typeof setTimeout> | undefined;

    ws.onopen = () => ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' }));
    ws.onmessage = (ev) => {
      let msg: AgentEvent;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id }));
      } else if (msg.type === 'conversation_initiation_metadata') {
        // The agent opens with its greeting; if it doesn't, ask anyway.
        greetingTimer = setTimeout(ask, args.greetingWaitMs ?? GREETING_WAIT_MS);
      } else if (msg.type === 'agent_response') {
        const text = String(msg.agent_response_event?.agent_response ?? '').trim();
        if (!asked) ask(); // that was the greeting
        else if (text) finish(text);
      }
    };
    ws.onerror = () => finish(null, new Error('agent connection failed'));
    ws.onclose = () => finish(null);
  });
}

interface DispatchArgs {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
  /** The customer's message, as text (a typed message or a button tap). */
  text: string;
  /** Meta's id of that message. */
  inboundMessageId: string;
}

export interface DispatchDeps {
  ask?: (args: AskAgentArgs) => Promise<string | null>;
  send?: (args: {
    accountId: string;
    userId: string;
    conversationId: string;
    contactId: string;
    text: string;
    aiGenerated: boolean;
  }) => Promise<unknown>;
}

/**
 * Called by the webhook for each customer message. Returns true when the
 * account is bridged (so the portal's own AI auto-reply stays out of it),
 * whether or not an answer could be sent.
 */
export async function dispatchToElevenLabsAgent(
  args: DispatchArgs,
  deps: DispatchDeps = {},
): Promise<boolean> {
  const agentId = bridgeAgentForAccount(args.accountId);
  if (!agentId) return false;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.warn('[elevenlabs bridge] ELEVENLABS_API_KEY is not set; not answering');
    return true;
  }
  if (!args.text.trim()) return true;

  try {
    const { data: conv } = await args.db
      .from('conversations')
      .select('ai_autoreply_disabled')
      .eq('id', args.conversationId)
      .maybeSingle();
    // The bot was switched off for this chat.
    if (conv?.ai_autoreply_disabled) return true;

    const context = await buildConversationContext(args.db, args.conversationId, HISTORY_LIMIT);
    // The new message is already saved; it's sent on its own, not as history.
    const last = context[context.length - 1];
    const history =
      last && last.role === 'user' && last.content === args.text.trim() ? context.slice(0, -1) : context;

    const ask = deps.ask ?? askAgent;
    const answer = await ask({ apiKey, agentId, text: args.text.trim(), history });
    if (!answer) {
      console.warn(`[elevenlabs bridge] no answer from ${agentId} for conversation ${args.conversationId}`);
      return true;
    }

    // The student wrote again while the agent was thinking: that newer
    // message gets its own answer, which covers this one too.
    if (await hasNewerInbound(args.db, args.conversationId, args.inboundMessageId)) return true;

    const send = deps.send ?? (await import('@/lib/flows/meta-send')).engineSendText;
    await send({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: answer,
      aiGenerated: true,
    });
  } catch (err) {
    console.error('[elevenlabs bridge] failed:', err instanceof Error ? err.message : err);
  }
  return true;
}

async function hasNewerInbound(db: SupabaseClient, conversationId: string, inboundMessageId: string) {
  const { data, error } = await db
    .from('messages')
    .select('message_id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return false;
  return data[0].message_id !== inboundMessageId;
}
