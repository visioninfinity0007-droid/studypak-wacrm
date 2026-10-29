import { describe, expect, it, vi } from 'vitest';

import { ensureTemplateHeaderMedia, needsHeaderMediaCopy } from './template-header-media';
import type { MessageTemplate } from '@/types';

const SAMPLE = 'https://scontent.whatsapp.net/v/t61.29466-34/690877799_n.png?oe=6B0AA231';

function template(over: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 'tpl-1',
    user_id: 'u1',
    account_id: 'acc-1',
    name: '3rd_watim_message_with_image',
    language: 'en',
    category: 'Utility',
    status: 'APPROVED',
    body_text: 'Admissions open',
    header_type: 'image',
    header_handle: SAMPLE,
    meta_template_id: '123',
    ...over,
  } as MessageTemplate;
}

function fakeDb() {
  const uploads: { path: string; type: string; size: number }[] = [];
  const updates: { patch: Record<string, unknown>; id: unknown; or: string }[] = [];
  const db = {
    storage: {
      from: () => ({
        upload: vi.fn(async (path: string, body: Uint8Array, opts: { contentType: string }) => {
          uploads.push({ path, type: opts.contentType, size: body.byteLength });
          return { error: null };
        }),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://store.example/chat-media/${path}` } }),
      }),
    },
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_c: string, id: unknown) => ({
          or: async (expr: string) => {
            updates.push({ patch, id, or: expr });
            return { error: null };
          },
        }),
      }),
    }),
  };
  return { db, uploads, updates };
}

const png = (bytes = 10) =>
  vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' } }));

describe('needsHeaderMediaCopy', () => {
  it('only for media templates with a Meta sample and no stored link', () => {
    expect(needsHeaderMediaCopy(template())).toBe(true);
    expect(needsHeaderMediaCopy(template({ header_media_url: 'https://cdn.example/a.png' }))).toBe(false);
    expect(needsHeaderMediaCopy(template({ header_handle: '4::aW1hZ2U:ARb' }))).toBe(false);
    expect(needsHeaderMediaCopy(template({ header_type: 'text' }))).toBe(false);
    expect(needsHeaderMediaCopy(template({ header_type: undefined }))).toBe(false);
  });
});

describe('ensureTemplateHeaderMedia', () => {
  it('copies the approved sample into storage and saves the link on the template', async () => {
    const { db, uploads, updates } = fakeDb();
    const fetchImpl = png(2048);
    const row = await ensureTemplateHeaderMedia(template(), { db: db as never, fetchImpl: fetchImpl as never });

    expect(fetchImpl).toHaveBeenCalledWith(SAMPLE, expect.objectContaining({ redirect: 'error' }));
    expect(uploads).toEqual([
      { path: expect.stringMatching(/^account-acc-1\/template-headers\/.*\.png$/), type: 'image/png', size: 2048 },
    ]);
    expect(row.header_media_url).toBe(`https://store.example/chat-media/${uploads[0].path}`);
    expect(updates).toEqual([
      { patch: { header_media_url: row.header_media_url }, id: 'tpl-1', or: 'header_media_url.is.null,header_media_url.eq.' },
    ]);
    // The approved sample handle is left as it was.
    expect(row.header_handle).toBe(SAMPLE);
  });

  it('uses the same object for the same template (no duplicates)', async () => {
    const { db, uploads } = fakeDb();
    await ensureTemplateHeaderMedia(template(), { db: db as never, fetchImpl: png() as never });
    await ensureTemplateHeaderMedia(template(), { db: db as never, fetchImpl: png() as never });
    expect(uploads[0].path).toBe(uploads[1].path);
  });

  it('keeps a stored link and touches nothing', async () => {
    const { db, uploads } = fakeDb();
    const fetchImpl = png();
    const stored = template({ header_media_url: 'https://cdn.example/a.png' });
    expect(await ensureTemplateHeaderMedia(stored, { db: db as never, fetchImpl: fetchImpl as never })).toBe(stored);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it('never fetches a non-Meta link', async () => {
    const fetchImpl = png();
    const row = template({ header_handle: 'https://169.254.169.254/latest/meta-data' });
    expect(await ensureTemplateHeaderMedia(row, { db: fakeDb().db as never, fetchImpl: fetchImpl as never })).toBe(row);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['an expired sample', new Response('gone', { status: 403 })],
    ['a type Meta would refuse', new Response(new Uint8Array(5), { headers: { 'content-type': 'image/gif' } })],
    ['an image over 5 MB', new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/jpeg' } })],
  ])('returns the row unchanged on %s', async (_label, response) => {
    const { db, uploads } = fakeDb();
    const row = template();
    const out = await ensureTemplateHeaderMedia(row, { db: db as never, fetchImpl: vi.fn(async () => response) as never });
    expect(out).toBe(row);
    expect(out.header_media_url).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });
});
