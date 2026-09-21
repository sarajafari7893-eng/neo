import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import { APP_TITLE, APP_OG_TITLE } from "@/lib/brand";

const display = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const terminal = JetBrains_Mono({
  variable: "--font-terminal",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
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
