import { NextRequest, NextResponse } from "next/server";

// Cross-encoder reranker: scores how relevant one attached document (an
// image, optionally with the question as accompanying text) is to the
// user's query. Used as a relevance gate before sending an attachment to
// the vision-capable chat model, not for ranking multiple candidates.
const RERANK_MODEL = "nvidia/llama-nemotron-rerank-vl-1b-v2:free";

// A manual AbortController instead of AbortSignal.timeout() — the latter can
// throw an immutable DOMException that trips an unhandled "Cannot set
// property message" TypeError downstream on slower requests.
function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing OPENROUTER_API_KEY. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }

  let query: string;
  let image: string;
  try {
    const body = await req.json();
    query = body.query;
    image = body.image;
    if (typeof query !== "string" || !query.trim() || typeof image !== "string" || !image.trim()) {
      throw new Error("query and image are required strings");
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/rerank",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: RERANK_MODEL,
          query,
          documents: [{ image }],
          top_n: 1,
        }),
      },
      20_000
    );
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return NextResponse.json({ error: timedOut ? "timed out" : "network error" }, { status: 504 });
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return NextResponse.json({ error: `(${upstream.status}) ${errText}` }, { status: upstream.status });
  }

  const data = await upstream.json();
  const relevanceScore: number | undefined = data.results?.[0]?.relevance_score;

  if (typeof relevanceScore !== "number") {
    return NextResponse.json({ error: "no relevance score in response" }, { status: 502 });
  }

  return NextResponse.json({ relevanceScore });
}
