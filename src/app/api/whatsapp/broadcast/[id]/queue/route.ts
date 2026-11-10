// ============================================================
// POST /api/whatsapp/broadcast/[id]/queue — hand a broadcast to the
// server-side queue and start sending now (contract requirement 4).
//
// The dashboard calls this right after creating the broadcast and its
// recipient rows. It marks the broadcast 'sending' and runs one queue
// pass in `after()`, so the response returns at once and sending carries
// on with the tab closed. Anything this pass doesn't finish (deadline,
// retries, a crash) is picked up by /api/broadcasts/worker within a
// minute. Requires the 'agent' role, like every other send path.
//
// With a JSON body `{ scheduledAt }` the broadcast is parked as
// 'scheduled' instead and nothing is sent now: the worker starts it once
// that time has passed (src/lib/broadcast-schedule.ts sets the window).
// ============================================================

import { NextResponse, after } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { SCHEDULE_ERROR_MESSAGES, checkScheduledAt } from '@/lib/broadcast-schedule';
import { supabaseServiceRole } from '@/lib/supabase/admin';
import { drainBroadcast, isSendingPaused } from '@/lib/whatsapp/broadcast-queue';

export const maxDuration = 300;
const PASS_BUDGET_MS = 240_000;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { scheduledAt?: unknown } | null;
    const wantsSchedule = body?.scheduledAt !== undefined && body?.scheduledAt !== null;

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

    if (wantsSchedule) {
      // Only a campaign that hasn't started can be given a send time.
      if (broadcast.status !== 'draft') {
        return NextResponse.json({ error: 'Only a new campaign can be scheduled' }, { status: 409 });
      }
      const check = checkScheduledAt(body?.scheduledAt, Date.now());
      if (!check.ok) {
        return NextResponse.json({ error: SCHEDULE_ERROR_MESSAGES[check.reason] }, { status: 400 });
      }
      const { error: schedErr } = await supabase
        .from('broadcasts')
        .update({ status: 'scheduled', scheduled_at: check.iso, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'draft');
      if (schedErr) return NextResponse.json({ error: 'Could not schedule broadcast' }, { status: 500 });
      return NextResponse.json({ scheduled: true, scheduledAt: check.iso }, { status: 202 });
    }

    if (broadcast.status !== 'sending' && broadcast.status !== 'scheduled') {
      const { error: markErr } = await supabase
        .from('broadcasts')
        .update({ status: 'sending', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (markErr) return NextResponse.json({ error: 'Could not queue broadcast' }, { status: 500 });
    }

    if (isSendingPaused()) {
      return NextResponse.json({ queued: true, paused: true }, { status: 202 });
    }

    const admin = supabaseServiceRole();
    after(async () => {
      try {
        await drainBroadcast(admin, id, Date.now() + PASS_BUDGET_MS);
      } catch (err) {
        console.error(`[broadcast queue] first pass for ${id} failed:`, err);
      }
    });
    return NextResponse.json({ queued: true }, { status: 202 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
