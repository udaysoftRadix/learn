import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// A fresh client per request for Server Components / Route Handlers.
// setAll is wrapped in try/catch because Server Components can't set
// cookies — when called from one, proxy.ts is what persists the session.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // called from a Server Component — proxy.ts handles the refresh
        }
      },
    },
  });
}
