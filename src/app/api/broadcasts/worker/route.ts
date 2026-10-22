// ============================================================
// GET /api/broadcasts/worker — broadcast queue tick (contract req. 4).
//
// Called every minute by the host's scheduler (a Coolify scheduled task
// on the VPS) with the shared `x-cron-secret` header, same secret and
// check as /api/automations/cron. Each tick drains every broadcast with
// due work — retries whose back-off has passed, passes cut short by a
// deadline or a crash, scheduled campaigns that came due — for up to
// ~50 s, so ticks don't pile up. Concurrent ticks are safe: only the
// holder of a broadcast's queue lease sends.
//
// Not under /api/whatsapp/ on purpose: the middleware 401s anonymous
// requests there, and this caller authenticates with the cron secret.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseServiceRole } from '@/lib/supabase/admin';
import { runQueueTick } from '@/lib/whatsapp/broadcast-queue';

export const maxDuration = 120;
const TICK_BUDGET_MS = 50_000;

function authorized(request: Request): boolean | null {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) return null;
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '');
  const want = Buffer.from(expected);
  return supplied.length === want.length && timingSafeEqual(supplied, want);
}

export async function GET(request: Request) {
  const ok = authorized(request);
  if (ok === null) return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const results = await runQueueTick(supabaseServiceRole(), Date.now() + TICK_BUDGET_MS);
    const worked = results.filter((r) => !r.skipped);
    return NextResponse.json({
      broadcasts: results.length,
      sent: worked.reduce((n, r) => n + r.sent, 0),
      failed: worked.reduce((n, r) => n + r.failed, 0),
      retrying: worked.reduce((n, r) => n + r.retrying, 0),
      recoveredInterrupted: worked.reduce((n, r) => n + r.recoveredInterrupted, 0),
      results,
    });
  } catch (err) {
    console.error('[broadcasts/worker] tick failed:', err);
    return NextResponse.json({ error: 'tick failed' }, { status: 500 });
  }
}
