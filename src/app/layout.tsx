import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import { APP_TITLE, APP_OG_TITLE } from "@/lib/brand";

// v14.2 FONT-SOVEREIGNTY (trace 1a18db2beba9b781) — the Google-font fetch at
// dev-boot wedged once (Turbopack virtual module "Module not found:
// @vercel/turbopack-next/internal/font/google/font" after recycle storms) and
// the ENTIRE dashboard 500'd while every API/feed/bridge stayed healthy — one
// more "سیستم از کار می‌افتد" mechanism. Both fonts are now VENDORED variable
// woff2 files (src/app/fonts/): same families, same CSS variables, zero boot
// egress dependency, immune to Google reachability and cache wedges.
const display = localFont({
  src: "./fonts/SpaceGrotesk-var-latin.woff2",
  variable: "--font-display",
  weight: "300 700",
  display: "swap",
});

const terminal = localFont({
  src: "./fonts/JetBrainsMono-var-latin.woff2",
  variable: "--font-terminal",
  weight: "100 800",
  display: "swap",
});

export const metadata: Metadata = {
  title: APP_TITLE,
  description:
    "High-performance AI crypto signal terminal. Live entries, TP/SL ladders, TTL timers, engine analytics and neural market intelligence.",
  keywords: ["crypto signals", "AI trading", "terminal", "TP SL", "trading terminal", "web3"],
  authors: [{ name: "FlowRadar Labs" }],
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2305070a'/%3E%3Cpath d='M9 22V10l14 12V10' stroke='%2300ffa3' stroke-width='2.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E",
  },
  openGraph: {
    title: APP_OG_TITLE,
    description: "AI Trading Command Terminal",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#05070a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${display.variable} ${terminal.variable} font-sans antialiased bg-background text-foreground scanlines vignette noise`}
      >
        <Providers>{children}</Providers>
        <Toaster />
        <SonnerToaster
          position="bottom-left"
          toastOptions={{
            unstyled: false,
            classNames: {
              toast:
                "!rounded-xl !border !border-white/10 !bg-[rgba(7,11,14,0.96)] !text-ink !backdrop-blur-xl !font-terminal",
            },
          }}
        />
      </body>
    </html>
  );
}
