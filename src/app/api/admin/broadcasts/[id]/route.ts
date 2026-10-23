// GET /api/admin/broadcasts/[id] — why a campaign's messages failed:
// failed recipients grouped by Meta's error text. Platform admins only;
// the college's own campaign page shows the per-recipient detail.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { toErrorResponse } from "@/lib/auth/account";
import { summarizeFailures } from "@/lib/admin/oversight";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api.adminColleges");

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { admin } = await requirePlatformAdmin();
    const { id } = await params;

    const { data, error } = await admin
      .from("broadcast_recipients")
      .select("error_message")
      .eq("broadcast_id", id)
      .eq("status", "failed")
      .limit(5000);
    if (error) {
      console.error("[admin/broadcasts/:id GET]", error);
      return NextResponse.json({ error: t("loadFailed") }, { status: 500 });
    }
    return NextResponse.json({ failures: summarizeFailures(data ?? []) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
