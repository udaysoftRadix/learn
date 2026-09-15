"use client";

import Image from "next/image";

// Shared branding bits used by both the main chat page and the login page,
// so both stay visually and behaviorally consistent.

export const LOGO_OPTIONS = ["logo1", "logo2", "logo3", "logo4"] as const;
export type LogoId = (typeof LOGO_OPTIONS)[number];
export const DEFAULT_LOGO: LogoId = "logo1";
export const LOGO_STORAGE_KEY = "kimi-logo";

export function LogoImage({ logo, size }: { logo: LogoId; size: number }) {
  return (
    <Image
      src={`/${logo}.png`}
      alt="Kimi"
      width={size}
      height={size}
      className="rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}

// A short synthesized "key click" — no audio file needed. Lazily creates one
// AudioContext on first use (always from within a click handler, so the
// browser's user-gesture requirement for audio is already satisfied).
let clickAudioCtx: AudioContext | null = null;

export function playClickSound() {
  try {
    if (!clickAudioCtx) clickAudioCtx = new AudioContext();
    const ctx = clickAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(1100, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(280, ctx.currentTime + 0.035);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.045);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
  } catch {
    // audio isn't essential — never let it break a click
  }
}
