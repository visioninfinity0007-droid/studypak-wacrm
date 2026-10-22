// ============================================================
// Persistent server-side broadcast queue — contract requirement 4.
//
// A broadcast is "queued" when its status is 'sending' (or 'scheduled'
// and due) and it has 'pending' recipient rows. drainBroadcast() sends
// them from the server, so nothing depends on a browser tab staying open:
//
//  * Lease  — broadcasts.delivery_locked_at is claimed with a short lease
//             and renewed while working, so two workers never send the
//             same campaign; a crashed worker's lease simply expires.
//  * Pacing — sends are spaced to BROADCAST_MESSAGES_PER_SECOND.
//  * Retry  — Meta rate-limit / temporary errors and network failures are
//             retried with growing back-off (up to MAX_ATTEMPTS); permanent
//             errors fail at once with Meta's message. A rate-limit error
//             also ends the pass for the whole campaign.
//  * Crash recovery — a row still marked attempt_started_at when a new
//             lease is taken was in flight when the previous worker died.
//             Meta may have delivered it, so it is not resent (no
//             duplicates): it's failed with that reason, and can be
//             retried deliberately ("Retry failed").
//  * Consent — re-checked for every pass (contract requirement 3).
//  * Kill switch — BROADCAST_SENDING_PAUSED=true stops all sending.
//
// Entry points: the dashboard's "Send now" (POST .../[id]/queue) runs one
// pass immediately; /api/broadcasts/worker (every minute) is the safety
// net that resumes anything left — retries, interrupted passes, scheduled
// campaigns.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { loadBroadcastEligibility } from '@/lib/contacts/consent-server';
import { decrypt } from '@/lib/whatsapp/encryption';
import { MetaApiError, sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { RATE_LIMIT_CODES, TEMPORARY_CODES } from '@/lib/whatsapp/meta-error-explain';
import {
  isRecipientNotAllowedError,
  isValidE164,
  phoneVariants,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { finalizeBroadcastStatus } from '@/lib/whatsapp/broadcast-core';

export const QUEUE_LEASE_MS = 2 * 60 * 1000;
export const LEASE_RENEW_MS = 30 * 1000;
export const MAX_ATTEMPTS = 3;
/** Wait before attempt 2, 3, … */
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const PAGE_SIZE = 200;

export const INTERRUPTED_MESSAGE =
  'Outcome unknown: sending was interrupted mid-send. Not resent automatically to avoid a duplicate — use "Retry failed" to send again.';

export function sendRatePerSecond(): number {
  const raw = Number(process.env.BROADCAST_MESSAGES_PER_SECOND);
  if (!Number.isFinite(raw) || raw <= 0) return 10;
  return Math.min(Math.max(raw, 1), 50);
}

export function isSendingPaused(): boolean {
  return (process.env.BROADCAST_SENDING_PAUSED ?? '').toLowerCase() === 'true';
}

export type SendErrorKind = 'rate_limited' | 'transient' | 'permanent';

/** Classify a send failure for the retry policy. */
export function classifySendError(err: unknown): SendErrorKind {
  if (err instanceof MetaApiError) {
    if (err.code !== null && RATE_LIMIT_CODES.has(err.code)) return 'rate_limited';
    if (err.httpStatus === 429) return 'rate_limited';
    if (err.code !== null && TEMPORARY_CODES.has(err.code)) return 'transient';
    if (err.httpStatus >= 500) return 'transient';
    return 'permanent';
  }
  // fetch() network failure, timeout, DNS — not an answer from Meta.
  return 'transient';
}

export function backoffFor(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length) - 1] ?? RETRY_BACKOFF_MS.at(-1)!;
}

export interface QueueDeps {
  send?: typeof sendTemplateMessage;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface DrainResult {
  broadcastId: string;
  skipped?: 'locked' | 'not_due' | 'paused' | 'not_configured';
  sent: number;
  failed: number;
  retrying: number;
  recoveredInterrupted: number;
  /** Pending rows left when the pass ended (retries + not reached). */
  remaining: number;
  finished: boolean;
}

interface QueueRow {
  id: string;
  attempt_count: number | null;
  template_params: unknown;
  contact: { phone?: string | null } | { phone?: string | null }[] | null;
}

function rowPhone(row: QueueRow): string {
  const c = Array.isArray(row.contact) ? row.contact[0] : row.contact;
  return sanitizePhoneForMeta(c?.phone ?? '');
}

/** Claim the queue lease; true when this worker now owns the broadcast. */
export async function claimQueueLease(db: SupabaseClient, broadcastId: string, nowMs: number): Promise<boolean> {
  const cutoff = new Date(nowMs - QUEUE_LEASE_MS).toISOString();
  const { data, error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: new Date(nowMs).toISOString() })
    .eq('id', broadcastId)
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${cutoff}`)
    .select('id');
  if (error) throw new Error(`lease claim failed: ${error.message}`);
  return (data ?? []).length > 0;
}

async function setLease(db: SupabaseClient, broadcastId: string, value: string | null) {
  await db.from('broadcasts').update({ delivery_locked_at: value }).eq('id', broadcastId);
}

/**
 * Send what is due for one broadcast until `deadlineMs`. Safe to call
 * concurrently from anywhere — only the lease holder sends.
 */
export async function drainBroadcast(
  db: SupabaseClient,
  broadcastId: string,
  deadlineMs: number,
  deps: QueueDeps = {},
): Promise<DrainResult> {
  const send = deps.send ?? sendTemplateMessage;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const result: DrainResult = {
    broadcastId, sent: 0, failed: 0, retrying: 0, recoveredInterrupted: 0, remaining: 0, finished: false,
  };

  if (isSendingPaused()) return { ...result, skipped: 'paused' };
  if (!(await claimQueueLease(db, broadcastId, now()))) return { ...result, skipped: 'locked' };

  try {
    const { data: broadcast, error: bcErr } = await db
      .from('broadcasts')
      .select('id, account_id, status, scheduled_at, template_name, template_language, send_params')
      .eq('id', broadcastId)
      .maybeSingle();
    if (bcErr || !broadcast) throw new Error(`broadcast ${broadcastId} not loadable`);
    if (broadcast.status === 'scheduled') {
      if (broadcast.scheduled_at && Date.parse(broadcast.scheduled_at) > now()) {
        return { ...result, skipped: 'not_due' };
      }
      await db.from('broadcasts').update({ status: 'sending' }).eq('id', broadcastId);
    } else if (broadcast.status !== 'sending') {
      return { ...result, skipped: 'not_due', finished: true };
    }

    // Crash recovery: rows a dead worker left mid-send.
    const { data: interrupted } = await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: INTERRUPTED_MESSAGE, attempt_started_at: null })
      .eq('broadcast_id', broadcastId)
      .eq('status', 'pending')
      .not('attempt_started_at', 'is', null)
      .select('id');
    result.recoveredInterrupted = interrupted?.length ?? 0;

    const { data: config } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', broadcast.account_id)
      .maybeSingle();
    if (!config) return { ...result, skipped: 'not_configured' };
    const accessToken = decrypt(config.access_token);
    const resolved = await resolveTemplateRow(db, broadcast.account_id, broadcast.template_name, broadcast.template_language);
    // A malformed local template row would fail every recipient the same
    // way — leave them pending until it's repaired (Settings → Sync).
    if (resolved.malformed) return { ...result, skipped: 'not_configured' };
    const messageParams = (broadcast.send_params ?? undefined) as SendTimeParams | undefined;

    const pacingMs = Math.ceil(1000 / sendRatePerSecond());
    let lastRenew = now();
    let stop = false;

    while (!stop && now() < deadlineMs) {
      const dueBefore = new Date(now()).toISOString();
      const { data: rows, error: rowsErr } = await db
        .from('broadcast_recipients')
        .select('id, attempt_count, template_params, contact:contacts(phone)')
        .eq('broadcast_id', broadcastId)
        .eq('status', 'pending')
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${dueBefore}`)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(PAGE_SIZE);
      if (rowsErr) throw new Error(`recipient load failed: ${rowsErr.message}`);
      const page = (rows ?? []) as QueueRow[];
      if (page.length === 0) break;

      const eligibility = await loadBroadcastEligibility(db, broadcast.account_id, page.map(rowPhone));

      for (const row of page) {
        if (now() >= deadlineMs || isSendingPaused()) { stop = true; break; }
        if (now() - lastRenew > LEASE_RENEW_MS) {
          await setLease(db, broadcastId, new Date(now()).toISOString());
          lastRenew = now();
        }

        const phone = rowPhone(row);
        if (!isValidE164(phone)) {
          await db.from('broadcast_recipients')
            .update({ status: 'failed', error_message: 'No valid phone number on contact' }).eq('id', row.id);
          result.failed++;
          continue;
        }
        const allowed = eligibility(phone);
        if (!allowed.eligible) {
          await db.from('broadcast_recipients').update({
            status: 'failed',
            error_message: allowed.reason === 'excluded'
              ? 'Not sent: number is on the opt-out / exclusion list'
              : 'Not sent: no recorded consent for this contact',
          }).eq('id', row.id);
          result.failed++;
          continue;
        }

        const attempt = (row.attempt_count ?? 0) + 1;
        await db.from('broadcast_recipients')
          .update({ attempt_started_at: new Date(now()).toISOString(), attempt_count: attempt })
          .eq('id', row.id);

        const params = Array.isArray(row.template_params)
          ? row.template_params.filter((p): p is string => typeof p === 'string')
          : [];
        let messageId: string | null = null;
        let lastErr: unknown = null;
        for (const variant of phoneVariants(phone)) {
          try {
            const res = await send({
              phoneNumberId: config.phone_number_id,
              accessToken,
              to: variant,
              templateName: broadcast.template_name,
              language: resolved.language,
              template: resolved.row ?? undefined,
              params,
              messageParams,
            });
            messageId = res.messageId;
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            if (!isRecipientNotAllowedError(msg)) break;
          }
        }

        if (messageId) {
          await db.from('broadcast_recipients').update({
            status: 'sent', sent_at: new Date(now()).toISOString(), whatsapp_message_id: messageId,
            error_message: null, attempt_started_at: null, next_attempt_at: null,
          }).eq('id', row.id);
          result.sent++;
        } else {
          const kind = classifySendError(lastErr);
          const message = lastErr instanceof Error ? lastErr.message : 'Unknown error';
          if (kind !== 'permanent' && attempt < MAX_ATTEMPTS) {
            await db.from('broadcast_recipients').update({
              error_message: `Retrying (attempt ${attempt} of ${MAX_ATTEMPTS} failed): ${message}`,
              attempt_started_at: null,
              next_attempt_at: new Date(now() + backoffFor(attempt)).toISOString(),
            }).eq('id', row.id);
            result.retrying++;
            // Meta is throttling this number/account: stop the pass and
            // let the back-off and the next worker tick continue.
            if (kind === 'rate_limited') { stop = true; break; }
          } else {
            await db.from('broadcast_recipients').update({
              status: 'failed', error_message: message, attempt_started_at: null, next_attempt_at: null,
            }).eq('id', row.id);
            result.failed++;
          }
        }

        await sleep(pacingMs);
      }
    }

    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', 'pending');
    result.remaining = count ?? 0;
    if (result.remaining === 0) {
      await finalizeBroadcastStatus(db, broadcastId);
      result.finished = true;
    }
    return result;
  } finally {
    await setLease(db, broadcastId, null);
  }
}

/**
 * One worker tick: drain every broadcast that has due work, oldest first,
 * until the deadline. Called by /api/broadcasts/worker.
 */
export async function runQueueTick(
  db: SupabaseClient,
  deadlineMs: number,
  deps: QueueDeps = {},
): Promise<DrainResult[]> {
  if (isSendingPaused()) return [];
  const now = deps.now ?? Date.now;
  const { data, error } = await db
    .from('broadcasts')
    .select('id, status, scheduled_at')
    .in('status', ['sending', 'scheduled'])
    .order('updated_at', { ascending: true })
    .limit(25);
  if (error) throw new Error(`queue scan failed: ${error.message}`);

  const results: DrainResult[] = [];
  for (const b of (data ?? []) as { id: string; status: string; scheduled_at: string | null }[]) {
    if (now() >= deadlineMs) break;
    if (b.status === 'scheduled' && b.scheduled_at && Date.parse(b.scheduled_at) > now()) continue;
    try {
      results.push(await drainBroadcast(db, b.id, deadlineMs, deps));
    } catch (err) {
      console.error(`[broadcast-queue] drain ${b.id} failed:`, err);
    }
  }
  return results;
}
