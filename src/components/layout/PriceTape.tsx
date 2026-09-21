"use client";

// ── PriceTape — live price strip under the header on ALL views (v5.1) ──
// TRUE marquee: one continuous, seamless loop (two identical halves, translateX 0→−50%).
// Prices flash up/down in place — the animation NEVER restarts on data updates because
// keys are stable and only text nodes change. Hover pauses. Reduced-motion ⇒ static tape.
// The WS·REST source badge is pinned (it must not scroll away with the flow).

import { useEffect, useMemo } from "react";
import { usePriceStream } from "@/hooks/usePriceStream";
import { cn } from "@/lib/utils";

const prevPrice = new Map<string, number>();

function fmt(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 10) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  return p.toFixed(4);
}

export function PriceTape() {
  const stream = usePriceStream();

  const rows = useMemo(() => {
    const arr = [...stream.rows.values()].filter((r) => r.price > 0).sort((a, b) => b.volume24h - a.volume24h);
    return arr.slice(0, 44);
  }, [stream.rows.size, stream]);

  /* flash direction: compare against the last-seen price, then persist AFTER render */
  const flash = useMemo(() => {
    const m = new Map<string, "up" | "down" | null>();
    for (const r of rows) {
      const prev = prevPrice.get(r.symbol);
      m.set(r.symbol, prev === undefined || prev === r.price ? null : r.price > prev ? "up" : "down");
    }
    return m;
  }, [rows]);

  useEffect(() => {
    for (const r of rows) prevPrice.set(r.symbol, r.price);
  }, [rows]);

  const src = stream.source;

  /* one half of the seamless loop — rendered twice inside the track */
  const half = (dup: 0 | 1) => (
    <div className="flex shrink-0 items-center gap-5 pr-5" aria-hidden={dup === 1}>
      {rows.map((r) => {
        const dir = flash.get(r.symbol) ?? null;
        return (
          <span key={`${dup}-${r.symbol}`} className="flex shrink-0 items-center gap-1.5 font-terminal text-[10px]">
            <span className="font-bold tracking-[0.1em] text-ink-2">{r.symbol.replace("USDT", "")}</span>
            <span
              className={cn(
                "tabular-nums transition-colors duration-500",
                dir === "up" ? "text-neon" : dir === "down" ? "text-danger-neon" : "text-ink",
              )}
            >
              ${fmt(r.price)}
            </span>
            <span className={cn("tabular-nums", r.change24h >= 0 ? "text-neon/70" : "text-danger-neon/70")}>
              {r.change24h >= 0 ? "▲" : "▼"}
              {Math.abs(r.change24h).toFixed(1)}%
            </span>
          </span>
        );
      })}
    </div>
  );

  if (rows.length === 0) {
    return (
      <div className="relative z-10 border-y border-white/5 bg-[rgba(0,0,0,0.25)] px-4 py-1.5 sm:px-6" aria-hidden>
        <div className="mx-auto max-w-[1600px]">
          <span className="anim-flicker font-terminal text-[10px] tracking-[0.18em] text-ink-3">PRICE TAPE — ESTABLISHING WS CHANNEL…</span>
        </div>
      </div>
    );
  }

  /* loop duration scales with content: ~3.2s per pair, clamped 45–140s for a clean pace */
  const duration = Math.min(140, Math.max(45, Math.round(rows.length * 3.2)));

  return (
    <div className="group relative z-10 overflow-hidden border-y border-white/5 bg-[rgba(0,0,0,0.25)]" role="marquee" aria-label="Live price tape — continuously scrolling">
      {/* the marquee track: width max-content, two identical halves, linear infinite */}
      <div
        className="anim-marquee flex w-max items-center py-1.5 group-hover:[animation-play-state:paused]"
        style={{ animationDuration: `${duration}s` }}
      >
        {half(0)}
        {half(1)}
      </div>

      {/* pinned source badge — never scrolls away */}
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center bg-gradient-to-l from-[rgba(0,0,0,0.88)] via-[rgba(0,0,0,0.55)] to-transparent pl-8 pr-4 sm:pr-6">
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 font-terminal text-[9px] font-bold tracking-[0.14em]",
            src === "WS PUSH"
              ? "border-[rgb(var(--neon-rgb)/0.35)] text-neon"
              : src === "WS·REST 2.5S"
                ? "border-[rgba(255,179,71,0.4)] text-amber-neon"
                : "border-white/10 text-ink-3",
          )}
          title={
            src === "WS·REST 2.5S"
              ? "WS frames stripped by this host — honest REST fallback 2.5s"
              : src === "WS PUSH"
                ? "sub-second websocket push"
                : "channel offline"
          }
        >
          {src}
        </span>
      </div>

      {/* left edge fade so pairs enter smoothly */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-[rgba(0,0,0,0.85)] to-transparent" />
    </div>
  );
}
