import { NextRequest, NextResponse } from "next/server";
import { pending, sweepExpired, synthesizeSpeech } from "../shared";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  sweepExpired();
  const entry = pending.get(id);
  if (!entry) {
    return NextResponse.json(
      { error: "This audio link has expired. Click Listen again to regenerate it." },
      { status: 404 }
    );
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing OPENROUTER_API_KEY. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }

  const result = await synthesizeSpeech(entry.text, apiKey);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return new NextResponse(result.body, {
    headers: { "Content-Type": result.contentType },
  });
}
