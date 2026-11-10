// ============================================================
// POST /api/whatsapp/broadcast/[id]/schedule — manage a scheduled
// broadcast before it goes out.
//
//   { action: 'reschedule', scheduledAt }  move the send time
//   { action: 'send_now' }                 start sending at once
//   { action: 'cancel' }                   back to draft; its stored
//                                          recipients are removed so
//                                          "Continue" rebuilds them
//
// Every action applies only while the broadcast is still 'scheduled'.
// The worker may start it at the same moment, so each write is
// conditional on that status and a lost race answers 409 rather than
// touching a campaign that is already sending. Requires 'agent'.
// ============================================================

import { NextResponse, after } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { SCHEDULE_ERROR_MESSAGES, checkScheduledAt } from '@/lib/broadcast-schedule';
import { supabaseServiceRole } from '@/lib/supabase/admin';
import { drainBroadcast, isSendingPaused } from '@/lib/whatsapp/broadcast-queue';

export const maxDuration = 300;
const PASS_BUDGET_MS = 240_000;

const NOT_SCHEDULED = { error: 'This campaign is no longer scheduled' };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as
      | { action?: unknown; scheduledAt?: unknown }
      | null;
    const action = body?.action;
    if (action !== 'reschedule' && action !== 'send_now' && action !== 'cancel') {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    // RLS-scoped read: the broadcast must belong to the caller's college.
    const { data: broadcast, error } = await supabase
      .from('broadcasts')
      .select('id, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error || !broadcast) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }
    if (broadcast.status !== 'scheduled') return NextResponse.json(NOT_SCHEDULED, { status: 409 });

    const nowIso = new Date().toISOString();

    if (action === 'reschedule') {
      const check = checkScheduledAt(body?.scheduledAt, Date.now());
      if (!check.ok) {
        return NextResponse.json({ error: SCHEDULE_ERROR_MESSAGES[check.reason] }, { status: 400 });
      }
      const { data, error: upErr } = await supabase
        .from('broadcasts')
        .update({ scheduled_at: check.iso, updated_at: nowIso })
        .eq('id', id)
        .eq('status', 'scheduled')
        .select('id');
      if (upErr) return NextResponse.json({ error: 'Could not change the send time' }, { status: 500 });
      if (!data?.length) return NextResponse.json(NOT_SCHEDULED, { status: 409 });
      return NextResponse.json({ scheduledAt: check.iso });
    }

    if (action === 'send_now') {
      const { data, error: upErr } = await supabase
        .from('broadcasts')
        .update({ status: 'sending', scheduled_at: nowIso, updated_at: nowIso })
        .eq('id', id)
        .eq('status', 'scheduled')
        .select('id');
      if (upErr) return NextResponse.json({ error: 'Could not start the campaign' }, { status: 500 });
      if (!data?.length) return NextResponse.json(NOT_SCHEDULED, { status: 409 });
      if (!isSendingPaused()) {
        const admin = supabaseServiceRole();
        after(async () => {
          try {
            await drainBroadcast(admin, id, Date.now() + PASS_BUDGET_MS);
          } catch (err) {
            console.error(`[broadcast schedule] send-now pass for ${id} failed:`, err);
          }
        });
      }
      return NextResponse.json({ queued: true }, { status: 202 });
    }

    // cancel: flip first so the worker can't start it, then drop the
    // stored recipients — a draft carries none.
    const { data, error: upErr } = await supabase
      .from('broadcasts')
      .update({ status: 'draft', scheduled_at: null, total_recipients: 0, updated_at: nowIso })
      .eq('id', id)
      .eq('status', 'scheduled')
      .select('id');
    if (upErr) return NextResponse.json({ error: 'Could not cancel the schedule' }, { status: 500 });
    if (!data?.length) return NextResponse.json(NOT_SCHEDULED, { status: 409 });
    const { error: delErr } = await supabaseServiceRole()
      .from('broadcast_recipients')
      .delete()
      .eq('broadcast_id', id)
      .eq('status', 'pending');
    if (delErr) {
      console.error(`[broadcast schedule] cancel ${id}: recipients not removed:`, delErr.message);
    }
    return NextResponse.json({ cancelled: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
