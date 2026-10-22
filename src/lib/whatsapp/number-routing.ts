// Resolve which college (account) a WhatsApp webhook event belongs to,
// from the event's `metadata.phone_number_id`.
//
// 1. The college's main number: whatsapp_config.phone_number_id.
// 2. Otherwise an additional number (migration 065): the college that
//    owns it, with that college's main whatsapp_config — e.g. the number
//    an earlier broadcast went out from, which students keep replying to.
//
// Returns null (and logs why) when the number belongs to no college.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResolvedNumber<Config> {
  config: Config;
  /** True when matched through whatsapp_additional_numbers. */
  viaAdditional: boolean;
}

export async function resolveConfigForPhoneNumber<Config extends { account_id: string }>(
  db: SupabaseClient,
  phoneNumberId: string | undefined | null,
): Promise<ResolvedNumber<Config> | null> {
  if (!phoneNumberId) return null;

  const { data: main, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('phone_number_id', phoneNumberId);
  if (error) {
    console.error('[number-routing] whatsapp_config lookup failed:', phoneNumberId, error);
    return null;
  }
  if (main && main.length > 1) {
    console.error(`[number-routing] ${main.length} configs claim phone_number_id ${phoneNumberId}; event dropped`);
    return null;
  }
  if (main && main.length === 1) return { config: main[0] as Config, viaAdditional: false };

  const { data: extra, error: extraErr } = await db
    .from('whatsapp_additional_numbers')
    .select('account_id')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();
  if (extraErr) {
    // Table missing before migration 065 — same outcome as "unknown number".
    console.error('[number-routing] additional-number lookup failed:', phoneNumberId, extraErr.message);
    return null;
  }
  if (!extra) {
    console.error(`[number-routing] phone_number_id ${phoneNumberId} belongs to no college; event dropped`);
    return null;
  }

  const { data: owner, error: ownerErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', (extra as { account_id: string }).account_id)
    .maybeSingle();
  if (ownerErr || !owner) {
    console.error(`[number-routing] college for additional number ${phoneNumberId} has no main WhatsApp config; event dropped`);
    return null;
  }
  return { config: owner as Config, viaAdditional: true };
}
