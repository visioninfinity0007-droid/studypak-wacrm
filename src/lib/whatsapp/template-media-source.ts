// Where a media-header template's send-time image comes from.
//
// A template created in the portal stores `header_media_url` (our own
// public copy). A template synced from Meta only has
// `example.header_handle`: for a synced template that's a signed link to
// the approved sample on Meta's CDN (scontent.whatsapp.net), which
// expires after about a month. It's the image the template was approved
// with, so the server copies it into our storage the first time it's
// needed (template-header-media.ts) and sends that copy. The link itself
// is never sent as a media id, and never sent as a link either, because
// it stops working.
//
// Client-safe: no I/O.

import type { MessageTemplate } from '@/types';

const META_MEDIA_HOSTS = [/\.whatsapp\.net$/i, /\.fbcdn\.net$/i, /^lookaside\.fbsbx\.com$/i];

/** True for an https link to Meta's media CDN (a synced template's sample). */
export function isMetaSampleMediaUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && META_MEDIA_HOSTS.some((re) => re.test(url.hostname));
}

/**
 * The image the template will be sent with when the sender doesn't attach
 * one: our stored copy, else Meta's approved sample (copied on first send).
 * Null when the sender has to supply media.
 */
export function approvedHeaderMedia(
  template: Pick<MessageTemplate, 'header_media_url' | 'header_handle'>,
): string | null {
  if (template.header_media_url) return template.header_media_url;
  if (isMetaSampleMediaUrl(template.header_handle)) return template.header_handle ?? null;
  return null;
}

/**
 * Can a media-header template be sent with what the sender entered?
 * Empty is fine when the template has an approved image of its own;
 * anything typed must be an http(s) link.
 */
export function headerMediaProblem(
  value: string,
  template: Pick<MessageTemplate, 'header_type' | 'header_media_url' | 'header_handle'>,
): 'missing' | 'invalid' | null {
  const kind = template.header_type;
  if (kind !== 'image' && kind !== 'video' && kind !== 'document') return null;
  const v = value.trim();
  if (!v) return approvedHeaderMedia(template) ? null : 'missing';
  return /^https?:\/\/\S+$/i.test(v) ? null : 'invalid';
}
