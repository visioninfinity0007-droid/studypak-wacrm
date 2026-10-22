// Platform administrator gate (contract requirement 1).
//
// Platform admins (Study in Pakistan) manage every college from /admin.
// Membership lives in `platform_admins` (migration 062), which is only
// writable by the service role. The check runs with the service-role
// client so it can't be satisfied by anything a tenant can write, and it
// deliberately does NOT go through getCurrentAccount(): a platform admin
// can still administer colleges even if their own college is suspended.
//
// Server-only, like ./account.

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { supabaseServiceRole } from "@/lib/supabase/admin";
import { getT } from "@/lib/i18n/translate";
import { ForbiddenError, UnauthorizedError } from "./account";

const t = getT("LibErrors.auth");

export interface PlatformAdminContext {
  userId: string;
  /** Service-role client — bypasses RLS. Admin routes only. */
  admin: SupabaseClient;
}

export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new UnauthorizedError();

  const admin = supabaseServiceRole();
  const { data, error: lookupErr } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (lookupErr) {
    // Table missing (migration 062 not applied yet) or a transient
    // error — either way, fail closed.
    console.error("[requirePlatformAdmin] lookup error:", lookupErr);
    throw new ForbiddenError(t("platformAdminOnly"));
  }
  if (!data) throw new ForbiddenError(t("platformAdminOnly"));

  return { userId: user.id, admin };
}
