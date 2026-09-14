// One-off setup script — creates the single shared demo login in Supabase
// Auth. Run once: node --env-file=.env.local scripts/seed-demo-user.mjs
import { createClient } from "@supabase/supabase-js";

const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEMO_USER_EMAIL, DEMO_USER_PASSWORD } = process.env;

for (const [name, value] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  DEMO_USER_EMAIL,
  DEMO_USER_PASSWORD,
})) {
  if (!value) {
    console.error(`Missing ${name} in .env.local`);
    process.exit(1);
  }
}

const admin = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: existing, error: listError } = await admin.auth.admin.listUsers();
if (listError) {
  console.error("Could not list existing users:", listError.message);
  process.exit(1);
}

const already = existing.users.find((u) => u.email === DEMO_USER_EMAIL);
if (already) {
  console.log(`Demo user already exists: ${DEMO_USER_EMAIL} (id: ${already.id})`);
  process.exit(0);
}

const { data, error } = await admin.auth.admin.createUser({
  email: DEMO_USER_EMAIL,
  password: DEMO_USER_PASSWORD,
  email_confirm: true,
});

if (error) {
  console.error("Failed to create demo user:", error.message);
  process.exit(1);
}

console.log(`Demo user created: ${data.user.email} (id: ${data.user.id})`);
