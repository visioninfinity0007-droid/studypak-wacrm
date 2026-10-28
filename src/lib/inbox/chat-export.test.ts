import { describe, expect, it, vi } from 'vitest';

import { chatsCsv, deleteChats, senderLabel, type ChatCsvLabels, type ExportMessage } from './chat-export';

const labels: ChatCsvLabels = {
  header: ['Contact', 'Phone', 'Date & time', 'From', 'Message', 'Delivery', 'Chat status'],
  contact: 'Contact',
  team: 'Team',
  bot: 'Bot',
  elevenLabsBot: 'ElevenLabs bot',
  ai: 'AI assistant',
};

function msg(over: Partial<ExportMessage>): ExportMessage {
  return {
    conversation_id: 'c1',
    sender_type: 'customer',
    sender_id: null,
    ai_generated: false,
    message_id: null,
    content_type: 'text',
    content_text: 'hi',
    template_name: null,
    media_url: null,
    status: 'read',
    created_at: '2026-10-27T12:00:00.000Z',
    ...over,
  };
}

describe('senderLabel', () => {
  const team = new Map([['u1', 'Ayesha']]);
  it('names who sent each message', () => {
    expect(senderLabel(msg({}), labels, team)).toBe('Contact');
    expect(senderLabel(msg({ sender_type: 'agent', sender_id: 'u1' }), labels, team)).toBe('Ayesha');
    expect(senderLabel(msg({ sender_type: 'agent', sender_id: 'u9' }), labels, team)).toBe('Team');
    expect(senderLabel(msg({ sender_type: 'bot', ai_generated: true, message_id: 'elevenlabs:x' }), labels, team)).toBe(
      'ElevenLabs bot',
    );
    expect(senderLabel(msg({ sender_type: 'agent', ai_generated: true }), labels, team)).toBe('AI assistant');
    expect(senderLabel(msg({ sender_type: 'bot' }), labels, team)).toBe('Bot');
  });
});

describe('chatsCsv', () => {
  it('writes one row per message, chats in order and messages oldest first', () => {
    const csv = chatsCsv(
      [
        { id: 'c2', status: 'open', contactName: 'Sara', contactPhone: '+923001110002' },
        { id: 'c1', status: 'closed', contactName: 'Khan, Ali', contactPhone: '+923001110001' },
      ],
      [
        msg({ content_text: 'second', created_at: '2026-10-27T12:05:00.000Z' }),
        msg({ content_text: 'first' }),
        msg({ conversation_id: 'c2', content_type: 'template', content_text: null, template_name: 'promo' }),
        msg({ conversation_id: 'c2', content_type: 'image', content_text: null, media_url: 'https://x/y.jpg' }),
      ],
      labels,
    );
    expect(csv.startsWith('﻿Contact,Phone,Date & time,From,Message,Delivery,Chat status\r\n')).toBe(true);
    const rows = csv.trim().split('\r\n').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('Sara,+923001110002,');
    expect(rows[0]).toContain('[template: promo]');
    expect(rows[1]).toContain('[image] https://x/y.jpg');
    expect(rows[2]).toMatch(/^"Khan, Ali",\+923001110001,.*,first,read,closed$/);
    expect(rows[3]).toContain(',second,');
  });

  it('keeps a formula out of Excel', () => {
    const csv = chatsCsv([{ id: 'c1', status: 'open', contactName: null, contactPhone: null }], [msg({ content_text: '=1+1' })], labels);
    expect(csv).toContain("'=1+1");
  });
});

describe('deleteChats', () => {
  it('unlinks deals, then deletes chats in chunks and counts them', async () => {
    const calls: string[] = [];
    const db = {
      from: vi.fn((table: string) => ({
        update: () => ({
          in: async (_c: string, ids: string[]) => {
            calls.push(`${table}.unlink:${ids.length}`);
            return { error: null };
          },
        }),
        delete: () => ({
          in: (_c: string, ids: string[]) => ({
            select: async () => {
              calls.push(`${table}.delete:${ids.length}`);
              return { data: ids.map((id) => ({ id })), error: null };
            },
          }),
        }),
      })),
    };
    const ids = Array.from({ length: 150 }, (_, i) => `c${i}`);
    expect(await deleteChats(db as never, ids)).toBe(150);
    expect(calls).toEqual([
      'deals.unlink:100',
      'conversations.delete:100',
      'deals.unlink:50',
      'conversations.delete:50',
    ]);
  });
});
