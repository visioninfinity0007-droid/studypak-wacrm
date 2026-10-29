import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Every send path (inbox, API, broadcasts and their queue, automations)
// loads the template through resolveTemplateRow, so this is where a
// synced media-header template gets its approved image copied.
const media = vi.hoisted(() => ({
  ensureTemplateHeaderMedia: vi.fn(async (row: Record<string, unknown>) => ({
    ...row,
    header_media_url: 'https://store.example/chat-media/acct-1/template-headers/x.png',
  })),
}));
vi.mock('@/lib/whatsapp/template-header-media', () => media);

import { resolveTemplateRow } from './template-body';

function db(rows: Record<string, unknown>[]): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: rows, error: null })),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe('resolveTemplateRow — media headers', () => {
  it('returns the row with a sendable header link', async () => {
    const synced = {
      id: 't1', user_id: 'u1', account_id: 'acct-1', name: 'promo', language: 'en', body_text: 'Hi',
      header_type: 'image', header_handle: 'https://scontent.whatsapp.net/v/x.png?oe=1',
    };
    const resolved = await resolveTemplateRow(db([synced]), 'acct-1', 'promo', 'en');
    expect(media.ensureTemplateHeaderMedia).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    expect(resolved.row?.header_media_url).toBe('https://store.example/chat-media/acct-1/template-headers/x.png');
  });
});
