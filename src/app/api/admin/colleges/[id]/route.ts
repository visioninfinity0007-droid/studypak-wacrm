// PATCH /api/admin/colleges/[id] — rename, approve/suspend/reactivate,
// or set the PKR per-message rate of a college. Platform admins only.
// status and broadcast_rate_pkr are platform-managed columns (migrations
// 061/062): their triggers only allow postgres/service_role, which is
// what the service-role client connects as.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { toErrorResponse } from "@/lib/auth/account";
import { normalizeCollegeStatus, validateCollegeUpdate } from "@/lib/admin/colleges";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api.adminColleges");

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { admin } = await requirePlatformAdmin();
    const { id } = await params;

    const body = await request.json().catch(() => null);
    const parsed = validateCollegeUpdate(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: t("invalidField", { field: parsed.field }) }, { status: 400 });
    }

    const { data, error } = await admin
      .from("accounts")
      .update(parsed.value)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) {
      console.error("[admin/colleges PATCH]", error);
      return NextResponse.json({ error: t("updateFailed") }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: t("notFound") }, { status: 404 });

    return NextResponse.json({
      college: {
        id: data.id,
        name: data.name,
        status: normalizeCollegeStatus(data.status),
        broadcastRatePkr:
          data.broadcast_rate_pkr === null || data.broadcast_rate_pkr === undefined
            ? null
            : Number(data.broadcast_rate_pkr),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
