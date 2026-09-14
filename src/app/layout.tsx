import type { Metadata } from "next";
import { Fredoka, Nunito, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Fredoka + Nunito: a rounded, friendly pairing that matches Kimi's cute
// mascot-and-bubblegum-pink identity, while Nunito stays legible enough for
// dense educational paragraphs (unlike a fully decorative display font).
const headingFont = Fredoka({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const bodyFont = Nunito({
  variable: "--font-text",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const monoFont = JetBrains_Mono({
  variable: "--font-code",
  subsets: ["latin"],
  weight: ["500"],
});

export const metadata: Metadata = {
  title: "Kimi — Nursing & Mental Health Research Assistant",
  description: "Ask Kimi about nursing, anatomy & physiology, psychiatry, mental health, and PhD-level research support.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${headingFont.variable} ${bodyFont.variable} ${monoFont.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
