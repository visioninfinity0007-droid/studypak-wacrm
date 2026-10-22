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
// ============================================================

import { NextResponse, after } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseServiceRole } from '@/lib/supabase/admin';
import { drainBroadcast, isSendingPaused } from '@/lib/whatsapp/broadcast-queue';

export const maxDuration = 300;
const PASS_BUDGET_MS = 240_000;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

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
