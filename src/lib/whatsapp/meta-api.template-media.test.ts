import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendTemplateMessage } from './meta-api';
import type { MessageTemplate } from '@/types';

const IMAGE = 'https://store.example/chat-media/acc/template-headers/mbbs.png';

function template(over: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 't1', user_id: 'u1', name: 'mbbs_admissions', language: 'en', category: 'Utility', status: 'APPROVED',
    body_text: 'Dear {{1}}, admissions are open.',
    header_type: 'image', header_media_url: IMAGE,
    buttons: [
      { type: 'URL', text: 'Apply', url: 'https://watim.edu.pk/apply/{{1}}' },
      { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+92511234567' },
    ],
    ...over,
  } as MessageTemplate;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
}

afterEach(() => vi.unstubAllGlobals());

describe('sendTemplateMessage — media header', () => {
  const base = { phoneNumberId: 'pn', accessToken: 't', to: '923001110001', templateName: 'mbbs_admissions', language: 'en' };

  it('sends the image link, body values and the URL button suffix', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] })));
    vi.stubGlobal('fetch', fetchMock);
    await sendTemplateMessage({ ...base, template: template(), messageParams: { body: ['Ali'], buttonParams: { 0: 'ref42' } } });
    expect(sentBody(fetchMock).template.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: IMAGE } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Ali' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'ref42' }] },
    ]);
  });

  it('sends a WhatsApp media id instead of a link when given one', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] })));
    vi.stubGlobal('fetch', fetchMock);
    await sendTemplateMessage({
      ...base,
      template: template({ buttons: undefined, body_text: 'Hello' }),
      messageParams: { headerMediaId: '1234567890' },
    });
    expect(sentBody(fetchMock).template.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: '1234567890' } }] },
    ]);
  });

  it('never sends the approved-sample handle, and refuses before calling Meta when no media exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      sendTemplateMessage({
        ...base,
        template: template({ header_media_url: undefined, header_handle: 'https://scontent.whatsapp.net/v/x.png' }),
        messageParams: { body: ['Ali'], buttonParams: { 0: 'x' } },
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a text-only template unchanged', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] })));
    vi.stubGlobal('fetch', fetchMock);
    await sendTemplateMessage({
      ...base,
      template: template({ header_type: undefined, header_media_url: undefined, buttons: undefined, body_text: 'Hello' }),
    });
    expect(sentBody(fetchMock).template.components).toBeUndefined();
  });
});
