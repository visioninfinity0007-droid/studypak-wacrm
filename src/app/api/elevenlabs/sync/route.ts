// ============================================================
// GET /api/elevenlabs/sync — copy ElevenLabs bot replies into the inbox.
//
// Called every minute by a Coolify scheduled task with the shared
// `x-cron-secret` header, same check as /api/broadcasts/worker. See
// src/lib/elevenlabs/bot-replies.ts for what it imports and why.
// Answers 503 until ELEVENLABS_API_KEY is set, so the task is harmless
// on a deployment without an ElevenLabs agent. `?since=<unix seconds>`
// imports older history once (the scheduled tick looks back a week).
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseServiceRole } from '@/lib/supabase/admin';
import { syncElevenLabsBotReplies } from '@/lib/elevenlabs/bot-replies';

export const maxDuration = 60;

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

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'ElevenLabs not configured' }, { status: 503 });

  const sinceParam = new URL(request.url).searchParams.get('since');
  const sinceUnix = sinceParam && /^\d{10}$/.test(sinceParam) ? Number(sinceParam) : undefined;

  try {
    return NextResponse.json(
      await syncElevenLabsBotReplies(supabaseServiceRole(), { apiKey, sinceUnix }),
    );
  } catch (err) {
    console.error('[elevenlabs/sync] failed:', err);
    return NextResponse.json({ error: 'sync failed' }, { status: 500 });
  }
}
