// Give a synced media-header template a send-time image of its own.
//
// Meta requires the header media on every template send, as a public
// link or an uploaded media id. A template synced from Meta has neither;
// it has only the approved sample's signed CDN link (`header_handle`),
// which expires after about a month (see template-media-source.ts). So
// the first time such a template is synced or sent, the approved sample
// is copied into the `chat-media` bucket and its permanent public URL is
// saved as `header_media_url`. Every send path then uses that copy:
// inbox, broadcasts and their queue, automations and the public API,
// because they all load the template through resolveTemplateRow.
//
// Never overwrites a stored `header_media_url`. Failing to copy is not
// fatal: the row comes back unchanged and the send reports the missing
// media as before.

import type { SupabaseClient } from '@supabase/supabase-js';

import { buildMediaPath } from '@/lib/storage/upload-media';
import { MEDIA_HEADER_SPECS, isMediaHeaderKind } from '@/lib/whatsapp/media-header-types';
import { isMetaSampleMediaUrl } from '@/lib/whatsapp/template-media-source';
import type { MessageTemplate } from '@/types';

const BUCKET = 'chat-media';
const FOLDER = 'template-headers';
const DOWNLOAD_TIMEOUT_MS = 20_000;

export interface TemplateHeaderMediaDeps {
  /** Service-role client: storage upload + the template row update. */
  db: SupabaseClient;
  fetchImpl?: typeof fetch;
}

async function defaultDeps(): Promise<TemplateHeaderMediaDeps> {
  const { supabaseServiceRole } = await import('@/lib/supabase/admin');
  return { db: supabaseServiceRole() };
}

/** Does this row need its approved sample copied before it can be sent? */
export function needsHeaderMediaCopy(row: MessageTemplate): boolean {
  return (
    isMediaHeaderKind(row.header_type) &&
    !row.header_media_url &&
    isMetaSampleMediaUrl(row.header_handle)
  );
}

export async function ensureTemplateHeaderMedia(
  row: MessageTemplate,
  deps?: TemplateHeaderMediaDeps,
): Promise<MessageTemplate> {
  if (!needsHeaderMediaCopy(row) || !isMediaHeaderKind(row.header_type)) return row;
  const kind = row.header_type;
  const spec = MEDIA_HEADER_SPECS[kind];
  const accountId = (row as { account_id?: string }).account_id;
  if (!accountId) return row;

  try {
    const { db, fetchImpl = fetch } = deps ?? (await defaultDeps());

    // Only Meta's CDN reaches this point (isMetaSampleMediaUrl), and
    // redirects are refused so it can't bounce somewhere else.
    const res = await fetchImpl(row.header_handle!, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`sample download answered ${res.status}`);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!spec.mimeTypes.includes(contentType)) throw new Error(`unsupported sample type ${contentType || 'unknown'}`);
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.byteLength > spec.maxBytes) throw new Error(`sample is ${buffer.byteLength} bytes, over ${spec.maxBytes}`);

    const ext = spec.extensions[contentType as keyof typeof spec.extensions] ?? 'bin';
    // Stable name (no timestamp): a second copy of the same template
    // rewrites the same object instead of adding another.
    const path = buildMediaPath(accountId, `${row.name}-${row.meta_template_id ?? row.id}.${ext}`, null, FOLDER);
    const { error: uploadErr } = await db.storage.from(BUCKET).upload(path, buffer, {
      contentType,
      cacheControl: '31536000',
      upsert: true,
    });
    if (uploadErr) throw new Error(`upload failed: ${uploadErr.message}`);
    const publicUrl = db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    if (!publicUrl) throw new Error('no public URL');

    const { error: updateErr } = await db
      .from('message_templates')
      .update({ header_media_url: publicUrl })
      .eq('id', row.id)
      .or('header_media_url.is.null,header_media_url.eq.');
    if (updateErr) throw new Error(`save failed: ${updateErr.message}`);

    return { ...row, header_media_url: publicUrl };
  } catch (err) {
    console.warn(
      `[template-header-media] could not copy the approved ${kind} for template ${row.name}:`,
      err instanceof Error ? err.message : err,
    );
    return row;
  }
}
