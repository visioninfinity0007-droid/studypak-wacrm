// POST /api/admin/colleges/[id]/reset-password — give the college
// owner a new one-time password (returned once). The recovery path when
// a college admin is locked out, since password-reset emails can't be
// relied on without custom SMTP. Platform admins only.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { toErrorResponse } from "@/lib/auth/account";
import { generateTempPassword } from "@/lib/admin/colleges";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api.adminColleges");

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { admin, userId } = await requirePlatformAdmin();
    const { id } = await params;

    const { data: account, error } = await admin
      .from("accounts")
      .select("owner_user_id")
      .eq("id", id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: t("updateFailed") }, { status: 500 });
    if (!account) return NextResponse.json({ error: t("notFound") }, { status: 404 });
    // Platform admins change their own password from Settings → Security.
    if (account.owner_user_id === userId) {
      return NextResponse.json({ error: t("ownPassword") }, { status: 400 });
    }

    const tempPassword = generateTempPassword();
    const { data: updated, error: updateErr } = await admin.auth.admin.updateUserById(
      account.owner_user_id,
      { password: tempPassword },
    );
    if (updateErr || !updated?.user) {
      return NextResponse.json({ error: t("updateFailed") }, { status: 500 });
    }

    return NextResponse.json({ login: { email: updated.user.email, tempPassword } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
