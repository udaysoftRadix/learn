"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LogoImage, DEFAULT_LOGO, playClickSound } from "@/components/kimi-ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message === "Invalid login credentials" ? "Incorrect email or password." : error.message);
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl p-6 sm:p-8 flex flex-col gap-5"
        style={{ background: "var(--paper-0)", boxShadow: "0 4px 6px rgba(0,0,0,0.06), 0 10px 24px rgba(0,0,0,0.06)" }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <LogoImage logo={DEFAULT_LOGO} size={56} />
          <div>
            <h1 className="text-xl font-semibold font-display">Welcome to Kimi</h1>
            <p className="text-sm text-ink-600 mt-1">Nursing, medicine &amp; mental health research assistant</p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-xs font-semibold text-ink-600">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-xl border border-ink-300 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-current"
              placeholder="you@example.com"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-xs font-semibold text-ink-600">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-xl border border-ink-300 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-current"
              placeholder="••••••••"
            />
          </div>
        </div>

        {error && (
          <p className="text-sm" style={{ color: "var(--alert-700)" }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          onClick={() => playClickSound()}
          disabled={loading}
          className="pop-btn rounded-full text-white px-4 py-3 text-sm font-semibold disabled:opacity-50"
          style={{ background: "var(--user-pink)", boxShadow: "0 4px 0 var(--user-pink-dark), 0 5px 8px rgba(0,0,0,0.15)" }}
        >
          {loading ? "Logging in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
