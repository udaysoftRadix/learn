import { createBrowserClient } from "@supabase/ssr";

// One browser client per app — createBrowserClient manages its own cookie
// sync internally, so no custom cookies option is needed here.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
