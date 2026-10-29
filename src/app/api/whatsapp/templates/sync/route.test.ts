import { beforeEach, describe, expect, it, vi } from 'vitest';

// Syncing from Meta must not drop a template's stored send-time media
// link, and must copy the approved sample for a media template that has
// none (template-header-media.ts).

const IMAGE = 'https://store.example/chat-media/acct-1/template-headers/mbbs.png';
const SAMPLE = 'https://scontent.whatsapp.net/v/t61/mbbs.png?oe=6B0AA231';

const updates: Record<string, unknown>[] = [];
let localRows: Record<string, unknown>[] = [];

function makeSupabase() {
  return {
    from: vi.fn((table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['select', 'eq', 'in']) b[m] = vi.fn(chain);
      b.single = vi.fn(async () =>
        table === 'whatsapp_config'
          ? { data: { waba_id: 'WABA-1', access_token: 'enc' }, error: null }
          : { data: null, error: null },
      );
      b.maybeSingle = vi.fn(async () => ({ data: table === 'message_templates' ? { id: 'local-1' } : null, error: null }));
      b.update = vi.fn((patch: Record<string, unknown>) => {
        updates.push(patch);
        return { eq: async () => ({ error: null }) };
      });
      b.insert = vi.fn(async () => ({ error: null }));
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: localRows, error: null }));
      return b;
    }),
  };
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: makeSupabase(), accountId: 'acct-1', userId: 'user-1' })),
  UnauthorizedError: class extends Error {},
  ForbiddenError: class extends Error {},
  toErrorResponse: vi.fn(),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }));

const media = vi.hoisted(() => ({
  ensureTemplateHeaderMedia: vi.fn(async (row: unknown) => row),
  needsHeaderMediaCopy: vi.fn((row: { header_media_url?: string }) => !row.header_media_url),
}));
vi.mock('@/lib/whatsapp/template-header-media', () => media);

import { POST } from './route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

beforeEach(() => {
  __resetRateLimitForTests();
  updates.length = 0;
  media.ensureTemplateHeaderMedia.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'meta-1',
              name: 'mbbs_admissions',
              language: 'en',
              status: 'APPROVED',
              category: 'UTILITY',
              components: [
                { type: 'HEADER', format: 'IMAGE', example: { header_handle: [SAMPLE] } },
                { type: 'BODY', text: 'Admissions are open.' },
              ],
            },
          ],
        }),
      ),
    ),
  );
});

describe('POST /api/whatsapp/templates/sync — media headers', () => {
  it('updates the template without touching its stored media link', async () => {
    localRows = [{ id: 'local-1', name: 'mbbs_admissions', header_type: 'image', header_media_url: IMAGE, header_handle: SAMPLE }];
    const res = await POST();
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ header_type: 'image', header_handle: SAMPLE });
    expect(updates[0]).not.toHaveProperty('header_media_url');
    expect(media.ensureTemplateHeaderMedia).not.toHaveBeenCalled();
  });

  it('copies the approved sample for a media template with no stored link', async () => {
    localRows = [{ id: 'local-1', name: 'mbbs_admissions', header_type: 'image', header_handle: SAMPLE }];
    await POST();
    expect(media.ensureTemplateHeaderMedia).toHaveBeenCalledWith(expect.objectContaining({ id: 'local-1' }));
  });
});
