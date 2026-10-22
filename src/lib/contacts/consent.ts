/**
 * Consent and exclusions — contract requirement 3. Owning a student's
 * number is not permission to message them, so broadcasts only go to
 * contacts with recorded consent whose number is not on the account's
 * exclusion list (opted out by replying STOP, or excluded by staff).
 *
 * Browser-safe: used by the import modal, the broadcast audience and
 * the server-side send routes.
 */

import { normalizePhone } from '@/lib/whatsapp/phone-utils';

export const CONSENT_STATUSES = ['unknown', 'granted', 'revoked'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export function normalizeConsentStatus(value: unknown): ConsentStatus {
  return typeof value === 'string' && (CONSENT_STATUSES as readonly string[]).includes(value)
    ? (value as ConsentStatus)
    : 'unknown';
}

/**
 * Parse an optional per-row `consent` cell. Returns true/false for a
 * clear answer, undefined for blank/unrecognised (falls back to the
 * import-level attestation).
 */
export function parseConsentCell(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'granted', 'opt-in', 'optin', 'ok'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'revoked', 'opt-out', 'optout', 'denied'].includes(v)) return false;
  return undefined;
}

/** Digits-only phone key, same as contacts.phone_normalized / exclusions. */
export function exclusionKey(phone: string): string {
  return normalizePhone(phone);
}

export interface BroadcastEligibility {
  eligible: boolean;
  reason?: 'excluded' | 'no_consent';
}

/** Broadcast rule shared by the browser audience and the server checks. */
export function broadcastEligibility(
  contact: { phone: string; consent_status?: string | null },
  excludedKeys: ReadonlySet<string>,
): BroadcastEligibility {
  if (excludedKeys.has(exclusionKey(contact.phone))) return { eligible: false, reason: 'excluded' };
  if (normalizeConsentStatus(contact.consent_status) !== 'granted') {
    return { eligible: false, reason: 'no_consent' };
  }
  return { eligible: true };
}

/**
 * Inbound opt-out / opt-in keywords. Matched against the whole message
 * (trimmed, case-insensitive), so "stop" opts out but "please don't
 * stop sending" does not.
 */
const STOP_WORDS = new Set([
  'stop', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'opt out', 'optout', 'opt-out',
  'remove', 'remove me', 'band karo', 'bnd karo', 'بند', 'بند کرو', 'بند کریں',
]);
const START_WORDS = new Set(['start', 'subscribe', 'unstop', 'opt in', 'optin', 'opt-in']);

export function classifyOptKeyword(text: string | null | undefined): 'stop' | 'start' | null {
  if (!text) return null;
  const v = text.trim().toLowerCase().replace(/[.!\s]+$/u, '').replace(/\s+/g, ' ');
  if (STOP_WORDS.has(v)) return 'stop';
  if (START_WORDS.has(v)) return 'start';
  return null;
}
