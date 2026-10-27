// ElevenLabs bot replies → portal inbox.
//
// A college's number can also be answered by an ElevenLabs agent (Watim's
// "Hashim"). Meta delivers the students' messages to every app subscribed
// to the WABA, so those already reach the portal through the webhook —
// but the agent's replies are sent by ElevenLabs' app, and Meta doesn't
// echo another app's sends. So the inbox showed one side of the chat.
//
// This pulls recent ElevenLabs conversations and copies the agent's turns
// into the matching portal chat as `sender_type = 'bot'`. Each turn's id
// becomes the message_id, and (conversation_id, message_id) is unique
// (migration 037), so re-importing a turn is a no-op.
//
// Routing is by the conversation's WhatsApp phone_number_id, the same
// lookup the webhook uses, so a reply only lands in the college that owns
// that number. A student with no portal chat yet is skipped (the webhook
// creates the chat on their first message) and retried next tick.

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact } from '@/lib/contacts/dedupe';
import { resolveConfigForPhoneNumber } from '@/lib/whatsapp/number-routing';

const API_BASE = 'https://api.elevenlabs.io/v1/convai';
/** WhatsApp chats stay open for a day or more; look back two days. */
const LOOKBACK_SECS = 2 * 24 * 60 * 60;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export interface ElevenLabsTurn {
  id?: string | null;
  role: string;
  message?: string | null;
  time_in_call_secs?: number | null;
}

export interface ElevenLabsConversation {
  conversation_id: string;
  metadata: {
    start_time_unix_secs: number;
    whatsapp?: {
      whatsapp_phone_number_id?: string | null;
      whatsapp_user_id?: string | null;
    } | null;
  };
  transcript: ElevenLabsTurn[];
}

interface ConversationSummary {
  conversation_id: string;
  message_count?: number | null;
}

export interface BotReply {
  messageId: string;
  text: string;
  createdAt: string;
}

/** The agent's turns as portal messages, oldest first. */
export function botRepliesFromConversation(conv: ElevenLabsConversation): BotReply[] {
  const start = conv.metadata.start_time_unix_secs;
  return conv.transcript.flatMap((turn, index) => {
    const text = turn.message?.trim();
    if (turn.role !== 'agent' || !text) return [];
    const at = (start + (turn.time_in_call_secs ?? 0)) * 1000;
    return [
      {
        messageId: `elevenlabs:${turn.id ?? `${conv.conversation_id}:${index}`}`,
        text,
        createdAt: new Date(at).toISOString(),
      },
    ];
  });
}

/**
 * Message counts already imported, per ElevenLabs conversation. Lives as
 * long as the server process; after a restart every recent conversation is
 * re-read once, which the unique index makes harmless.
 */
const importedCounts = new Map<string, number>();

export function __resetBotReplySyncForTests() {
  importedCounts.clear();
}

export interface SyncResult {
  conversations: number;
  fetched: number;
  inserted: number;
  skipped: number;
}

type Fetch = typeof fetch;

async function getJson<T>(fetchImpl: Fetch, apiKey: string, url: string): Promise<T> {
  const res = await fetchImpl(url, { headers: { 'xi-api-key': apiKey } });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status} for ${url.replace(API_BASE, '')}`);
  return (await res.json()) as T;
}

export async function syncElevenLabsBotReplies(
  db: SupabaseClient,
  opts: { apiKey: string; nowMs?: number; fetchImpl?: Fetch },
): Promise<SyncResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const since = Math.floor((opts.nowMs ?? Date.now()) / 1000) - LOOKBACK_SECS;
  const result: SyncResult = { conversations: 0, fetched: 0, inserted: 0, skipped: 0 };

  const summaries: ConversationSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      page_size: String(PAGE_SIZE),
      call_start_after_unix: String(since),
    });
    if (cursor) params.set('cursor', cursor);
    const body = await getJson<{
      conversations?: ConversationSummary[];
      has_more?: boolean;
      next_cursor?: string | null;
    }>(fetchImpl, opts.apiKey, `${API_BASE}/conversations?${params}`);
    summaries.push(...(body.conversations ?? []));
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  result.conversations = summaries.length;

  for (const summary of summaries) {
    const count = summary.message_count ?? 0;
    if (count === 0 || importedCounts.get(summary.conversation_id) === count) continue;

    result.fetched++;
    const conv = await getJson<ElevenLabsConversation>(
      fetchImpl,
      opts.apiKey,
      `${API_BASE}/conversations/${encodeURIComponent(summary.conversation_id)}`,
    );
    const imported = await importConversation(db, conv);
    if (imported === null) {
      result.skipped++;
      continue;
    }
    result.inserted += imported;
    importedCounts.set(summary.conversation_id, count);
  }
  return result;
}

/** Rows inserted, or null when the chat can't be placed yet (retry later). */
async function importConversation(
  db: SupabaseClient,
  conv: ElevenLabsConversation,
): Promise<number | null> {
  const wa = conv.metadata.whatsapp;
  if (!wa?.whatsapp_phone_number_id || !wa.whatsapp_user_id) return 0; // not a WhatsApp chat

  const replies = botRepliesFromConversation(conv);
  if (replies.length === 0) return 0;

  const resolved = await resolveConfigForPhoneNumber<{ account_id: string }>(
    db,
    wa.whatsapp_phone_number_id,
  );
  if (!resolved) return 0; // number belongs to no college

  const accountId = resolved.config.account_id;
  const contact = await findExistingContact(db, accountId, `+${wa.whatsapp_user_id}`);
  if (!contact) return null;

  const { data: chats, error: chatErr } = await db
    .from('conversations')
    .select('id, last_message_at')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: true })
    .limit(1);
  if (chatErr) throw new Error(`conversation lookup failed: ${chatErr.message}`);
  const chat = chats?.[0] as { id: string; last_message_at: string | null } | undefined;
  if (!chat) return null;

  const { data: inserted, error: insErr } = await db
    .from('messages')
    .upsert(
      replies.map((r) => ({
        conversation_id: chat.id,
        sender_type: 'bot',
        content_type: 'text',
        content_text: r.text,
        message_id: r.messageId,
        status: 'sent',
        created_at: r.createdAt,
      })),
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id');
  if (insErr) throw new Error(`bot reply insert failed: ${insErr.message}`);

  // Keep the chat list preview current when the bot spoke last.
  const latest = replies[replies.length - 1];
  if (!chat.last_message_at || Date.parse(latest.createdAt) > Date.parse(chat.last_message_at)) {
    await db
      .from('conversations')
      .update({ last_message_text: latest.text, last_message_at: latest.createdAt })
      .eq('id', chat.id);
  }
  return inserted?.length ?? 0;
}
