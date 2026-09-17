"use client";

// A single chat row's delete flow: confirm -> the row crumbles into paper
// fragments -> a stick-figure worker sweeps them into a dustpan and kicks in
// the stray piece -> the row settles into a slim "Chat deleted / Undo" bar.
// The real delete only fires after the undo window passes, so nothing is
// ever reported as deleted before Supabase actually confirms it.

import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "crumble" | "sweep" | "pending" | "committing" | "restoring" | "error";

const CRUMBLE_MS = 260;
const SWEEP_MS = 480;
const SETTLE_MS = 200;
const UNDO_WINDOW_MS = 4500;
const RESTORE_MS = 380;

let sweepAudioCtx: AudioContext | null = null;

function playTone(freqFrom: number, freqTo: number, duration: number) {
  try {
    if (!sweepAudioCtx) sweepAudioCtx = new AudioContext();
    const ctx = sweepAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freqFrom, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freqTo, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
  } catch {
    // sound is a nice-to-have; never let it break the delete flow
  }
}

const playSweepSound = () => playTone(560, 200, 0.22);
const playRestoreSound = () => playTone(240, 620, 0.18);

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => (typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false));
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function DustpanIcon({ full, style, className }: { full?: boolean; style?: React.CSSProperties; className?: string }) {
  return (
    <svg width="16" height="14" viewBox="0 0 20 16" fill="none" className={`shrink-0 text-ink-600 ${className ?? ""}`} style={style} aria-hidden="true">
      <path d="M2 2 L18 2 L14 12 Q13 14 11 14 L9 14 Q7 14 6 12 Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <line x1="10" y1="14" x2="10" y2="16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {full && (
        <>
          <circle cx="9" cy="8" r="1" fill="currentColor" />
          <circle cx="11.5" cy="9" r="0.8" fill="currentColor" />
          <circle cx="9.5" cy="10" r="0.7" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

// A minimal line worker: head, torso, legs (one kicks), and an arm swinging
// a broom. Kept abstract/geometric so it reads clearly at ~30px tall.
function WorkerSvg({ reverse, durationMs }: { reverse?: boolean; durationMs: number }) {
  return (
    <svg
      viewBox="0 0 60 40"
      width="46"
      height="30"
      className={`dd-worker ${reverse ? "dd-worker-reverse" : ""}`}
      style={{ animationDuration: `${durationMs}ms` }}
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" className="text-ink-900">
        <circle cx="30" cy="8" r="4" fill="currentColor" stroke="none" />
        <line x1="30" y1="12" x2="28" y2="24" />
        <line x1="28" y1="24" x2="22" y2="34" />
        <g className="dd-worker-leg" style={{ transformOrigin: "28px 24px" }}>
          <line x1="28" y1="24" x2="34" y2="33" />
        </g>
        <line x1="28" y1="16" x2="22" y2="14" />
        <g className="dd-worker-arm" style={{ transformOrigin: "28px 16px" }}>
          <line x1="28" y1="16" x2="40" y2="10" />
          <line x1="40" y1="10" x2="50" y2="24" />
          <line x1="46" y1="20" x2="54" y2="28" />
          <line x1="48" y1="22" x2="55" y2="24" />
          <line x1="50" y1="24" x2="53" y2="20" />
        </g>
      </g>
    </svg>
  );
}

const FRAGMENTS = [
  { left: "16%", top: "28%", rot: -18, delay: 0 },
  { left: "32%", top: "60%", rot: 12, delay: 40 },
  { left: "46%", top: "20%", rot: 24, delay: 90 },
  { left: "58%", top: "56%", rot: -10, delay: 60 },
  { left: "40%", top: "42%", rot: 6, delay: 0 }, // the stray piece the worker kicks in last
];
const STRAY_INDEX = FRAGMENTS.length - 1;

export function DeleteSweepRow({
  title,
  isCurrent,
  armed,
  onSelect,
  onRequestDelete,
  onCommitDelete,
  onSettle,
}: {
  title: string;
  isCurrent: boolean;
  armed: boolean;
  onSelect: () => void;
  onRequestDelete: () => void;
  onCommitDelete: () => Promise<boolean>;
  onSettle: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [announcement, setAnnouncement] = useState("");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const undoRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const commit = useCallback(async () => {
    clearTimers();
    setPhase("committing");
    const ok = await onCommitDelete();
    if (!ok) {
      setPhase("error");
      setAnnouncement(`Couldn't delete ${title}. Try again.`);
      onSettle();
    }
    // on success the parent removes this chat from its list, which unmounts this row
  }, [clearTimers, onCommitDelete, onSettle, title]);

  useEffect(() => {
    if (!armed || phase !== "idle") return;
    playSweepSound();

    if (reducedMotion) {
      schedule(() => {
        setPhase("pending");
        setAnnouncement(`${title} deleted. Press Undo to restore.`);
        schedule(commit, UNDO_WINDOW_MS);
      }, 0);
      return;
    }

    schedule(() => setPhase("crumble"), 0);
    schedule(() => setPhase("sweep"), CRUMBLE_MS);
    schedule(() => {
      setPhase("pending");
      setAnnouncement(`${title} deleted. Press Undo to restore.`);
      schedule(commit, UNDO_WINDOW_MS);
    }, CRUMBLE_MS + SWEEP_MS + SETTLE_MS);
    // Only the arming edge should kick this off; commit/schedule are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, reducedMotion, title]);

  useEffect(() => {
    if (phase === "pending") undoRef.current?.focus();
  }, [phase]);

  function handleUndo() {
    clearTimers();
    playRestoreSound();
    setAnnouncement(`Deletion of ${title} undone.`);
    if (reducedMotion) {
      setPhase("idle");
      onSettle();
      return;
    }
    setPhase("restoring");
    schedule(() => {
      setPhase("idle");
      onSettle();
    }, RESTORE_MS);
  }

  const showOverlay = !reducedMotion && (phase === "crumble" || phase === "sweep" || phase === "restoring");

  return (
    <div className="relative">
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>

      <div
        className={`relative flex items-center gap-1 rounded-xl px-3 py-2.5 min-h-11 overflow-hidden ${
          phase === "idle" ? "group cursor-pointer hover:bg-black/5" : ""
        }`}
        style={isCurrent && phase === "idle" ? { background: "var(--psych-100)" } : undefined}
        onClick={phase === "idle" ? onSelect : undefined}
      >
        {phase === "idle" && (
          <>
            <span className="flex-1 text-sm truncate">{title}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRequestDelete();
              }}
              aria-label={`Delete ${title}`}
              className="pop-btn opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 p-1.5 rounded-md hover:bg-black/10 shrink-0 text-ink-600"
            >
              <TrashIcon />
            </button>
          </>
        )}

        {(phase === "crumble" || phase === "sweep") && <span className="flex-1 text-sm truncate opacity-0">{title}</span>}

        {phase === "restoring" && <span className="flex-1 text-sm truncate">{title}</span>}

        {(phase === "pending" || phase === "committing") && (
          <>
            <DustpanIcon full />
            <span className="flex-1 text-sm text-ink-600">{phase === "committing" ? "Deleting…" : "Chat deleted"}</span>
            <button
              ref={undoRef}
              type="button"
              disabled={phase === "committing"}
              onClick={(e) => {
                e.stopPropagation();
                handleUndo();
              }}
              className="pop-btn pop-btn-subtle rounded-full px-3 py-1.5 text-xs font-medium shrink-0"
            >
              Undo
            </button>
            {phase === "pending" && !reducedMotion && (
              <span
                className="dd-drain absolute left-0 bottom-0 h-0.5 rounded-full"
                style={{ background: "var(--user-pink)", animationDuration: `${UNDO_WINDOW_MS}ms` }}
              />
            )}
          </>
        )}

        {phase === "error" && (
          <>
            <span className="flex-1 text-xs" style={{ color: "var(--alert-700)" }}>
              Couldn&apos;t delete — try again
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                commit();
              }}
              className="pop-btn pop-btn-subtle rounded-full px-2.5 py-1 text-xs font-medium shrink-0"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setPhase("idle");
              }}
              aria-label="Dismiss"
              className="p-1.5 rounded-md hover:bg-black/10 shrink-0 text-ink-600"
            >
              <CloseIcon />
            </button>
          </>
        )}
      </div>

      {showOverlay && (
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
          {FRAGMENTS.map((f, i) => {
            const isStray = i === STRAY_INDEX;
            const animClass =
              phase === "sweep" ? (isStray ? "dd-fragment-kick" : "dd-fragment-sweep") : phase === "restoring" ? "dd-fragment-restore" : "dd-fragment-crumble";
            return (
              <span
                key={i}
                className={`dd-fragment ${animClass}`}
                style={
                  {
                    left: f.left,
                    top: f.top,
                    animationDelay: phase === "sweep" && isStray ? `${SWEEP_MS * 0.55}ms` : `${f.delay}ms`,
                    "--dd-rot": `${f.rot}deg`,
                  } as React.CSSProperties
                }
              />
            );
          })}
          {(phase === "sweep" || phase === "restoring") && <WorkerSvg reverse={phase === "restoring"} durationMs={phase === "restoring" ? RESTORE_MS : SWEEP_MS} />}
          {(phase === "sweep" || phase === "restoring") && <DustpanIcon className="absolute" style={{ right: "4%", top: "20%" }} />}
        </div>
      )}
    </div>
  );
}
