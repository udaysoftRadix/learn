import { NextRequest, NextResponse } from "next/server";

// Free text-to-speech models on OpenRouter, tried in order.
const TTS_MODELS: { model: string; voice?: string }[] = [
  { model: "deepgram/flux-tts:free", voice: "flux-heather-en" },
  { model: "fish-audio/s2.1-pro-free:free" },
];

const MAX_INPUT_LENGTH = 4000;

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing OPENROUTER_API_KEY. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }

  let text: string;
  try {
    const body = await req.json();
    text = body.text;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("text must be a non-empty string");
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const input = text.length > MAX_INPUT_LENGTH ? text.slice(0, MAX_INPUT_LENGTH) : text;

  const errors: string[] = [];
  for (const { model, voice } of TTS_MODELS) {
    let upstream: Response;
    try {
      upstream = await fetch("https://openrouter.ai/api/v1/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input,
          ...(voice ? { voice } : {}),
          response_format: "mp3",
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
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

    const audio = await upstream.arrayBuffer();
    return new NextResponse(audio, {
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "audio/mpeg" },
    });
  }

  return NextResponse.json(
    { error: `All text-to-speech models are currently unavailable. Tried:\n${errors.join("\n")}` },
    { status: 502 }
  );
}
