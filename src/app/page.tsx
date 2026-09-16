"use client";

import { isValidElement, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LOGO_OPTIONS, LogoId, DEFAULT_LOGO, LOGO_STORAGE_KEY, LogoImage, playClickSound } from "@/components/kimi-ui";
import { ChatSidebar, MenuIcon, type ChatSummary } from "@/components/chat-sidebar";
import { MindMap, parseMindMap } from "@/components/mind-map";
import { createClient } from "@/lib/supabase/client";

type SourceLink = { title: string; uri: string };

type Message = {
  role: "user" | "assistant";
  content: string;
  model?: string;
  time?: string;
  attachmentName?: string;
  attachmentUsed?: boolean;
  sources?: SourceLink[];
};

type Attachment = {
  name: string;
  mimeType: string;
  dataUrl: string; // full "data:<mime>;base64,<data>" string
};

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ACCEPTED_ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
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

// Sending raw Markdown to the TTS model makes it read out "asterisk asterisk"
// and table pipes, and pads out synthesis time on syntax it shouldn't voice.
// Strip formatting down to plain, speakable text first.
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\|?[\s:|-]+\|?$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
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
function TableRenderer({ node, children }: { node?: HastNode; children?: React.ReactNode }) {
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
}

// A "create a mind map" reply comes back as a fenced ```mindmap code block
// containing JSON (see the system prompt) rather than the model drawing its
// own ASCII-art boxes, which never aligned reliably. `accent` ties the
// diagram's colors to the same per-message domain color used elsewhere.
function getMdComponents(accent: string) {
  return {
    table: TableRenderer,
    code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
      const lang = /language-(\w+)/.exec(className || "")?.[1];
      if (lang === "mindmap") {
        const raw = (Array.isArray(children) ? children.join("") : String(children ?? "")).replace(/\n$/, "");
        const data = parseMindMap(raw);
        if (data) return <MindMap data={data} accent={accent} />;
      }
      return <code className={className}>{children}</code>;
    },
    pre: ({ children }: { children?: React.ReactNode }) => {
      const child = Array.isArray(children) ? children[0] : children;
      if (isValidElement(child) && child.type === MindMap) return <>{children}</>;
      return <pre>{children}</pre>;
    },
  };
}

function BookmarkIcon({ filled, color }: { filled: boolean; color: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill={filled ? color : "none"} stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V20l-6-4-6 4V4.5Z" />
    </svg>
  );
}

type ThemeMode = "system" | "light" | "dark";
const THEME_STORAGE_KEY = "kimi-theme";
const THEME_CYCLE: ThemeMode[] = ["system", "light", "dark"];

function LogoPickerModal({
  current,
  onSelect,
  onClose,
}: {
  current: LogoId;
  onSelect: (logo: LogoId) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl p-5 w-full max-w-sm flex flex-col gap-4"
        style={{ background: "var(--paper-0)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold font-display text-lg">Choose Kimi&apos;s look</h2>
        <div className="grid grid-cols-2 gap-3">
          {LOGO_OPTIONS.map((logo) => (
            <button
              key={logo}
              type="button"
              onClick={() => {
                playClickSound();
                onSelect(logo);
              }}
              className="pop-btn rounded-xl p-2 flex items-center justify-center"
              style={{
                background: "var(--paper-0)",
                boxShadow:
                  logo === current
                    ? "0 0 0 3px var(--user-pink), 0 3px 0 var(--ink-300), 0 4px 6px rgba(0,0,0,0.08)"
                    : "0 3px 0 var(--ink-300), 0 4px 6px rgba(0,0,0,0.08)",
              }}
            >
              <Image src={`/${logo}.png`} alt={logo} width={80} height={80} className="rounded-lg object-cover" style={{ width: "100%", height: "auto" }} />
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            playClickSound();
            onClose();
          }}
          className="pop-btn pop-btn-subtle rounded-full px-4 py-2 text-sm font-medium self-end"
        >
          Close
        </button>
      </div>
    </div>
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

function SpinnerIcon() {
  return (
    <svg className="spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: "2px" }}>
      <path d="M18 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function isYouTube(uri: string): boolean {
  return /youtube\.com|youtu\.be/i.test(uri);
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

function SunIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4.5" />
      <line x1="12" y1="2" x2="12" y2="4.5" />
      <line x1="12" y1="19.5" x2="12" y2="22" />
      <line x1="2" y1="12" x2="4.5" y2="12" />
      <line x1="19.5" y1="12" x2="22" y2="12" />
      <line x1="4.9" y1="4.9" x2="6.6" y2="6.6" />
      <line x1="17.4" y1="17.4" x2="19.1" y2="19.1" />
      <line x1="4.9" y1="19.1" x2="6.6" y2="17.4" />
      <line x1="17.4" y1="6.6" x2="19.1" y2="4.9" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

// label is the button text; prompt is what's actually sent as the next user
// turn (with the full conversation still in context, so "your previous
// answer" resolves correctly). They're the same for the short ones, but
// "References" needs a more specific instruction than its one-word label to
// reliably get a properly formatted, non-fabricated bibliography back.
const FOLLOW_UPS: { label: string; prompt: string }[] = [
  { label: "Summarize key points", prompt: "Summarize key points" },
  { label: "Explain with examples and scenarios", prompt: "Explain with examples and scenarios" },
  { label: "Create a mind map", prompt: "Create a mind map" },
  { label: "Apply a suitable nursing theory", prompt: "Apply a suitable nursing theory" },
  {
    label: "References",
    prompt:
      "List the references and sources behind your previous answer, formatted as a bibliography. For each one, note the source type (journal article, textbook, clinical/practice guideline, reputable website, or video) and give a working link or full citation wherever you actually have one — do not invent a citation, link, or detail you're not confident is real; say plainly where you don't have a verifiable source for a claim.",
  },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeNow() {
  return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const WELCOME_MESSAGE: Message = {
  role: "assistant",
  content:
    "Ask me anything about nursing, anatomy & physiology, psychiatry and mental health, nursing education and administration, advanced practice, or PhD-level research support. This is for education and research — not a substitute for a licensed clinician.",
};

export default function Home() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [ttsLoadingIndex, setTtsLoadingIndex] = useState<number | null>(null);
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedLogo, setSelectedLogo] = useState<LogoId>(DEFAULT_LOGO);
  const [showLogoPicker, setShowLogoPicker] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const bottomRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Read the saved logo preference after mount, not during initial render —
  // localStorage isn't available server-side, and reading it during the
  // first render would make the server and client HTML disagree (the same
  // class of hydration-mismatch bug hit earlier with message timestamps).
  useEffect(() => {
    const saved = localStorage.getItem(LOGO_STORAGE_KEY);
    if (saved && (LOGO_OPTIONS as readonly string[]).includes(saved)) {
      // One-time sync from an external store (localStorage) on mount — the
      // deliberate exception to "don't setState in an effect": doing this
      // via lazy useState init would run on the server too, where
      // localStorage doesn't exist.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedLogo(saved as LogoId);
    }

    // The blocking inline script in layout.tsx already applied a saved
    // light/dark choice to the DOM before paint (avoiding a theme flash) —
    // this just syncs this button's own displayed state to match it.
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null));
    loadChats();
  }, []);

  function selectLogo(logo: LogoId) {
    setSelectedLogo(logo);
    localStorage.setItem(LOGO_STORAGE_KEY, logo);
    setShowLogoPicker(false);
  }

  function cycleTheme() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
    setTheme(next);
    if (next === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
      document.documentElement.removeAttribute("data-theme");
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, next);
      document.documentElement.setAttribute("data-theme", next);
    }
  }

  async function loadChats() {
    const supabase = createClient();
    const { data } = await supabase.from("chats").select("id,title").order("updated_at", { ascending: false });
    if (data) setChats(data);
  }

  async function loadChat(chatId: string) {
    const supabase = createClient();
    const { data } = await supabase
      .from("messages")
      .select("role,content,model,sources,attachment_name,attachment_used,created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });

    setMessages(
      data && data.length > 0
        ? data.map((m) => ({
            role: m.role,
            content: m.content,
            model: m.model ?? undefined,
            sources: m.sources ?? undefined,
            attachmentName: m.attachment_name ?? undefined,
            attachmentUsed: m.attachment_used ?? undefined,
            time: formatTime(m.created_at),
          }))
        : [WELCOME_MESSAGE]
    );
    setCurrentChatId(chatId);
    setSidebarOpen(false);
    setError(null);
  }

  function startNewChat() {
    setMessages([WELCOME_MESSAGE]);
    setCurrentChatId(null);
    setSidebarOpen(false);
    setError(null);
  }

  async function deleteChat(chatId: string) {
    const supabase = createClient();
    setChats((prev) => prev.filter((c) => c.id !== chatId));
    if (chatId === currentChatId) startNewChat();
    await supabase.from("chats").delete().eq("id", chatId);
  }

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  // Creates the chat row on the first message of a new conversation, or
  // returns the existing one. Persistence failures are logged, not
  // surfaced — the DB schema may not be set up yet, and that shouldn't
  // block someone from actually getting an answer to their question.
  async function ensureChatId(firstMessageText: string): Promise<string | null> {
    if (currentChatId) return currentChatId;
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;

      const title = firstMessageText.length > 60 ? firstMessageText.slice(0, 60) + "…" : firstMessageText;
      const { data, error } = await supabase.from("chats").insert({ user_id: user.id, title }).select("id").single();
      if (error || !data) throw error;

      setCurrentChatId(data.id);
      setChats((prev) => [{ id: data.id, title }, ...prev]);
      return data.id;
    } catch (err) {
      console.error("Could not create chat (has supabase/schema.sql been run yet?):", err);
      return null;
    }
  }

  async function persistMessage(chatId: string | null, message: Message) {
    if (!chatId) return;
    try {
      const supabase = createClient();
      await supabase.from("messages").insert({
        chat_id: chatId,
        role: message.role,
        content: message.content,
        model: message.model ?? null,
        sources: message.sources ?? null,
        attachment_name: message.attachmentName ?? null,
        attachment_used: message.attachmentUsed ?? null,
      });
    } catch (err) {
      console.error("Could not save message:", err);
    }
  }

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

    const chatId = await ensureChatId(text);
    if (!currentAttachment) persistMessage(chatId, userMessage);

    try {
      let imagePayload: { mimeType: string; data: string } | undefined;

      if (currentAttachment) {
        const base64 = currentAttachment.dataUrl.split(",")[1] ?? "";
        let relevant = true; // fail open if the relevance check itself fails (or is skipped)

        // The reranker is documented for document IMAGES specifically — a PDF
        // isn't a valid input for its "image" field, so skip the relevance
        // check for PDFs and just send them straight through.
        if (currentAttachment.mimeType.startsWith("image/")) {
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
        }

        userMessage.attachmentUsed = relevant;
        setMessages([...nextMessages]);
        persistMessage(chatId, userMessage);

        if (relevant) {
          imagePayload = { mimeType: currentAttachment.mimeType, data: base64 };
        } else {
          setAttachmentNotice(
            `"${currentAttachment.name}" didn't look relevant to that question, so it wasn't sent to the model.`
          );
        }
      }

      const chatBody = JSON.stringify({ messages: nextMessages, image: imagePayload });
      const requestChat = () =>
        fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chatBody,
        });

      let res: Response;
      try {
        res = await requestChat();
      } catch {
        // network-level failure (e.g. connection dropped) — one retry after a short pause
        setRetrying(true);
        await sleep(3000);
        setRetrying(false);
        res = await requestChat();
      }

      if (res.status === 502) {
        // every fallback model failed once — give the whole chain one more
        // pass after a short pause instead of giving up immediately, since
        // a transient overload often clears within a few seconds.
        setRetrying(true);
        await sleep(3000);
        res = await requestChat();
        setRetrying(false);
      }

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong.");
      }

      const assistantMessage: Message = {
        role: "assistant",
        content: data.reply,
        model: data.model,
        time: timeNow(),
        sources: data.sources,
      };
      setMessages([...nextMessages, assistantMessage]);
      persistMessage(chatId, assistantMessage);
      loadChats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
      setRetrying(false);
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
    if (!ACCEPTED_ATTACHMENT_TYPES.includes(file.type)) {
      setUploadError("Please choose an image (PNG, JPEG, or WebP) or a PDF.");
      setPendingFile(null);
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
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
    if (ttsLoadingIndex !== null) return; // already generating one

    setTtsLoadingIndex(index);
    try {
      // Register the text and get back an id — the actual audio is generated
      // by GET /api/tts/[id], which the <audio> element below streams from
      // directly. That lets the browser start playing as bytes arrive
      // instead of waiting for a full fetch()+blob() download first.
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: stripMarkdownForSpeech(text) }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not generate audio.");
      }

      const audio = new Audio(`/api/tts/${data.id}`);
      audioRef.current = audio;
      // Flip to "speaking" only once playback actually starts, not on click
      // or on play() resolving — otherwise the button reads "Stop" while
      // the stream is still buffering, before any sound has played.
      audio.onplaying = () => {
        setTtsLoadingIndex(null);
        setSpeakingIndex(index);
      };
      audio.onended = () => setSpeakingIndex(null);
      audio.onerror = () => {
        setError("Could not generate audio.");
        setSpeakingIndex(null);
        setTtsLoadingIndex(null);
      };
      await audio.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate audio.");
      setTtsLoadingIndex(null);
    }
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <ChatSidebar
        chats={chats}
        currentChatId={currentChatId}
        onSelectChat={loadChat}
        onNewChat={startNewChat}
        onDeleteChat={deleteChat}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        userEmail={userEmail}
        onLogout={handleLogout}
      />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
    <div className="flex flex-col flex-1 max-w-2xl w-full mx-auto p-4 overflow-hidden">
      <header className="py-4 border-b border-ink-300 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => {
              playClickSound();
              setSidebarOpen(true);
            }}
            aria-label="Open chat history"
            className="pop-btn pop-btn-subtle w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-ink-600 hover:text-foreground sm:hidden mt-0.5"
          >
            <MenuIcon />
          </button>
          <div>
          <h1 className="text-xl font-semibold font-display flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                playClickSound();
                setShowLogoPicker(true);
              }}
              aria-label="Change Kimi's logo"
              className="pop-btn rounded-full"
            >
              <LogoImage logo={selectedLogo} size={32} />
            </button>
            Kimi
          </h1>
          <p className="text-sm text-ink-600">Nursing, medicine &amp; mental health research assistant</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            playClickSound();
            cycleTheme();
          }}
          aria-label={`Theme: ${theme}. Click to change.`}
          title={`Theme: ${theme}`}
          className="pop-btn pop-btn-subtle w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-ink-600 hover:text-foreground"
        >
          {theme === "light" ? <SunIcon /> : theme === "dark" ? <MoonIcon /> : <SystemIcon />}
        </button>
      </header>

      {showLogoPicker && (
        <LogoPickerModal current={selectedLogo} onSelect={selectLogo} onClose={() => setShowLogoPicker(false)} />
      )}

      <div className="flex-1 overflow-y-auto py-4 space-y-6">
        {messages.map((m, i) => {
          if (m.role === "user") {
            return (
              <div key={i} className="flex flex-col items-end gap-1">
                <div
                  className="max-w-[80%] rounded-2xl px-4 py-2 whitespace-pre-wrap text-sm text-white"
                  style={{ background: "var(--user-pink)" }}
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
          // Mind maps need a real accent even with no detected domain — the
          // grey domainColor fallback is exactly the "greyed-out, disabled"
          // look the diagram redesign was meant to get away from.
          const diagramAccent = domain === "psych" ? "var(--psych-700)" : domain === "physio" ? "var(--physio-700)" : "var(--info-700)";
          const mdComponents = getMdComponents(diagramAccent);
          const { intro, sections } = parseAnswerSections(m.content);

          return (
            <div key={i} className="flex flex-col gap-3 max-w-[92%]">
              <div className="flex items-center gap-2">
                <LogoImage logo={selectedLogo} size={28} />
                <span className="text-xs font-semibold">Kimi</span>
                {m.time && <span className="text-xs text-ink-600">{m.time}</span>}
                <button
                  type="button"
                  onClick={() => {
                    playClickSound();
                    toggleSaved(i);
                  }}
                  aria-label="Save snippet"
                  className="pop-btn pop-btn-subtle ml-auto w-8 h-8 rounded-full flex items-center justify-center"
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
                // Expanded by default — "###" sections are meant for genuinely
                // skippable extras, but the model doesn't always honor that
                // distinction (it sometimes reaches for "###" just to nest a
                // topic's sub-parts), and a reader shouldn't have to click
                // through several accordions to get a complete answer. Still
                // collapsible per-section for whoever wants to hide one after
                // reading it.
                <details key={si} className="answer-section" open>
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

              {m.sources && m.sources.length > 0 && (
                <div className="flex flex-col gap-1.5 pt-1 border-t border-ink-300">
                  <p className="text-xs font-semibold text-ink-600 pt-2">Sources</p>
                  <ul className="flex flex-col gap-1">
                    {m.sources.map((s, si) => (
                      <li key={si} className="flex items-start gap-1.5 text-xs">
                        <LinkIcon />
                        <a
                          href={s.uri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline break-all"
                          style={{ color: domainColor }}
                        >
                          {s.title}
                          {isYouTube(s.uri) && " (YouTube)"}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    playClickSound();
                    speak(i, m.content);
                  }}
                  disabled={ttsLoadingIndex !== null && ttsLoadingIndex !== i}
                  className="pop-btn pop-btn-subtle flex items-center gap-1.5 text-xs text-ink-600 hover:text-foreground disabled:opacity-40 rounded-full px-3 py-1.5"
                >
                  {ttsLoadingIndex === i ? <SpinnerIcon /> : speakingIndex === i ? <StopIcon /> : <SpeakerIcon />}
                  {ttsLoadingIndex === i ? "Generating…" : speakingIndex === i ? "Stop" : "Listen"}
                </button>
                {m.model && <p className="text-xs text-ink-600">via {m.model}</p>}
              </div>

              <div className="flex gap-2 flex-wrap">
                {FOLLOW_UPS.map((f) => (
                  <button
                    key={f.label}
                    type="button"
                    onClick={() => {
                      playClickSound();
                      postMessage(f.prompt);
                    }}
                    disabled={loading}
                    className="pop-btn rounded-full px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-40"
                    style={{ background: domainColor, boxShadow: "0 4px 0 rgba(0,0,0,0.25), 0 5px 8px rgba(0,0,0,0.15)" }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {loading && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl px-4 py-2 text-sm bg-black/5 dark:bg-white/10 text-ink-600 flex items-center gap-2">
              {retrying && <SpinnerIcon />}
              {retrying ? "The AI service is busy — retrying…" : "Thinking…"}
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
            onClick={() => {
              playClickSound();
              openUploadModal();
            }}
            disabled={loading}
            aria-label="Attach a document"
            className="pop-btn pop-btn-subtle w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-ink-600 hover:text-foreground disabled:opacity-40"
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
            onClick={() => playClickSound()}
            disabled={loading || !input.trim()}
            className="pop-btn rounded-full text-white px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ background: "var(--user-pink)", boxShadow: "0 4px 0 var(--user-pink-dark), 0 5px 8px rgba(0,0,0,0.15)" }}
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
            <h2 className="font-semibold font-display text-lg">Attach a document</h2>

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
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              onChange={(e) => handleFileChosen(e.target.files?.[0])}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => {
                playClickSound();
                fileInputRef.current?.click();
              }}
              className="pop-btn pop-btn-subtle rounded-xl px-4 py-4 text-sm font-medium flex flex-col items-center justify-center gap-2 text-ink-600 hover:text-foreground"
            >
              <PaperclipIcon size={20} />
              {pendingFile ? pendingFile.name : "Choose an image or PDF"}
            </button>
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
                onClick={() => {
                  playClickSound();
                  setShowUploadModal(false);
                }}
                className="pop-btn pop-btn-subtle rounded-full px-4 py-2 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  playClickSound();
                  confirmAttachment();
                }}
                disabled={!pendingFile || !ackChecked}
                className="pop-btn rounded-full text-white px-4 py-2 text-sm font-medium disabled:opacity-40"
                style={{ background: "var(--info-700)", boxShadow: "0 4px 0 #274a63, 0 5px 8px rgba(0,0,0,0.15)" }}
              >
                Attach
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
      </div>
    </div>
  );
}
