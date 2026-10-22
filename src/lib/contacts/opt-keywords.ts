/**
 * STOP / START replies (contract requirement 3). Called by the WhatsApp
 * webhook for every new inbound text, with the service-role client.
 *
 * STOP → number added to the account's exclusion list (the database then
 *        revokes the contact's consent — migration 063) + confirmation.
 * START → exclusion removed, consent recorded from the student's own
 *        reply + confirmation.
 *
 * Returns true when the message was an opt keyword, so the caller treats
 * it as consumed (no flow / automation / AI reply answers it as well).
 * Never throws: a failure here must not break inbound message handling.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { engineSendText } from '@/lib/automations/meta-send';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { classifyOptKeyword } from './consent';

export const OPT_OUT_CONFIRMATION =
  "You've been unsubscribed and won't receive further broadcast messages from us. Reply START to subscribe again.";
export const OPT_IN_CONFIRMATION =
  "You're subscribed again and will receive our updates. Reply STOP at any time to unsubscribe.";

export interface OptKeywordInput {
  accountId: string;
  /** Config owner — the user the confirmation message is sent as. */
  userId: string;
  contactId: string;
  conversationId: string;
  contactPhone: string;
  text: string | null | undefined;
}

export async function handleOptKeyword(
  db: SupabaseClient,
  input: OptKeywordInput,
): Promise<boolean> {
  const kind = classifyOptKeyword(input.text);
  if (!kind) return false;
  const key = normalizePhone(input.contactPhone);
  if (!key) return false; // BSUID-only contact: no number to exclude

  try {
    if (kind === 'stop') {
      const { error } = await db
        .from('contact_exclusions')
        .upsert(
          { account_id: input.accountId, phone_normalized: key, reason: 'opt_out', note: 'Replied STOP' },
          { onConflict: 'account_id,phone_normalized', ignoreDuplicates: true },
        );
      if (error) throw error;
    } else {
      const { error: delErr } = await db
        .from('contact_exclusions')
        .delete()
        .eq('account_id', input.accountId)
        .eq('phone_normalized', key);
      if (delErr) throw delErr;
      const { error: consentErr } = await db
        .from('contacts')
        .update({
          consent_status: 'granted',
          consent_source: 'start_reply',
          consent_evidence: 'Student replied START on WhatsApp',
          consent_at: new Date().toISOString(),
        })
        .eq('id', input.contactId);
      if (consentErr) throw consentErr;
    }
  } catch (err) {
    console.error(`[opt-keyword] ${kind} handling failed for contact ${input.contactId}:`, err);
    return false;
  }

  try {
    await engineSendText({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text: kind === 'stop' ? OPT_OUT_CONFIRMATION : OPT_IN_CONFIRMATION,
    });
  } catch (err) {
    // The opt-out itself is recorded; a failed confirmation is logged only.
    console.error('[opt-keyword] confirmation send failed:', err);
  }
  return true;
}
