# MotoQ — Motorcycle Chatbot

A minimal full-stack chatbot, built to learn how LLM integration actually works: React UI → your own backend → an LLM provider (Google Gemini).

## How it's wired together

```
Browser (React)  --fetch-->  Next.js API route  --fetch-->  Gemini API (generateContent)
src/app/page.tsx             src/app/api/chat/route.ts
```

- **`src/app/page.tsx`** — the chat UI. Plain React state (`useState`) holds the message list; on submit it `fetch`es your own `/api/chat` endpoint. No LLM knowledge lives here.
- **`src/app/api/chat/route.ts`** — the backend. This is the *only* place the Gemini API key is read (`process.env.GEMINI_API_KEY`), because this code runs on the server, never in the browser. It prepends a system prompt that scopes the bot to motorcycle topics, converts the message history into Gemini's request shape, and returns just the reply text to the browser.
- **`.env.local`** — holds the API key and the model id. Already excluded from git via `.gitignore` (`.env*` is ignored).

This split — key on the server, UI in the browser — is the pattern you'll use for basically any LLM-backed app. A key shipped to the browser is visible to anyone via dev tools, so it can never live in client-side React code.

### Gemini's request shape (different from most other providers)

Most LLM APIs (OpenAI, OpenRouter, etc.) use a flat `messages: [{role, content}]` array. Gemini's `generateContent` endpoint is shaped differently:

- The system prompt goes in a separate `systemInstruction` field, not as a message.
- Assistant turns use `role: "model"`, not `"assistant"`.
- Each turn's text lives in a `parts: [{ text }]` array instead of a plain `content` string.

`route.ts` does this conversion in `callModel()`. If you ever swap providers again, this is the part that would need to change — the React UI wouldn't need to change at all, since it only talks to your own `/api/chat` endpoint.

## Running it

```bash
npm run dev
```

Then open http://localhost:3000.

## Changing the model

The default model is `gemini-3.6-flash`. Google renames/deprecates model ids over time (e.g. `gemini-2.5-flash` was retired for new API keys) — check https://ai.google.dev/gemini-api/docs/models for current ones if something stops working. Swap `GEMINI_MODEL` in `.env.local` to try a different one.

Flash models can occasionally return a transient `503` under high demand. To handle that, `route.ts` tries your configured model first, then automatically falls back through `FALLBACK_MODELS` until one responds — the response includes which `model` actually answered, so the UI shows "via gemini-x" under each reply, letting you see when a fallback kicked in.

Restart `npm run dev` after changing `.env.local` (Next.js reads it at server start).

## Tuning the bot's behavior

The system prompt lives in `SYSTEM_PROMPT` at the top of `src/app/api/chat/route.ts`. Edit it to change tone, add stricter refusal behavior for off-topic questions, or expand what it's allowed to discuss.

## Ideas to extend this as you learn

- **Streaming responses** — Gemini supports a `streamGenerateContent` endpoint; piping that back to the browser would make replies appear incrementally instead of all at once.
- **Conversation memory limits** — right now the full message history is sent every request; real apps trim/summarize old messages to control cost and context length.
- **Structured motorcycle data** — hook the bot up to a real spec database or API so it can answer with verified facts instead of relying on the model's training data.
- **Rate limiting / abuse protection** — since your key is billed per request past the free tier, add basic request limits before deploying this publicly.
# learn
