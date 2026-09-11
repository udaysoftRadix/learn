import { NextRequest, NextResponse } from "next/server";
import { pending, sweepExpired, PENDING_TTL_MS, MAX_INPUT_LENGTH } from "./shared";

// Registers the text to speak and returns an id — the actual audio is
// generated on GET /api/tts/[id], which the client points an <audio>
// element at so playback can start while the file is still streaming in,
// instead of waiting for a full fetch()+blob() download first.
export async function POST(req: NextRequest) {
  if (!process.env.OPENROUTER_API_KEY) {
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

  sweepExpired();
  const id = crypto.randomUUID();
  pending.set(id, {
    text: text.length > MAX_INPUT_LENGTH ? text.slice(0, MAX_INPUT_LENGTH) : text,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });

  return NextResponse.json({ id });
}
