import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy service-role client for platform-admin routes. Bypasses RLS —
// only call it after `requirePlatformAdmin()` has passed. Same shape as
// src/lib/automations/admin-client.ts and src/lib/flows/admin-client.ts.
let _serviceClient: SupabaseClient | null = null

export function supabaseServiceRole(): SupabaseClient {
  if (!_serviceClient) {
    _serviceClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
  }
  return _serviceClient
}
