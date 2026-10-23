// GET /api/admin/broadcasts[?college=<id>] — every college's campaigns
// with delivery counts and an estimated PKR cost, newest first, for the
// platform admin's oversight view on /admin.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { toErrorResponse } from "@/lib/auth/account";
import { parseCollegeFilter, toAdminBroadcast, type BroadcastRow } from "@/lib/admin/oversight";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api.adminColleges");
const LIMIT = 200;

export async function GET(request: Request) {
  try {
    const { admin } = await requirePlatformAdmin();
    const filter = parseCollegeFilter(request.url);
    if (!filter.ok) {
      return NextResponse.json({ error: t("invalidField", { field: "college" }) }, { status: 400 });
    }

    let broadcastsQ = admin
      .from("broadcasts")
      .select(
        "id, account_id, name, template_name, status, total_recipients, sent_count, delivered_count, read_count, replied_count, failed_count, created_at, scheduled_at",
      )
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (filter.collegeId) broadcastsQ = broadcastsQ.eq("account_id", filter.collegeId);

    const [broadcastsRes, accountsRes] = await Promise.all([
      broadcastsQ,
      admin.from("accounts").select("id, name, broadcast_rate_pkr"),
    ]);
    if (broadcastsRes.error || accountsRes.error) {
      console.error("[admin/broadcasts GET]", broadcastsRes.error ?? accountsRes.error);
      return NextResponse.json({ error: t("loadFailed") }, { status: 500 });
    }

    const colleges = new Map(
      (accountsRes.data ?? []).map((a: { id: string; name: string; broadcast_rate_pkr: number | string | null }) => [
        a.id,
        { id: a.id, name: a.name, ratePkr: a.broadcast_rate_pkr === null ? null : Number(a.broadcast_rate_pkr) },
      ]),
    );
    return NextResponse.json({
      broadcasts: ((broadcastsRes.data ?? []) as BroadcastRow[]).map((row) => toAdminBroadcast(row, colleges)),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
