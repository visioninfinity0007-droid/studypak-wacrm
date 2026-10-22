/**
 * Server-side consent/exclusion gate for every send path that fans a
 * template out to many numbers (contract requirement 3). The browser
 * audience already filters, but the send routes must not trust it: a
 * number that is excluded, or a contact without recorded consent, is
 * refused here before anything reaches Meta.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { broadcastEligibility, type BroadcastEligibility } from './consent';

const CHUNK = 200;

export type EligibilityCheck = (phone: string) => BroadcastEligibility;

/**
 * Load consent + exclusions for `phones` in this account and return a
 * lookup. A number with no matching contact has no recorded consent, so
 * it is refused ('no_consent').
 */
export async function loadBroadcastEligibility(
  db: SupabaseClient,
  accountId: string,
  phones: readonly string[],
): Promise<EligibilityCheck> {
  const keys = [...new Set(phones.map((p) => normalizePhone(p)).filter(Boolean))];
  const excluded = new Set<string>();
  const consentByKey = new Map<string, string>();

  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const [ex, ct] = await Promise.all([
      db.from('contact_exclusions').select('phone_normalized')
        .eq('account_id', accountId).in('phone_normalized', slice),
      db.from('contacts').select('phone_normalized, consent_status')
        .eq('account_id', accountId).in('phone_normalized', slice),
    ]);
    if (ex.error) throw new Error(`exclusions lookup failed: ${ex.error.message}`);
    if (ct.error) throw new Error(`consent lookup failed: ${ct.error.message}`);
    for (const row of (ex.data ?? []) as { phone_normalized: string }[]) excluded.add(row.phone_normalized);
    for (const row of (ct.data ?? []) as { phone_normalized: string; consent_status: string | null }[]) {
      if (row.consent_status === 'granted') consentByKey.set(row.phone_normalized, 'granted');
      else if (!consentByKey.has(row.phone_normalized)) consentByKey.set(row.phone_normalized, row.consent_status ?? 'unknown');
    }
  }

  return (phone: string) => {
    const key = normalizePhone(phone);
    return broadcastEligibility({ phone: key, consent_status: consentByKey.get(key) ?? 'unknown' }, excluded);
  };
}
