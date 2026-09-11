"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Message = {
  role: "user" | "assistant";
  content: string;
  model?: string;
  time?: string;
  attachmentName?: string;
  attachmentUsed?: boolean;
};

type Attachment = {
  name: string;
  mimeType: string;
  dataUrl: string; // full "data:<mime>;base64,<data>" string
};

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// Cross-encoder relevance scores from this reranker run roughly 0-1; below
// this, the attached image is treated as unrelated to the question and
// isn't sent to the vision model. Rough heuristic, not calibrated against
// real usage data — worth revisiting once there's real traffic to tune on.
const RELEVANCE_THRESHOLD = 0.25;

type Domain = "physio" | "psych" | null;

const PSYCH_KEYWORDS = [
  "psychiat", "anxiety", "depress", "mental health", "mood", "therapy",
  "ssri", "snri", "antidepressant", "antipsychotic", "bipolar", "schizo",
  "trauma", "ptsd", "cognitive behavioral", "neurobiolog", "amygdala",
  "serotonin", "dopamine", "counsel",
];
const PHYSIO_KEYWORDS = [
  "physiolog", "anatomy", "heart", "cardiac", "muscle", "nervous system",
  "hormone", "kidney", "renal", "respirat", "blood pressure", "vital sign",
  "cell", "organ", "gastrointestinal", "endocrine", "skeletal", "pulmonary",
];

function detectDomain(text: string): Domain {
  const lower = text.toLowerCase();
  const count = (words: string[]) => words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
  const psych = count(PSYCH_KEYWORDS);
  const physio = count(PHYSIO_KEYWORDS);
  if (psych === 0 && physio === 0) return null;
  return psych >= physio ? "psych" : "physio";
}

// Models occasionally slip in a raw "<br>" inside a table cell for a line
// break; react-markdown doesn't execute raw HTML, so it would otherwise show
// up as literal text. Swap it for a plain separator instead of rendering HTML.
function stripBr(text: string): string {
  return text.replace(/<br\s*\/?>/gi, "; ");
}

function parseAnswerSections(markdown: string) {
  const lines = markdown.split("\n");
  const introLines: string[] = [];
  const sections: { title: string; body: string }[] = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const h3 = line.match(/^###\s+(.*)/);
    if (h3) {
      if (current) sections.push({ title: current.title, body: current.lines.join("\n").trim() });
      current = { title: h3[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      introLines.push(line);
    }
  }
  if (current) sections.push({ title: current.title, body: current.lines.join("\n").trim() });

  return {
    intro: stripBr(introLines.join("\n").trim()),
    sections: sections.map((s) => ({ ...s, body: stripBr(s.body) })),
  };
}

type HastNode = { type: string; value?: string; tagName?: string; children?: HastNode[] };

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (node.children) return node.children.map(textOf).join("");
  return "";
}

// Markdown tables render as a real <table> on wider screens, and as stacked
// comparison cards on narrow ones — a wide data table just clips text on a
// phone, it doesn't reflow, so both layouts are rendered from the same cells.
const mdComponents = {
  table: ({ node, children }: { node?: HastNode; children?: React.ReactNode }) => {
    const headCells: string[] = [];
    const rows: string[][] = [];
    for (const child of node?.children ?? []) {
      if (child.tagName === "thead") {
        const tr = child.children?.find((c) => c.tagName === "tr");
        for (const th of tr?.children ?? []) {
          if (th.tagName === "th") headCells.push(textOf(th));
        }
      }
      if (child.tagName === "tbody") {
        for (const tr of child.children ?? []) {
          if (tr.tagName !== "tr") continue;
          rows.push((tr.children ?? []).filter((td) => td.tagName === "td").map(textOf));
        }
      }
    }

    return (
      <>
        <div className="hidden sm:block" style={{ overflowX: "auto" }}>
          <table>{children}</table>
        </div>
        <div className="sm:hidden flex flex-col gap-2">
          {rows.map((row, ri) => {
            const [title, ...rest] = row;
            return (
              <div key={ri} className="comparison-card">
                <p className="comparison-title">{title}</p>
                <div className="comparison-grid">
                  {rest.map((cell, ci) => (
                    <div key={ci}>
                      <p className="comparison-tag">{headCells[ci + 1] ?? ""}</p>
                      <p className="comparison-value">{cell}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  },
};

function DomainIcon({ domain, size = 13 }: { domain: Domain; size?: number }) {
  if (domain === "psych") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--psych-700)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7" cy="7" r="1.8" /><circle cx="17" cy="7" r="1.8" /><circle cx="12" cy="17" r="1.8" />
        <line x1="8.6" y1="7.6" x2="15.4" y2="7.6" /><line x1="7.9" y1="8.5" x2="11.1" y2="15.2" /><line x1="16.1" y1="8.5" x2="12.9" y2="15.2" />
      </svg>
    );
  }
  if (domain === "physio") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--physio-700)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12h3l2-5 3 10 2-13 2 8h3l1.5-3 1.5 3h3.5" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--ink-600)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
    </svg>
  );
}

function BookmarkIcon({ filled, color }: { filled: boolean; color: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill={filled ? color : "none"} stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V20l-6-4-6 4V4.5Z" />
    </svg>
  );
}

function LogoIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--info-700)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12h3l2-5 3 10 2-13 2 8h3l1.5-3 1.5 3h3.5" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9v6h3.2L12 19V5L7.2 9H4Z" fill="currentColor" stroke="none" />
      <path d="M16 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 6a8.5 8.5 0 0 1 0 12" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function PaperclipIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--alert-700)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <circle cx="12" cy="16.2" r="0.9" fill="var(--alert-700)" stroke="none" />
    </svg>
  );
}

const FOLLOW_UPS = ["Explain further", "Give a clinical example", "Summarize key points"];

function timeNow() {
  return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Ask me anything about nursing, anatomy & physiology, psychiatry and mental health, nursing education and administration, advanced practice, or PhD-level research support. This is for education and research — not a substitute for a licensed clinician.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function postMessage(text: string) {
    if (!text || loading) return;

    const currentAttachment = attachment;
    setAttachment(null);
    setAttachmentNotice(null);

    const userMessage: Message = {
      role: "user",
      content: text,
      time: timeNow(),
      attachmentName: currentAttachment?.name,
    };
    const nextMessages: Message[] = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setError(null);
    setLoading(true);

    try {
      let imagePayload: { mimeType: string; data: string } | undefined;

      if (currentAttachment) {
        const base64 = currentAttachment.dataUrl.split(",")[1] ?? "";
        let relevant = true; // fail open if the relevance check itself fails
        try {
          const rerankRes = await fetch("/api/rerank", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: text, image: currentAttachment.dataUrl }),
          });
          if (rerankRes.ok) {
            const rerankData = await rerankRes.json();
            if (typeof rerankData.relevanceScore === "number") {
              relevant = rerankData.relevanceScore >= RELEVANCE_THRESHOLD;
            }
          }
        } catch {
          // network hiccup on the relevance check — proceed with the image anyway
        }

        userMessage.attachmentUsed = relevant;
        setMessages([...nextMessages]);

        if (relevant) {
          imagePayload = { mimeType: currentAttachment.mimeType, data: base64 };
        } else {
          setAttachmentNotice(
            `"${currentAttachment.name}" didn't look relevant to that question, so it wasn't sent to the model.`
          );
        }
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, image: imagePayload }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong.");
      }

      setMessages([
        ...nextMessages,
        { role: "assistant", content: data.reply, model: data.model, time: timeNow() },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
    }
  }

  function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    postMessage(text);
  }

  function openUploadModal() {
    setPendingFile(null);
    setAckChecked(false);
    setUploadError(null);
    setShowUploadModal(true);
  }

  function confirmAttachment() {
    if (!pendingFile || !ackChecked) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAttachment({
        name: pendingFile.name,
        mimeType: pendingFile.type,
        dataUrl: reader.result as string,
      });
      setShowUploadModal(false);
    };
    reader.onerror = () => setUploadError("Could not read that file.");
    reader.readAsDataURL(pendingFile);
  }

  function handleFileChosen(file: File | undefined) {
    setUploadError(null);
    if (!file) {
      setPendingFile(null);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setUploadError("Please choose an image file (PNG, JPEG, or WebP).");
      setPendingFile(null);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setUploadError("That file is too large — please choose one under 4 MB.");
      setPendingFile(null);
      return;
    }
    setPendingFile(file);
  }

  function toggleSaved(index: number) {
    setSaved((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function speak(index: number, text: string) {
    if (speakingIndex === index) {
      audioRef.current?.pause();
      setSpeakingIndex(null);
      return;
    }

    setSpeakingIndex(index);
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not generate audio.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setSpeakingIndex(null);
      audio.onerror = () => setSpeakingIndex(null);
      await audio.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate audio.");
      setSpeakingIndex(null);
    }
  }

  return (
    <div className="flex flex-col flex-1 max-w-2xl w-full mx-auto p-4">
      <header className="py-4 border-b border-ink-300">
        <h1 className="text-xl font-semibold font-serif flex items-center gap-2">
          <LogoIcon /> NurseQ
        </h1>
        <p className="text-sm text-ink-600">Nursing, medicine &amp; mental health research assistant</p>
      </header>

      <div className="flex-1 overflow-y-auto py-4 space-y-6">
        {messages.map((m, i) => {
          if (m.role === "user") {
            return (
              <div key={i} className="flex flex-col items-end gap-1">
                <div
                  className="max-w-[80%] rounded-2xl px-4 py-2 whitespace-pre-wrap text-sm text-white"
                  style={{ background: "var(--info-700)" }}
                >
                  {m.content}
                </div>
                {m.attachmentName && (
                  <div className="flex items-center gap-1.5 text-xs text-ink-600 pr-1">
                    <PaperclipIcon size={12} />
                    {m.attachmentName}
                    {m.attachmentUsed === false && <span>(not used — off-topic)</span>}
                  </div>
                )}
              </div>
            );
          }

          const domain = detectDomain(m.content);
          const domainColor = domain === "psych" ? "var(--psych-700)" : domain === "physio" ? "var(--physio-700)" : "var(--ink-600)";
          const domainBg = domain === "psych" ? "var(--psych-100)" : domain === "physio" ? "var(--physio-100)" : "var(--ink-300)";
          const { intro, sections } = parseAnswerSections(m.content);

          return (
            <div key={i} className="flex flex-col gap-3 max-w-[92%]">
              <div className="flex items-center gap-2">
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                  style={{ background: domainBg }}
                >
                  <DomainIcon domain={domain} />
                </div>
                <span className="text-xs font-semibold">NurseQ</span>
                {m.time && <span className="text-xs text-ink-600">{m.time}</span>}
                <button
                  type="button"
                  onClick={() => toggleSaved(i)}
                  aria-label="Save snippet"
                  className="ml-auto p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <BookmarkIcon filled={saved.has(i)} color={domainColor} />
                </button>
              </div>

              <div className={`answer answer-intro domain-${domain ?? "none"}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {intro}
                </ReactMarkdown>
              </div>

              {sections.map((s, si) => (
                <details key={si} className="answer-section" open={si === 0}>
                  <summary>
                    <ChevronIcon className="chevron-icon" />
                    {s.title}
                  </summary>
                  <div className={`answer domain-${domain ?? "none"} pl-6 pb-3`}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                      {s.body}
                    </ReactMarkdown>
                  </div>
                </details>
              ))}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => speak(i, m.content)}
                  className="flex items-center gap-1.5 text-xs text-ink-600 hover:text-foreground"
                >
                  {speakingIndex === i ? <StopIcon /> : <SpeakerIcon />}
                  {speakingIndex === i ? "Stop" : "Listen"}
                </button>
                {m.model && <p className="text-xs text-ink-600">via {m.model}</p>}
              </div>

              <div className="flex gap-2 flex-wrap">
                {FOLLOW_UPS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => postMessage(f)}
                    disabled={loading}
                    className="rounded-full border border-ink-300 px-3 py-1.5 text-xs font-medium hover:border-current disabled:opacity-40"
                    style={{ color: domainColor }}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {loading && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl px-4 py-2 text-sm bg-black/5 dark:bg-white/10 text-ink-600">
              Thinking…
            </div>
          </div>
        )}
        {error && <div className="text-sm" style={{ color: "var(--alert-700)" }}>Error: {error}</div>}
        <div ref={bottomRef} />
      </div>

      {attachmentNotice && (
        <p className="text-xs pt-3" style={{ color: "var(--caution-700)" }}>
          {attachmentNotice}
        </p>
      )}

      <div className="border-t border-ink-300 pt-3">
        {attachment && (
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 mb-2 text-xs w-fit"
            style={{ background: "var(--info-100)", color: "var(--foreground)" }}
          >
            <PaperclipIcon size={13} />
            {attachment.name}
            <button
              type="button"
              onClick={() => setAttachment(null)}
              aria-label="Remove attachment"
              className="hover:opacity-70"
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}

        <form onSubmit={sendMessage} className="flex gap-2 py-1">
          <button
            type="button"
            onClick={openUploadModal}
            disabled={loading}
            aria-label="Attach a document image"
            className="rounded-full border border-ink-300 w-9 h-9 flex items-center justify-center shrink-0 text-ink-600 hover:text-foreground disabled:opacity-40"
          >
            <PaperclipIcon />
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. What's the difference between a nurse practitioner and a clinical nurse specialist?"
            className="flex-1 rounded-full border border-ink-300 bg-transparent px-4 py-2 text-sm outline-none focus:border-current"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-full text-white px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ background: "var(--info-700)" }}
          >
            Send
          </button>
        </form>
      </div>

      {showUploadModal && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4 z-50"
          style={{ background: "rgba(0,0,0,0.45)" }}
          onClick={() => setShowUploadModal(false)}
        >
          <div
            className="rounded-2xl p-5 w-full max-w-sm flex flex-col gap-4"
            style={{ background: "var(--paper-0)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-semibold font-serif text-lg">Attach a document image</h2>

            <div
              className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm"
              style={{ background: "var(--alert-100)", color: "var(--foreground)" }}
            >
              <WarningIcon />
              <span>
                Please do not upload any confidential information or personal data (such as voices or faces of people).
              </span>
            </div>

            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => handleFileChosen(e.target.files?.[0])}
              className="text-sm"
            />
            {uploadError && (
              <p className="text-xs" style={{ color: "var(--alert-700)" }}>{uploadError}</p>
            )}

            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={ackChecked}
                onChange={(e) => setAckChecked(e.target.checked)}
                className="mt-0.5"
              />
              I understand and won&apos;t upload confidential or personal data.
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowUploadModal(false)}
                className="rounded-full border border-ink-300 px-4 py-2 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmAttachment}
                disabled={!pendingFile || !ackChecked}
                className="rounded-full text-white px-4 py-2 text-sm font-medium disabled:opacity-40"
                style={{ background: "var(--info-700)" }}
              >
                Attach
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
