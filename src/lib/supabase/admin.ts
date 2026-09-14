import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client — full access, bypasses Row Level Security. Only ever
// import this in server-only code (scripts, route handlers), never in
// anything that ships to the browser.
export function createAdminClient() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
