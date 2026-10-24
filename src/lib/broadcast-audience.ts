import type { SupabaseClient } from '@supabase/supabase-js';

import { fetchAllInChunks, fetchAllPages } from '@/lib/supabase/paged-query';
import { broadcastEligibility } from '@/lib/contacts/consent';
import { normalizeKey } from '@/lib/contacts/dedupe';
import type { Contact } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export type AudienceType = 'all' | 'tags' | 'lists' | 'custom_field' | 'csv';

export interface CsvAudienceRow {
  phone: string;
  name?: string;
}

export interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  /** Contact lists (migration 066) for the 'lists' audience. */
  listIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: CsvAudienceRow[];
  excludeTagIds?: string[];
}

async function withContext<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch ${label}: ${message}`);
  }
}

export function fetchTaggedContactIds(
  db: SupabaseClient,
  tagIds: readonly string[],
): Promise<Set<string>> {
  return withContext('contact tags', async () => {
    const rows = await fetchAllInChunks<{ contact_id: string }, string>(
      tagIds,
      (slice, from, to) =>
        db
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', slice)
          .order('id')
          .range(from, to),
    );
    return new Set(rows.map((row) => row.contact_id));
  });
}

/** Contacts in any of the given contact lists (migration 066). */
export function fetchListContactIds(
  db: SupabaseClient,
  listIds: readonly string[],
): Promise<Set<string>> {
  return withContext('contact lists', async () => {
    const rows = await fetchAllInChunks<{ contact_id: string }, string>(
      listIds,
      (slice, from, to) =>
        db
          .from('contact_list_members')
          .select('contact_id')
          .in('list_id', slice)
          .order('contact_id')
          .order('list_id')
          .range(from, to),
    );
    return new Set(rows.map((row) => row.contact_id));
  });
}

export function fetchCustomFieldContactIds(
  db: SupabaseClient,
  filter: CustomFieldFilter,
): Promise<Set<string>> {
  return withContext('custom field matches', async () => {
    const { fieldId, operator, value } = filter;
    const rows = await fetchAllPages<{ contact_id: string }>((from, to) => {
      let query = db
        .from('contact_custom_values')
        .select('contact_id')
        .eq('custom_field_id', fieldId);
      if (operator === 'is') query = query.eq('value', value);
      else if (operator === 'is_not') query = query.neq('value', value);
      else query = query.ilike('value', `%${value}%`);
      return query.order('id').range(from, to);
    });
    return new Set(rows.map((row) => row.contact_id));
  });
}

export function fetchContactsByIds(
  db: SupabaseClient,
  ids: readonly string[],
): Promise<Contact[]> {
  return withContext('contacts', () =>
    fetchAllInChunks<Contact, string>(ids, (slice, from, to) =>
      db.from('contacts').select('*').in('id', slice).order('id').range(from, to),
    ),
  );
}

export function fetchAllContacts(db: SupabaseClient): Promise<Contact[]> {
  return withContext('contacts', () =>
    fetchAllPages<Contact>((from, to) =>
      db.from('contacts').select('*').order('id').range(from, to),
    ),
  );
}

async function fetchExcludedIds(
  db: SupabaseClient,
  audience: AudienceConfig,
): Promise<Set<string>> {
  if (!audience.excludeTagIds || audience.excludeTagIds.length === 0) {
    return new Set();
  }
  return fetchTaggedContactIds(db, audience.excludeTagIds);
}

function hasCustomFieldFilter(
  audience: AudienceConfig,
): audience is AudienceConfig & { customField: CustomFieldFilter } {
  return Boolean(audience.customField?.fieldId);
}

async function fetchAudienceContactIds(
  db: SupabaseClient,
  audience: AudienceConfig,
): Promise<Set<string> | null> {
  if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
    return fetchTaggedContactIds(db, audience.tagIds);
  }
  if (audience.type === 'lists' && audience.listIds && audience.listIds.length > 0) {
    return fetchListContactIds(db, audience.listIds);
  }
  if (audience.type === 'custom_field' && hasCustomFieldFilter(audience)) {
    return fetchCustomFieldContactIds(db, audience.customField);
  }
  return null;
}

/**
 * Digits-only numbers on this account's do-not-message list (contract
 * requirement 3). RLS scopes the read to the caller's account.
 */
export function fetchExclusionKeys(db: SupabaseClient): Promise<Set<string>> {
  return withContext('exclusions', async () => {
    const rows = await fetchAllPages<{ phone_normalized: string }>((from, to) =>
      db.from('contact_exclusions').select('phone_normalized').order('id').range(from, to),
    );
    return new Set(rows.map((row) => row.phone_normalized));
  });
}

/**
 * Who a broadcast may actually go to: recorded consent and not on the
 * exclusion list. Applied to every audience type, including CSV.
 */
export async function resolveAudienceContacts(
  db: SupabaseClient,
  audience: AudienceConfig,
  resolveCsv: (rows: CsvAudienceRow[]) => Promise<Contact[]>,
): Promise<Contact[]> {
  const targeted = await resolveTargetedContacts(db, audience, resolveCsv);
  if (targeted.length === 0) return [];
  const exclusionKeys = await fetchExclusionKeys(db);
  return targeted.filter(
    (contact) => broadcastEligibility(contact, exclusionKeys).eligible,
  );
}

async function resolveTargetedContacts(
  db: SupabaseClient,
  audience: AudienceConfig,
  resolveCsv: (rows: CsvAudienceRow[]) => Promise<Contact[]>,
): Promise<Contact[]> {
  const excluded = await fetchExcludedIds(db, audience);
  const keep = (contact: Contact) => !excluded.has(contact.id);

  if (audience.type === 'all') {
    return (await fetchAllContacts(db)).filter(keep);
  }
  if (audience.type === 'csv') {
    if (!audience.csvContacts) return [];
    return (await resolveCsv(audience.csvContacts)).filter(keep);
  }

  const ids = await fetchAudienceContactIds(db, audience);
  if (!ids) return [];
  const wanted = [...ids].filter((id) => !excluded.has(id));
  if (wanted.length === 0) return [];
  return fetchContactsByIds(db, wanted);
}

export async function countAudience(
  db: SupabaseClient,
  audience: AudienceConfig,
): Promise<number | null> {
  if (audience.type === 'csv') {
    return audience.csvContacts && audience.csvContacts.length > 0
      ? audience.csvContacts.length
      : null;
  }

  // Counts only contacts with recorded consent — the ones a broadcast
  // will actually reach (an excluded number can never be 'granted', the
  // database enforces that — migration 063).
  if (audience.type === 'all') {
    const { count, error } = await db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('consent_status', 'granted');
    if (error) throw new Error(`Failed to count contacts: ${error.message}`);
    const total = count ?? 0;
    const excluded = await fetchExcludedIds(db, audience);
    return Math.max(0, total - excluded.size);
  }

  if (audience.type === 'custom_field' && !audience.customField?.value) {
    return null;
  }

  const ids = await fetchAudienceContactIds(db, audience);
  if (!ids) return null;
  const excluded = await fetchExcludedIds(db, audience);
  const wanted = [...ids].filter((id) => !excluded.has(id));
  if (wanted.length === 0) return 0;
  const granted = await withContext('contact consent', () =>
    fetchAllInChunks<{ id: string }, string>(wanted, (slice, from, to) =>
      db
        .from('contacts')
        .select('id')
        .in('id', slice)
        .eq('consent_status', 'granted')
        .order('id')
        .range(from, to),
    ),
  );
  return granted.length;
}

// ── Already received this template ─────────────────────────────────
// Client request (2026-10-24): when the same students turn up in a new
// sheet, don't send them a template they already got unless the sender
// ticks "send to them again". "Got it" = a recipient row for that
// template that actually went out (sent / delivered / read / replied);
// failed and still-pending sends don't count.

const RECEIVED_STATUSES = ['sent', 'delivered', 'read', 'replied'];

/** Contacts that already received `templateName` in an earlier campaign. */
export function fetchTemplateRecipientIds(
  db: SupabaseClient,
  templateName: string,
): Promise<Set<string>> {
  return withContext('earlier recipients', async () => {
    const rows = await fetchAllPages<{ contact_id: string | null }>((from, to) =>
      db
        .from('broadcast_recipients')
        .select('contact_id, broadcasts!inner(template_name)')
        .eq('broadcasts.template_name', templateName)
        .in('status', RECEIVED_STATUSES)
        .not('contact_id', 'is', null)
        .order('id')
        .range(from, to),
    );
    return new Set(rows.map((row) => row.contact_id).filter((id): id is string => !!id));
  });
}

/** Split an audience into contacts to send to and those already sent. */
export function splitAlreadySent<T extends { id: string }>(
  contacts: readonly T[],
  alreadySentIds: ReadonlySet<string>,
): { toSend: T[]; alreadySent: T[] } {
  const toSend: T[] = [];
  const alreadySent: T[] = [];
  for (const contact of contacts) {
    (alreadySentIds.has(contact.id) ? alreadySent : toSend).push(contact);
  }
  return { toSend, alreadySent };
}

/**
 * Read-only CSV resolution for previews: the CSV numbers that are
 * already contacts. (Sending creates the missing ones; a number that
 * isn't a contact yet can't have received anything.)
 */
export function lookupCsvContacts(
  db: SupabaseClient,
  rows: readonly CsvAudienceRow[],
): Promise<Contact[]> {
  const keys = [...new Set(rows.map((row) => normalizeKey(row.phone)).filter(Boolean))];
  return withContext('CSV contacts', () =>
    fetchAllInChunks<Contact, string>(keys, (slice, from, to) =>
      db.from('contacts').select('*').in('phone_normalized', slice).order('id').range(from, to),
    ),
  );
}

/** How many of this audience already received `templateName`. */
export async function countAlreadySent(
  db: SupabaseClient,
  audience: AudienceConfig,
  templateName: string,
): Promise<number> {
  const sentIds = await fetchTemplateRecipientIds(db, templateName);
  if (sentIds.size === 0) return 0;
  const contacts = await resolveAudienceContacts(db, audience, (rows) => lookupCsvContacts(db, rows));
  return splitAlreadySent(contacts, sentIds).alreadySent.length;
}
