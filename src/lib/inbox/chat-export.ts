// Chat export and delete for the inbox: download chats as a CSV the
// college can open in Excel and share with its team, and delete chats
// (one or many) to keep the inbox clean. Deleting a chat removes its
// messages; the contact stays in Contacts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { format } from 'date-fns';

import { fetchAllInChunks } from '@/lib/supabase/paged-query';
import { csvCell } from '@/lib/contacts/contact-lists';

export interface ExportChat {
  id: string;
  status: string;
  contactName: string | null;
  contactPhone: string | null;
}

export interface ExportMessage {
  conversation_id: string;
  sender_type: string;
  sender_id: string | null;
  ai_generated: boolean | null;
  message_id: string | null;
  content_type: string;
  content_text: string | null;
  template_name: string | null;
  media_url: string | null;
  status: string;
  created_at: string;
}

export interface ChatCsvLabels {
  header: [string, string, string, string, string, string, string];
  contact: string;
  team: string;
  bot: string;
  elevenLabsBot: string;
  ai: string;
}

/** Who sent a message, as the college reads it. */
export function senderLabel(
  m: Pick<ExportMessage, 'sender_type' | 'sender_id' | 'ai_generated' | 'message_id'>,
  labels: ChatCsvLabels,
  teamNames: ReadonlyMap<string, string>,
): string {
  if (m.sender_type === 'customer') return labels.contact;
  if (m.message_id?.startsWith('elevenlabs:')) return labels.elevenLabsBot;
  if (m.ai_generated) return labels.ai;
  if (m.sender_type === 'bot') return labels.bot;
  return (m.sender_id && teamNames.get(m.sender_id)) || labels.team;
}

function messageText(m: ExportMessage): string {
  const text = m.content_text?.trim();
  if (text) return text;
  if (m.content_type === 'template' && m.template_name) return `[template: ${m.template_name}]`;
  return m.media_url ? `[${m.content_type}] ${m.media_url}` : `[${m.content_type}]`;
}

/**
 * One row per message, chats in the order given and each chat's messages
 * oldest first. Times are in the browser's time zone.
 */
export function chatsCsv(
  chats: readonly ExportChat[],
  messages: readonly ExportMessage[],
  labels: ChatCsvLabels,
  teamNames: ReadonlyMap<string, string> = new Map(),
): string {
  const byChat = new Map<string, ExportMessage[]>();
  for (const m of messages) {
    const list = byChat.get(m.conversation_id) ?? [];
    list.push(m);
    byChat.set(m.conversation_id, list);
  }
  const lines = [labels.header.map(csvCell).join(',')];
  for (const chat of chats) {
    const list = (byChat.get(chat.id) ?? []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const m of list) {
      lines.push(
        [
          chat.contactName ?? '',
          chat.contactPhone ?? '',
          format(new Date(m.created_at), 'yyyy-MM-dd HH:mm'),
          senderLabel(m, labels, teamNames),
          messageText(m),
          m.status,
          chat.status,
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  // The BOM makes Excel read the file as UTF-8 (Urdu, emoji).
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Every message of the given chats, paged past PostgREST's 1,000-row cap. */
export async function loadChatMessages(
  db: SupabaseClient,
  conversationIds: readonly string[],
): Promise<ExportMessage[]> {
  return fetchAllInChunks<ExportMessage, string>(conversationIds, (slice, from, to) =>
    db
      .from('messages')
      .select(
        'conversation_id, sender_type, sender_id, ai_generated, message_id, content_type, content_text, template_name, media_url, status, created_at',
      )
      .in('conversation_id', slice)
      .order('created_at')
      .order('id')
      .range(from, to),
  );
}

/** user_id → full name, for the "From" column of a person's replies. */
export async function loadTeamNames(db: SupabaseClient): Promise<Map<string, string>> {
  const { data } = await db.from('profiles').select('user_id, full_name');
  const names = new Map<string, string>();
  for (const p of (data ?? []) as { user_id: string; full_name: string | null }[]) {
    if (p.full_name) names.set(p.user_id, p.full_name);
  }
  return names;
}

export function downloadCsv(fileName: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

const DELETE_CHUNK = 100;

/**
 * Delete chats and their messages. A deal linked to a chat would block
 * the delete (deals.conversation_id has no ON DELETE), so the link is
 * cleared first; the deal itself stays.
 */
export async function deleteChats(db: SupabaseClient, conversationIds: readonly string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < conversationIds.length; i += DELETE_CHUNK) {
    const slice = conversationIds.slice(i, i + DELETE_CHUNK);
    const { error: dealErr } = await db.from('deals').update({ conversation_id: null }).in('conversation_id', slice);
    if (dealErr) throw new Error(dealErr.message);
    const { data, error } = await db.from('conversations').delete().in('id', slice).select('id');
    if (error) throw new Error(error.message);
    deleted += data?.length ?? 0;
  }
  return deleted;
}
