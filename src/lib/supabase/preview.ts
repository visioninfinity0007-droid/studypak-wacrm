export function isPreviewWithoutSupabase(): boolean {
  return process.env.VERCEL_ENV === 'preview' &&
    (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
