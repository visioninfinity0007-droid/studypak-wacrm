// PATCH /api/admin/colleges/[id] — rename, approve/suspend/reactivate,
// or set the PKR per-message rate of a college. Platform admins only.
// status and broadcast_rate_pkr are platform-managed columns (migrations
// 061/062): their triggers only allow postgres/service_role, which is
// what the service-role client connects as.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { ForbiddenError, toErrorResponse } from "@/lib/auth/account";
import { normalizeCollegeStatus, validateCollegeUpdate } from "@/lib/admin/colleges";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api.adminColleges");

export const maxDuration = 60;

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
      .is("deletion_started_at", null)
      .select("*")
      .maybeSingle();
    if (error) {
      console.error("[admin/colleges PATCH]", error);
      return NextResponse.json({ error: t("updateFailed") }, { status: 500 });
    }
    if (!data) {
      const { data: existing, error: lookupError } = await admin
        .from("accounts")
        .select("deletion_started_at")
        .eq("id", id)
        .maybeSingle();
      if (lookupError) return NextResponse.json({ error: t("updateFailed") }, { status: 500 });
      return existing?.deletion_started_at
        ? NextResponse.json({ error: t("deletionInProgress") }, { status: 409 })
        : NextResponse.json({ error: t("notFound") }, { status: 404 });
    }

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

type DeletionStep =
  | { status: "remove_files"; objects: { bucket: string; path: string }[] }
  | { status: "deleted" | "not_found" | "not_suspended" | "name_mismatch" | "protected" };

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (request.headers.get("x-requested-with") !== "StudyPak") throw new ForbiddenError();
    const { admin, userId } = await requirePlatformAdmin();
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (typeof body?.confirmation !== "string" || !body.confirmation.trim()) {
      return NextResponse.json({ error: t("deleteNameMismatch") }, { status: 400 });
    }

    // The database does the authorization and verifies the remaining files
    // on every call. Keep each request bounded so a large college can resume.
    const deadline = Date.now() + 40_000;
    for (let batch = 0; batch < 16 && Date.now() < deadline; batch += 1) {
      const { data, error } = await admin.rpc("delete_suspended_college", {
        p_account_id: id,
        p_actor_id: userId,
        p_confirmation: body.confirmation.trim(),
      });
      if (error || !data) {
        console.error("[admin/colleges DELETE] database step failed", error?.code);
        return NextResponse.json({ error: t("deleteFailed") }, { status: 500 });
      }

      const step = data as DeletionStep;
      switch (step.status) {
        case "deleted":
          return new Response(null, { status: 204 });
        case "not_found":
          return NextResponse.json({ error: t("notFound") }, { status: 404 });
        case "not_suspended":
          return NextResponse.json({ error: t("deleteRequiresSuspension") }, { status: 409 });
        case "name_mismatch":
          return NextResponse.json({ error: t("deleteNameMismatch") }, { status: 409 });
        case "protected":
          return NextResponse.json({ error: t("deleteProtected") }, { status: 409 });
        case "remove_files": {
          const pathsByBucket = new Map<string, string[]>();
          for (const { bucket, path } of step.objects) {
            const paths = pathsByBucket.get(bucket) ?? [];
            paths.push(path);
            pathsByBucket.set(bucket, paths);
          }
          for (const [bucket, paths] of pathsByBucket) {
            const { error: storageError } = await admin.storage.from(bucket).remove(paths);
            if (storageError) {
              console.error("[admin/colleges DELETE] Storage cleanup failed", storageError.name);
              return NextResponse.json({ error: t("deleteFailed") }, { status: 502 });
            }
          }
          break;
        }
        default:
          return NextResponse.json({ error: t("deleteFailed") }, { status: 500 });
      }
    }
    return NextResponse.json({ error: t("deletionInProgress") }, { status: 409 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
