import { describe, expect, it } from 'vitest';

import { approvedHeaderMedia, headerMediaProblem, isMetaSampleMediaUrl } from './template-media-source';

const SAMPLE =
  'https://scontent.whatsapp.net/v/t61.29466-34/690877799_n.png?ccb=1-7&oh=abc&oe=6B0AA231&_nc_cat=1';

describe('isMetaSampleMediaUrl', () => {
  it('accepts https links on Meta media hosts only', () => {
    expect(isMetaSampleMediaUrl(SAMPLE)).toBe(true);
    expect(isMetaSampleMediaUrl('https://scontent-sin6-1.xx.fbcdn.net/v/x.jpg')).toBe(true);
    expect(isMetaSampleMediaUrl('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1')).toBe(true);
    expect(isMetaSampleMediaUrl('http://scontent.whatsapp.net/x.png')).toBe(false);
    expect(isMetaSampleMediaUrl('https://whatsapp.net.evil.com/x.png')).toBe(false);
    expect(isMetaSampleMediaUrl('4::aW1hZ2UvcG5n:ARb')).toBe(false); // a resumable-upload handle
    expect(isMetaSampleMediaUrl(null)).toBe(false);
  });
});

describe('approvedHeaderMedia', () => {
  it('prefers the stored link, then the approved sample', () => {
    expect(approvedHeaderMedia({ header_media_url: 'https://cdn.example/a.png', header_handle: SAMPLE })).toBe(
      'https://cdn.example/a.png',
    );
    expect(approvedHeaderMedia({ header_handle: SAMPLE })).toBe(SAMPLE);
    expect(approvedHeaderMedia({ header_handle: '4::aW1hZ2U:ARb' })).toBeNull();
  });
});

describe('headerMediaProblem', () => {
  it('lets an image template with a stored link send without input', () => {
    expect(headerMediaProblem('', { header_type: 'image', header_media_url: 'https://cdn.example/a.png' })).toBeNull();
  });

  it('lets a synced template use its approved sample', () => {
    expect(headerMediaProblem('', { header_type: 'image', header_handle: SAMPLE })).toBeNull();
  });

  it('requires media when the template has none', () => {
    expect(headerMediaProblem('', { header_type: 'image', header_handle: '4::aW1hZ2U:ARb' })).toBe('missing');
    expect(headerMediaProblem('  ', { header_type: 'video' })).toBe('missing');
  });

  it('rejects something that is not a link, accepts an uploaded or pasted one', () => {
    expect(headerMediaProblem('photo.jpg', { header_type: 'image' })).toBe('invalid');
    expect(headerMediaProblem('https://x.supabase.co/storage/v1/object/public/chat-media/a.png', { header_type: 'image' })).toBeNull();
  });

  it('never blocks text-only or text-header templates', () => {
    expect(headerMediaProblem('', { header_type: 'text' })).toBeNull();
    expect(headerMediaProblem('', {})).toBeNull();
  });
});
