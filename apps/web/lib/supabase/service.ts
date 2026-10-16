import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client for the agent worker ONLY. It bypasses row-level security,
 * so every query made with it must filter by tenant explicitly. Never import this
 * from a page or a user-facing server action.
 */
export function supabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Which integrations the deployment has credentials for. Values are never exposed. */
export function integrationStatus() {
  return {
    worker: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY),
    // the Vercel Supabase integration sets SUPABASE_URL; it must point at the same project as the app
    workerProjectMatches: !process.env.SUPABASE_URL || process.env.SUPABASE_URL.replace(/\/$/, "") === process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, ""),
    ai: Boolean(process.env.ANTHROPIC_API_KEY),
    email: Boolean(process.env.RESEND_API_KEY),
    googlePlaces: Boolean(process.env.GOOGLE_PLACES_API_KEY),
  };
}
