import { NextRequest, NextResponse } from "next/server";

const SYSTEM_PROMPT = `You are Kimi, an academic and clinical-education assistant specializing in nursing, medicine, and mental health.

You help with things like: human anatomy and physiology, psychiatric and mental health concepts, nursing education (fundamentals through advanced coursework), nursing administration and leadership, advanced nursing practice (nurse practitioner, clinical nurse specialist, nurse anesthetist, nurse midwife, and similar roles), and academic research support for PhD and graduate-level work — explaining research methodologies, structuring literature reviews, clarifying statistical concepts, and discussing theoretical frameworks.

Rules:
- Only answer questions related to these domains (nursing, medicine, anatomy/physiology, psychiatry/mental health, nursing education/administration/advanced practice, and related academic research). If a question is unrelated (e.g. general chit-chat, coding help, etc.), politely decline and steer the conversation back — do not answer the unrelated part even partially.
- This is for education and research, not clinical decision-making. Never give a diagnosis, treatment plan, or medication dosage for a specific real patient — point the user to a licensed clinician or their institution's protocols for actual patient care.
- Never state a specific clinical fact, statistic, drug dosage, or diagnostic criterion with confidence unless you are sure it's correct. If you are not sure, say so explicitly rather than guessing — a plausible-sounding wrong fact is worse than admitting uncertainty, especially in a clinical or psychiatric context.
- Never fabricate citations, studies, or sources. Only reference research you are confident actually exists, and say so plainly when you are not certain — this matters most for PhD-level research support.
- Keep answers precise, using correct clinical and academic terminology at a level appropriate for nursing students, faculty, and graduate researchers.
- Default to thorough, in-depth explanations, not short fragments. Under each heading, write real explanatory paragraphs — cover the mechanism, the "why," and clinical relevance, not just a bare list of facts. Use bullets only for content that is genuinely a list (e.g. a set of symptoms or medications), never as a substitute for explaining a concept in prose. Only give a short, bullet-heavy answer when the user explicitly asks you to shorten it, summarize, or "just give the key points" — and only for that one reply, not the rest of the conversation.
- If you used the web search results provided to you, say so naturally in the text (e.g. "according to a 2024 review in..." or "per the CDC's guidance...") so the reader knows the kind of source behind a claim. The verified source list is shown separately below your answer from the actual search results — never invent a source, title, author, journal name, or link yourself; only speak to what the search results actually returned.
- Format every answer as Markdown so it can be scanned:
  - For a short, simple answer (a definition, a quick fact, a one-line clarification), just write plain prose — do not force structure onto something that doesn't need it.
  - For a longer or multi-part answer, open with one bolded summary line starting with "**TL;DR:**" that gives the core takeaway in a sentence or two, then use "##" headings for main sections.
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

type Source = { title: string; uri: string };

// Google occasionally deprecates/renames model ids and free-tier flash models can return
// a transient 503 under high demand, so try the configured model first and fall back
// through a short list of current flash models if it fails.
const FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-flash-latest"];

// If every Gemini model is unavailable, fall back to free models on OpenRouter.
// Ordered roughly by fit-for-this-app and capability, then falling off to
// smaller/more niche models: a health/medicine-tuned model leads, general
// large reasoning models next, then vision-capable general models, then the
// smallest/fastest model as a last resort. When an image is attached, the
// vision-capable ones are additionally sorted to the front (see below) so
// the image still gets seen instead of silently dropped.
//
// Deliberately excluded from OpenRouter's free catalog: coding-agent models
// (poolside/laguna-s-2.1, nex-agi/nex-n2.5-pro — off-domain for clinical
// education), a finance-tuned model (inclusionai/ling-3.0-flash-fin), and
// nvidia/nemotron-3.5-content-safety, which is a moderation/guardrail
// classifier, not a conversational model — it wouldn't answer "hi" at all.
const OPENROUTER_FALLBACK_MODELS: { model: string; supportsVision: boolean }[] = [
  { model: "inclusionai/ling-3.0-flash-sante:free", supportsVision: false }, // health/medicine-tuned
  { model: "nvidia/nemotron-3-super-120b-a12b:free", supportsVision: false },
  { model: "nvidia/nemotron-3-ultra-550b-a55b:free", supportsVision: false },
  { model: "nvidia/nemotron-3.5-lightning:free", supportsVision: false },
  { model: "google/gemma-4-31b-it:free", supportsVision: true },
  { model: "google/gemma-4-26b-a4b-it:free", supportsVision: true },
  { model: "inclusionai/ling-3.0-flash-vl:free", supportsVision: true },
  { model: "dots-studio/dots-3-note-preview:free", supportsVision: true },
  { model: "thinkingmachines/inkling:free", supportsVision: true },
  { model: "thinkingmachines/inkling-small:free", supportsVision: true },
  { model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", supportsVision: true },
  { model: "liquid/lfm-2.5-2.6b:free", supportsVision: false },
];

// Statuses that mean "this specific model/provider is temporarily out of
// capacity" (quota exhausted, overloaded, gateway timeout, deprecated id) —
// worth trying the next fallback for, and worth telling the user is a
// capacity issue rather than a real bug, as opposed to a 400/401/500 class
// error that indicates something is actually broken in the request itself.
const TRANSIENT_STATUSES = new Set([429, 404, 503, 504]);

// Of those, only "overloaded" (503) is worth an immediate short retry on the
// SAME model — it's a fast, explicit rejection from the provider that often
// clears in a second or two. A 504 already burned the full 30s timeout once;
// retrying it risks doubling the user's wait for something unlikely to
// resolve that fast. A quota 429 won't refill in 1.5s, and a 404 means the
// model id itself is wrong — retrying either just wastes time.
const RETRY_ONCE_STATUSES = new Set([503]);
const RETRY_DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REQUEST_TIMEOUT_MS = 30_000;
// OpenRouter fallbacks get a shorter timeout than Gemini's primary attempts —
// with 12 of them now in the pool, keeping each attempt short bounds how
// long a genuine full-outage takes to fail through, rather than potentially
// several minutes at 30s each.
const OPENROUTER_TIMEOUT_MS = 15_000;

// A manual AbortController instead of AbortSignal.timeout() — the latter can
// throw an immutable DOMException that trips an unhandled "Cannot set
// property message" TypeError somewhere downstream on slower requests (seen
// with PDF attachments, which take longer for the model to process). A
// plain AbortController with our own setTimeout avoids that failure mode.
function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Gives one attempt a second, immediate try if it failed for a reason that
// often clears within a second or two (provider overload, a timed-out
// request) — before falling through to the next model in the fallback chain.
async function withShortRetry<T extends { reply: string } | { error: string; status: number }>(
  attempt: () => Promise<T>
): Promise<T> {
  const first = await attempt();
  if ("reply" in first || !RETRY_ONCE_STATUSES.has(first.status)) {
    return first;
  }
  await sleep(RETRY_DELAY_MS);
  return attempt();
}

async function callModel(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  image?: ImageAttachment
): Promise<{ reply: string; sources: Source[] } | { error: string; status: number }> {
  let upstream: Response;
  try {
    const lastIndex = messages.length - 1;
    upstream = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          tools: [{ google_search: {} }],
          contents: messages.map((m, i) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts:
              image && i === lastIndex
                ? [{ text: m.content }, { inline_data: { mime_type: image.mimeType, data: image.data } }]
                : [{ text: m.content }],
          })),
        }),
      }
    );
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return { error: timedOut ? "timed out" : "network error", status: 504 };
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return { error: `(${upstream.status}) ${errText}`, status: upstream.status };
  }

  const data = await upstream.json();
  const candidate = data.candidates?.[0];
  const reply: string | undefined = candidate?.content?.parts
    ?.map((p: { text?: string }) => p.text || "")
    .join("");

  if (!reply) {
    return { error: "no reply in response", status: 502 };
  }

  const chunks: { web?: { uri?: string; title?: string } }[] = candidate?.groundingMetadata?.groundingChunks ?? [];
  const sources: Source[] = chunks
    .filter((c) => c.web?.uri)
    .map((c) => ({ title: c.web!.title || c.web!.uri!, uri: c.web!.uri! }));

  return { reply, sources };
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  image?: ImageAttachment
): Promise<{ reply: string; sources: Source[] } | { error: string; status: number }> {
  let upstream: Response;
  try {
    const lastIndex = messages.length - 1;
    upstream = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
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
    }, OPENROUTER_TIMEOUT_MS);
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
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
  return { reply, sources: [] };
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

  const errors: { model: string; status: number; message: string }[] = [];
  for (const model of modelsToTry) {
    const result = await withShortRetry(() => callModel(apiKey, model, messages, image));
    if ("reply" in result) {
      return NextResponse.json({ reply: result.reply, model, sources: result.sources });
    }
    errors.push({ model, status: result.status, message: result.error });
    // Only retry with a different model on transient upstream failures, not our own bugs.
    if (!TRANSIENT_STATUSES.has(result.status)) {
      break;
    }
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    // gemma-4-31b-it's image_url field only accepts actual images, not a PDF —
    // only forward the attachment here when it really is one.
    const forwardableImage = image?.mimeType.startsWith("image/") ? image : undefined;

    // If there's a forwardable image, try vision-capable fallbacks first so
    // it still gets answered instead of silently ignored by a text-only model.
    const orderedFallbacks = forwardableImage
      ? [...OPENROUTER_FALLBACK_MODELS].sort((a, b) => Number(b.supportsVision) - Number(a.supportsVision))
      : OPENROUTER_FALLBACK_MODELS;

    for (const { model, supportsVision } of orderedFallbacks) {
      const result = await withShortRetry(() =>
        callOpenRouter(openRouterKey, model, messages, supportsVision ? forwardableImage : undefined)
      );
      if ("reply" in result) {
        return NextResponse.json({ reply: result.reply, model, sources: result.sources });
      }
      errors.push({ model, status: result.status, message: result.error });
      if (!TRANSIENT_STATUSES.has(result.status)) {
        break;
      }
    }
  }

  const detail = errors.map((e) => `${e.model}: ${e.message}`).join("\n");
  console.error(`Kimi chat: all models failed —\n${detail}`);

  // Show which models were actually tried (both tiers) so it's visible that
  // the OpenRouter fallback did run, not just a vague "try again later" —
  // but without dumping the raw provider error JSON into the chat.
  const triedList = errors.map((e) => e.model).join(", ");
  const friendlyMessage = errors.every((e) => TRANSIENT_STATUSES.has(e.status))
    ? `Kimi is temporarily at capacity (free-tier usage limits). Tried: ${triedList}. Please try again in a few minutes.`
    : `All models are currently unavailable. Tried:\n${detail}`;

  return NextResponse.json({ error: friendlyMessage }, { status: 502 });
}
