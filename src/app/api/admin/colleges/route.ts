// ============================================================
// /api/admin/colleges — platform-admin college management
// (contract requirement 1). Every handler starts with
// requirePlatformAdmin(); the service-role client it returns is the
// only way these routes touch other tenants' rows.
//
// GET  — list every college (account) with owner, members, usage and
//        WhatsApp connection.
// POST — create a college: creates the college admin's login with a
//        one-time password (app_metadata marks it platform-created, so
//        handle_new_user starts the account 'active' under the college
//        name). The password is returned exactly once; email is not
//        used because Supabase's built-in mailer only reaches project
//        members.
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { toErrorResponse } from "@/lib/auth/account";
import {
  generateTempPassword,
  normalizeCollegeStatus,
  validateNewCollege,
} from "@/lib/admin/colleges";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api.adminColleges");

interface AccountRow {
  id: string;
  name: string;
  status?: string | null;
  owner_user_id: string;
  created_at: string;
  broadcast_rate_pkr?: number | string | null;
}

async function countFor(admin: SupabaseClient, table: string, accountId: string): Promise<number> {
  const { count } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  return count ?? 0;
}

export async function GET() {
  try {
    const { admin } = await requirePlatformAdmin();

    const [accountsRes, profilesRes, waRes] = await Promise.all([
      admin.from("accounts").select("*").order("created_at", { ascending: true }),
      admin.from("profiles").select("user_id, email, full_name, account_id, account_role"),
      admin.from("whatsapp_config").select("account_id, phone_number_id, status"),
    ]);
    if (accountsRes.error || profilesRes.error || waRes.error) {
      console.error("[admin/colleges GET]", accountsRes.error ?? profilesRes.error ?? waRes.error);
      return NextResponse.json({ error: t("loadFailed") }, { status: 500 });
    }

    const profiles = profilesRes.data ?? [];
    const colleges = await Promise.all(
      ((accountsRes.data ?? []) as AccountRow[]).map(async (a) => {
        const owner = profiles.find((p) => p.user_id === a.owner_user_id);
        const wa = (waRes.data ?? []).find((w) => w.account_id === a.id);
        const [contacts, broadcasts] = await Promise.all([
          countFor(admin, "contacts", a.id),
          countFor(admin, "broadcasts", a.id),
        ]);
        const rate = a.broadcast_rate_pkr;
        return {
          id: a.id,
          name: a.name,
          status: normalizeCollegeStatus(a.status),
          createdAt: a.created_at,
          ownerEmail: owner?.email ?? null,
          ownerName: owner?.full_name ?? null,
          members: profiles.filter((p) => p.account_id === a.id).length,
          contacts,
          broadcasts,
          whatsapp: wa
            ? { connected: wa.status === "connected", phoneNumberIdTail: String(wa.phone_number_id).slice(-4) }
            : null,
          broadcastRatePkr: rate === null || rate === undefined ? null : Number(rate),
        };
      }),
    );

    return NextResponse.json({ colleges });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { admin } = await requirePlatformAdmin();

    const body = await request.json().catch(() => null);
    const parsed = validateNewCollege(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: t("invalidField", { field: parsed.field }) }, { status: 400 });
    }
    const { collegeName, adminName, adminEmail } = parsed.value;
    const tempPassword = generateTempPassword();

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: adminEmail,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { full_name: adminName },
      app_metadata: { platform_created: "true", college_name: collegeName },
    });
    if (createErr || !created?.user) {
      const exists = /already|registered|exists/i.test(createErr?.message ?? "");
      return NextResponse.json(
        { error: exists ? t("emailTaken") : t("createFailed") },
        { status: exists ? 409 : 500 },
      );
    }

    // handle_new_user swallows its own errors, so confirm the college
    // actually exists before reporting success; undo the login if not.
    const userId = created.user.id;
    const { data: profile } = await admin
      .from("profiles")
      .select("account_id")
      .eq("user_id", userId)
      .maybeSingle();
    const { data: account } = profile?.account_id
      ? await admin.from("accounts").select("*").eq("id", profile.account_id).maybeSingle()
      : { data: null };
    if (!account) {
      await admin.auth.admin.deleteUser(userId);
      return NextResponse.json({ error: t("createFailed") }, { status: 500 });
    }

    return NextResponse.json(
      {
        college: { id: account.id, name: account.name, status: normalizeCollegeStatus(account.status) },
        login: { email: adminEmail, tempPassword },
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
