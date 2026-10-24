'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  fetchTemplateRecipientIds,
  resolveAudienceContacts,
  splitAlreadySent,
  type AudienceConfig,
} from '@/lib/broadcast-audience';
import { normalizeKey } from '@/lib/contacts/dedupe';
import { fetchAllInChunks } from '@/lib/supabase/paged-query';
import { Contact, MessageTemplate } from '@/types';
import { getT } from '@/lib/i18n/translate';

export type {
  AudienceConfig,
  CustomFieldFilter,
  CustomFieldOperator,
} from '@/lib/broadcast-audience';

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
  /**
   * Also send to contacts that already received this template in an
   * earlier campaign. Off by default: they are skipped.
   */
  resendAlreadySent?: boolean;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Sending itself is done by the server-side queue
 * (src/lib/whatsapp/broadcast-queue.ts), which owns pacing and retries.
 */
/** `broadcast_recipients` inserts are independent of the send rate. */
const INSERT_BATCH_SIZE = 200;

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  const rows = await fetchAllInChunks<
    { contact_id: string; custom_field_id: string; value: string | null },
    string
  >(contactIds, (slice, from, to) =>
    supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice)
      .order('id')
      .range(from, to),
  );

  for (const row of rows) {
    const bucket = index.get(row.contact_id) ?? new Map<string, string>();
    bucket.set(row.custom_field_id, row.value ?? '');
    index.set(row.contact_id, bucket);
  }
  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const t = getT('Broadcasts.sending');
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
    const supabase = createClient();
    return resolveAudienceContacts(supabase, audience, (rows) =>
      upsertCsvContacts(supabase, rows),
    );
  }

  /**
   * CSV uploads arrive as raw phone/name pairs, not DB rows. Before we
   * can insert broadcast_recipients (whose contact_id FKs contacts.id),
   * we need real contacts.id UUIDs. So: look up each CSV phone in the
   * caller's contacts table; insert any that don't exist; return the
   * resolved set.
   *
   * Pre-existing implementation synthesized `csv-N` strings as
   * contact_id, which failed the UUID cast on insert — every CSV
   * broadcast silently created zero recipients.
   *
   * Matching is on the normalized number throughout, so it agrees with
   * the account-wide unique index rather than colliding with it.
   */
  async function upsertCsvContacts(
    supabase: ReturnType<typeof createClient>,
    csvRows: { phone: string; name?: string }[],
  ): Promise<Contact[]> {
    if (csvRows.length === 0) return [];

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      throw new Error(t('notSignedIn'));
    }
    if (!accountId) {
      throw new Error(t('notLinkedToAccount'));
    }

    // De-duplicate within the CSV on the NORMALIZED number — the same
    // key the DB's UNIQUE (account_id, phone_normalized) index uses
    // (migration 022). Keyed on the raw string instead, "+1 555-0100"
    // and "15550100" survived as two rows and the insert below died on
    // a 23505, failing the whole broadcast.
    const uniqueByKey = new Map<string, { phone: string; name?: string }>();
    for (const row of csvRows) {
      const key = normalizeKey(row.phone);
      if (key && !uniqueByKey.has(key)) uniqueByKey.set(key, row);
    }
    const keys = [...uniqueByKey.keys()];

    // Single round-trip lookup of the contacts already in this ACCOUNT.
    // Scoping to `user_id` missed rows a teammate created on a shared
    // account, so those numbers looked new and their inserts collided
    // with the account-wide unique index.
    let existing: Contact[];
    try {
      existing = await fetchAllInChunks<Contact, string>(
        keys,
        (slice, from, to) =>
          supabase
            .from('contacts')
            .select('*')
            .eq('account_id', accountId)
            .in('phone_normalized', slice)
            .order('id')
            .range(from, to),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(t('lookupCsvContactsFailed', { error: message }));
    }

    const byKey = new Map<string, Contact>();
    for (const c of existing) {
      const key = normalizeKey(c.phone ?? '');
      if (key) byKey.set(key, c);
    }

    // Insert only missing contacts, in one batch per 200 rows (PostgREST
    // has a default payload cap — 200 keeps individual requests small).
    const missing = keys
      .filter((k) => !byKey.has(k))
      .map((k) => uniqueByKey.get(k)!)
      .map((row) => ({
        user_id: user.id,
        account_id: accountId,
        phone: row.phone,
        name: row.name ?? null,
      }));

    const INSERT_CHUNK = 200;
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from('contacts')
        .insert(chunk)
        .select();
      if (insertErr) {
        throw new Error(t('createCsvContactsFailed', { error: insertErr.message }));
      }
      for (const c of (inserted ?? []) as Contact[]) {
        const key = normalizeKey(c.phone ?? '');
        if (key) byKey.set(key, c);
      }
    }

    // Preserve input order so analytics roughly matches the CSV order.
    return keys
      .map((k) => byKey.get(k))
      .filter((c): c is Contact => Boolean(c));
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error(t('notSignedIn'));
      }
      if (!accountId) {
        throw new Error(t('notLinkedToAccount'));
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const audienceContacts = await resolveAudience(payload.audience);

      if (audienceContacts.length === 0) {
        throw new Error(t('noContactsForAudience'));
      }

      // Skip students who already got this template, unless the sender
      // ticked "send to them again" on the last step.
      let contacts = audienceContacts;
      let skippedAlreadySent = 0;
      if (!payload.resendAlreadySent) {
        const sentIds = await fetchTemplateRecipientIds(supabase, payload.template.name);
        const split = splitAlreadySent(audienceContacts, sentIds);
        contacts = split.toSend;
        skippedAlreadySent = split.alreadySent.length;
        if (contacts.length === 0) {
          throw new Error(t('allAlreadyReceived', { count: skippedAlreadySent }));
        }
      }

      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(10);
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            listIds: payload.audience.listIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
            resendAlreadySent: Boolean(payload.resendAlreadySent),
            skippedAlreadySent,
          },
          // 'draft' until every recipient row exists — the queue route
          // flips it to 'sending', so the worker can't start (and finish)
          // a half-inserted campaign.
          status: 'draft',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(
          t('createBroadcastFailed', {
            error: broadcastError?.message ?? t('unknownErrorLower'),
          }),
        );
      }

      // ── Step 3: Insert recipient rows ─────────────────────────────
      // Custom values are fetched BEFORE the insert so each row can
      // carry its resolved template params. Those params are what makes
      // the campaign resumable server-side (issue #472): the send loop
      // below runs in this browser tab, and if the tab goes away the
      // only record of what {{1}} should be for each contact is this
      // column. Resolving once here also means the resume sends exactly
      // what this pass would have.
      setProgress(20);
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contacts.map((c) => c.id),
      );
      const paramsByContact = new Map(
        contacts.map((contact) => [
          contact.id,
          resolveVariables(
            payload.variables,
            contact,
            customValueIndex.get(contact.id),
          ),
        ]),
      );
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
        template_params: paramsByContact.get(contact.id) ?? [],
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          // Previous impl logged and marched on — the broadcast then ran
          // with an incomplete recipient set, so webhook status updates
          // couldn't find some rows and the aggregate counts drifted.
          // Flip the broadcast to failed so the user sees the problem
          // immediately, then throw to abort the send loop.
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcast.id);
          throw new Error(
            t('insertRecipientBatchFailed', {
              batch: i / INSERT_BATCH_SIZE + 1,
              error: recipientError.message,
            }),
          );
        }
      }

      // ── Step 4: Hand the broadcast to the server-side queue ───────
      // Contract requirement 4: the server sends (paced, retried,
      // crash-safe) — the browser no longer loops over recipients, so
      // closing this tab doesn't stop the campaign. Media-header
      // templates need their header URL on every send; it's stored on
      // the broadcast for the queue to use.
      setProgress(60);
      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      if (isMediaHeader && headerMediaUrl) {
        const { error: paramsError } = await supabase
          .from('broadcasts')
          .update({ send_params: { headerMediaUrl } })
          .eq('id', broadcast.id);
        if (paramsError) throw new Error(t('apiRequestFailed'));
      }

      setProgress(80);
      const res = await fetch(`/api/whatsapp/broadcast/${broadcast.id}/queue`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || t('apiRequestFailed'));
      }

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
