import { NextRequest, NextResponse } from "next/server";

const SYSTEM_PROMPT = `You are NurseQ, an academic and clinical-education assistant specializing in nursing, medicine, and mental health.

You help with things like: human anatomy and physiology, psychiatric and mental health concepts, nursing education (fundamentals through advanced coursework), nursing administration and leadership, advanced nursing practice (nurse practitioner, clinical nurse specialist, nurse anesthetist, nurse midwife, and similar roles), and academic research support for PhD and graduate-level work — explaining research methodologies, structuring literature reviews, clarifying statistical concepts, and discussing theoretical frameworks.

Rules:
- Only answer questions related to these domains (nursing, medicine, anatomy/physiology, psychiatry/mental health, nursing education/administration/advanced practice, and related academic research). If a question is unrelated (e.g. general chit-chat, coding help, etc.), politely decline and steer the conversation back — do not answer the unrelated part even partially.
- This is for education and research, not clinical decision-making. Never give a diagnosis, treatment plan, or medication dosage for a specific real patient — point the user to a licensed clinician or their institution's protocols for actual patient care.
- Never state a specific clinical fact, statistic, drug dosage, or diagnostic criterion with confidence unless you are sure it's correct. If you are not sure, say so explicitly rather than guessing — a plausible-sounding wrong fact is worse than admitting uncertainty, especially in a clinical or psychiatric context.
- Never fabricate citations, studies, or sources. Only reference research you are confident actually exists, and say so plainly when you are not certain — this matters most for PhD-level research support.
- Keep answers clear, well-structured, and precise, using correct clinical and academic terminology at a level appropriate for nursing students, faculty, and graduate researchers.
- Format every answer as Markdown so it can be scanned quickly:
  - For a short, simple answer (a definition, a quick fact, a one-line clarification), just write plain prose — do not force structure onto something that doesn't need it.
  - For a longer or multi-part answer, open with one bolded summary line starting with "**TL;DR:**" that gives the core takeaway in a sentence or two, then use "##" headings for main sections and bullet lists for enumerable facts.
  - If the answer has secondary detail that most readers won't need immediately (e.g. rare side effects, edge cases, interactions), put it under its own "###" heading placed after the main "##" sections — "###" sections render as collapsible, so use them for genuinely secondary detail, not core content.
  - When comparing exactly two things (e.g. two drug classes, two conditions, two roles), use a Markdown table with the compared items as columns. Keep column headers short (2–4 words, e.g. "SSRIs" not "SSRIs (Selective Serotonin Reuptake Inhibitors)") — spell the full term out in the row content instead. Keep table cells to a short phrase, not a full sentence, and never use HTML tags like "<br>" inside a cell — plain Markdown only.
  - Bold key clinical terms the first time they appear in a section.`;

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ImageAttachment = {
  mimeType: string;
  data: string; // base64, no "data:" prefix
};

// Google occasionally deprecates/renames model ids and free-tier flash models can return
// a transient 503 under high demand, so try the configured model first and fall back
// through a short list of current flash models if it fails.
const FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-flash-latest"];

// If every Gemini model is unavailable, fall back to free models on OpenRouter.
// Only gemma-4-31b-it accepts image input — if an image is attached and Gemini
// is exhausted, it's tried first so the image still actually gets answered
// instead of silently being dropped.
const OPENROUTER_FALLBACK_MODELS: { model: string; supportsVision: boolean }[] = [
  { model: "nvidia/nemotron-3-ultra-550b-a55b:free", supportsVision: false },
  { model: "google/gemma-4-31b-it:free", supportsVision: true },
  { model: "nvidia/nemotron-3.5-lightning:free", supportsVision: false },
];

// Free-tier quota/rate-limit errors look scary in raw form (RESOURCE_EXHAUSTED,
// quota metric names, retry-info blobs) — not something an end user needs to
// see. Detect them and show one plain sentence instead.
function isQuotaOrRateLimitError(errText: string): boolean {
  return /quota|resource_exhausted|rate limit|429/i.test(errText);
}

async function callModel(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  image?: ImageAttachment
): Promise<{ reply: string } | { error: string; status: number }> {
  let upstream: Response;
  try {
    const lastIndex = messages.length - 1;
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: messages.map((m, i) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts:
              image && i === lastIndex
                ? [{ text: m.content }, { inline_data: { mime_type: image.mimeType, data: image.data } }]
                : [{ text: m.content }],
          })),
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { error: timedOut ? "timed out" : "network error", status: 504 };
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return { error: `(${upstream.status}) ${errText}`, status: upstream.status };
  }

  const data = await upstream.json();
  const reply: string | undefined = data.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text || "")
    .join("");

  if (!reply) {
    return { error: "no reply in response", status: 502 };
  }
  return { reply };
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  image?: ImageAttachment
): Promise<{ reply: string } | { error: string; status: number }> {
  let upstream: Response;
  try {
    const lastIndex = messages.length - 1;
    upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages.map((m, i) => ({
            role: m.role,
            content:
              image && i === lastIndex
                ? [
                    { type: "text", text: m.content },
                    { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
                  ]
                : m.content,
          })),
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { error: timedOut ? "timed out" : "network error", status: 504 };
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return { error: `(${upstream.status}) ${errText}`, status: upstream.status };
  }

  const data = await upstream.json();
  const reply: string | undefined = data.choices?.[0]?.message?.content;

  if (!reply) {
    return { error: "no reply in response", status: 502 };
  }
  return { reply };
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing GEMINI_API_KEY. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }

  let messages: ChatMessage[];
  let image: ImageAttachment | undefined;
  try {
    const body = await req.json();
    messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("messages must be a non-empty array");
    }
    if (body.image) {
      if (typeof body.image.mimeType !== "string" || typeof body.image.data !== "string") {
        throw new Error("image must have mimeType and data strings");
      }
      image = body.image;
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const primaryModel = process.env.GEMINI_MODEL || FALLBACK_MODELS[0];
  const modelsToTry = [primaryModel, ...FALLBACK_MODELS.filter((m) => m !== primaryModel)];

  const errors: string[] = [];
  for (const model of modelsToTry) {
    const result = await callModel(apiKey, model, messages, image);
    if ("reply" in result) {
      return NextResponse.json({ reply: result.reply, model });
    }
    errors.push(`${model}: ${result.error}`);
    // Only retry with a different model on transient upstream failures, not our own bugs.
    if (result.status !== 429 && result.status !== 404 && result.status !== 503 && result.status !== 504) {
      break;
    }
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    // If there's an image, try vision-capable fallbacks first so it still
    // gets answered instead of silently ignored by a text-only model.
    const orderedFallbacks = image
      ? [...OPENROUTER_FALLBACK_MODELS].sort((a, b) => Number(b.supportsVision) - Number(a.supportsVision))
      : OPENROUTER_FALLBACK_MODELS;

    for (const { model, supportsVision } of orderedFallbacks) {
      const result = await callOpenRouter(openRouterKey, model, messages, supportsVision ? image : undefined);
      if ("reply" in result) {
        return NextResponse.json({ reply: result.reply, model });
      }
      errors.push(`${model}: ${result.error}`);
      if (result.status !== 429 && result.status !== 404 && result.status !== 503 && result.status !== 504) {
        break;
      }
    }
  }

  console.error(`NurseQ chat: all models failed —\n${errors.join("\n")}`);

  const friendlyMessage = errors.every(isQuotaOrRateLimitError)
    ? "NurseQ is temporarily at capacity (free-tier usage limits on the underlying models). Please try again in a few minutes."
    : `All models are currently unavailable. Tried:\n${errors.join("\n")}`;

  return NextResponse.json({ error: friendlyMessage }, { status: 502 });
}
