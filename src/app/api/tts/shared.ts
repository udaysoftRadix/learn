// Shared between POST /api/tts (registers text, returns an id) and
// GET /api/tts/[id] (actually synthesizes and streams the audio). Splitting
// it this way lets the client point a plain <audio src="..."> at the GET
// route so the browser streams and plays audio progressively, instead of
// waiting to download the whole file via fetch()+blob() first.

export type PendingEntry = { text: string; expiresAt: number };

export const pending = new Map<string, PendingEntry>();
export const PENDING_TTL_MS = 5 * 60 * 1000;

export function sweepExpired() {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt < now) pending.delete(id);
  }
}

export const MAX_INPUT_LENGTH = 4000;

const TTS_MODELS: { model: string; voice?: string }[] = [
  { model: "deepgram/flux-tts:free", voice: "flux-heather-en" },
  { model: "fish-audio/s2.1-pro-free:free" },
];

// A manual AbortController instead of AbortSignal.timeout() — the latter can
// throw an immutable DOMException that trips an unhandled "Cannot set
// property message" TypeError downstream on slower requests.
function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export async function synthesizeSpeech(
  text: string,
  apiKey: string
): Promise<{ ok: true; body: ReadableStream<Uint8Array> | null; contentType: string } | { ok: false; error: string; status: number }> {
  const errors: string[] = [];

  for (const { model, voice } of TTS_MODELS) {
    let upstream: Response;
    try {
      upstream = await fetchWithTimeout("https://openrouter.ai/api/v1/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: text,
          ...(voice ? { voice } : {}),
          response_format: "mp3",
        }),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      errors.push(`${model}: ${timedOut ? "timed out" : "network error"}`);
      continue;
    }

    if (!upstream.ok) {
      const errText = await upstream.text();
      errors.push(`${model}: (${upstream.status}) ${errText}`);
      if (upstream.status !== 429 && upstream.status !== 404 && upstream.status !== 503 && upstream.status !== 504) {
        break;
      }
      continue;
    }

    return {
      ok: true,
      body: upstream.body,
      contentType: upstream.headers.get("Content-Type") || "audio/mpeg",
    };
  }

  return {
    ok: false,
    error: `All text-to-speech models are currently unavailable. Tried:\n${errors.join("\n")}`,
    status: 502,
  };
}
