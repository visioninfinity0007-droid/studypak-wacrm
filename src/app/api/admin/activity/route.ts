// GET /api/admin/activity[?college=<id>] — recent activity across every
// college (or one), for the platform admin's oversight view on /admin.
// Same feed as each college's dashboard, built per college with the
// service-role client and an explicit account filter, then merged.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { toErrorResponse } from "@/lib/auth/account";
import { mergeCollegeActivity, parseCollegeFilter } from "@/lib/admin/oversight";
import { loadActivity } from "@/lib/dashboard/queries";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api.adminColleges");
const LIMIT = 60;

export async function GET(request: Request) {
  try {
    const { admin } = await requirePlatformAdmin();
    const filter = parseCollegeFilter(request.url);
    if (!filter.ok) {
      return NextResponse.json({ error: t("invalidField", { field: "college" }) }, { status: 400 });
    }

    let accountsQ = admin.from("accounts").select("id, name").order("created_at", { ascending: true });
    if (filter.collegeId) accountsQ = accountsQ.eq("id", filter.collegeId);
    const { data: accounts, error } = await accountsQ;
    if (error) {
      console.error("[admin/activity GET]", error);
      return NextResponse.json({ error: t("loadFailed") }, { status: 500 });
    }

    const groups = await Promise.all(
      (accounts ?? []).map(async (college: { id: string; name: string }) => ({
        college,
        items: await loadActivity(admin, LIMIT, { accountId: college.id }),
      })),
    );
    return NextResponse.json({ items: mergeCollegeActivity(groups, LIMIT) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
