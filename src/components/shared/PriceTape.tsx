"use client";

// ── NEXUS//SIGNALS PriceTape (v4.6) ──
// Sub-second live prices fed by the price-ws socket.io channel, rendered as a
// CONTINUOUS marquee — the tape never sits still, it glides (GPU transform,
// linear, seamless duplicated track) and pauses on hover for reading. Flash
// colors mark the last tick direction; the badge stays honest about which
// source is flowing (WS push / REST fallback / offline).

import { useMemo } from "react";
import { Activity } from "lucide-react";
import { usePriceStream, type PriceSource } from "@/hooks/usePriceStream";
import { useMounted } from "@/hooks/usePulse";
import { fmtPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

const SOURCE_META: Record<PriceSource, { label: string; cls: string; hint: string }> = {
  "BINANCE-WS": { label: "WS PUSH", cls: "text-neon", hint: "Binance websocket push — sub-second prices" },
  "REST-POLL": { label: "WS·REST 2.5S", cls: "text-amber-neon", hint: "Ws frames blocked on this host — REST polling fallback (2.5s), still pushed over websocket" },
  OFFLINE: { label: "WS OFFLINE", cls: "text-danger-neon", hint: "Price channel unreachable — pulse feed (5s) remains authoritative" },
  CONNECTING: { label: "WS…", cls: "text-ink-3", hint: "Connecting to the price channel" },
};

// module-level previous-price memory for flash direction (not a ref — pure
// monotonic cache, render stays side-effect free w.r.t. React state)
const prevPrices = new Map<string, number>();

interface TapeRow {
  sym: string;
  price: number;
  change24h: number;
  dir: number;
}

export function PriceTape() {
  const { prices, source, connected } = usePriceStream();
  // Hydration safety: the module-singleton socket can receive frames BETWEEN
  // SSR and hydration, so the first (hydrating) render must be deterministic —
  // always paint the CONNECTING/empty shell, then switch to live state.
  const mounted = useMounted();
  const liveSource: PriceSource = mounted ? source : "CONNECTING";
  const liveConnected = mounted ? connected : false;
  const liveRows = mounted ? prices : {};

  const rows = useMemo<TapeRow[]>(
    () =>
      Object.entries(liveRows)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([sym, e]) => {
          const prevPrice = prevPrices.get(sym);
          prevPrices.set(sym, e.price);
          const dir = prevPrice == null || prevPrice === e.price ? 0 : e.price > prevPrice ? 1 : -1;
          return { sym, price: e.price, change24h: e.change24h, dir };
        }),
    [liveRows]
  );

  // one glide duration for the whole track — long enough to read, short
  // enough to feel alive (the duplicated half makes the loop seamless)
  const glide = Math.max(38, Math.min(90, rows.length * 2.6));

  const cell = (r: TapeRow, copy: "a" | "b", hidden: boolean) => (
    <span
      key={`${copy}-${r.sym}`}
      aria-hidden={hidden || undefined}
      className="flex shrink-0 items-baseline gap-1.5 font-terminal text-[10px] tabular-nums"
      title={`${r.sym} — live via ${liveSource}`}
    >
      <span className="text-ink-3">{r.sym.replace("USDT", "")}</span>
      <span
        className={cn(
          "font-bold transition-colors duration-300",
          r.dir > 0 ? "text-neon" : r.dir < 0 ? "text-danger-neon" : "text-ink"
        )}
      >
        {r.dir > 0 ? "▲" : r.dir < 0 ? "▼" : ""} {fmtPrice(r.price)}
      </span>
      <span className={cn("text-[9px]", r.change24h >= 0 ? "text-neon/70" : "text-danger-neon/70")}>
        {r.change24h >= 0 ? "+" : ""}
        {r.change24h.toFixed(1)}%
      </span>
      <span className="mx-1 text-ink-3/40">·</span>
    </span>
  );

  return (
    <div className="relative z-10 mx-auto w-full max-w-[1600px] px-4 sm:px-6" data-price-tape>
      <div className="flex items-stretch gap-0 overflow-hidden rounded-lg border border-[rgb(var(--neon-rgb)/0.14)] bg-[rgba(7,12,16,0.72)] backdrop-blur">
        {/* channel badge */}
        <div
          className="flex shrink-0 items-center gap-1.5 border-r border-white/8 px-3 py-2"
          title={SOURCE_META[liveSource].hint}
        >
          <Activity className={cn("size-3.5", liveConnected ? "text-neon anim-pulse-dot" : "text-ink-3")} aria-hidden />
          <span className={cn("font-terminal text-[9px] font-bold uppercase tracking-[0.16em]", SOURCE_META[liveSource].cls)}>
            {SOURCE_META[liveSource].label}
          </span>
        </div>

        {/* continuous marquee — duplicated content, translateX 0→−50% loop */}
        <div className="relative flex-1 overflow-hidden" role="marquee" aria-label="Live prices via websocket channel">
          {rows.length === 0 ? (
            <div className="px-3 py-1.5">
              <span className="font-terminal text-[10px] tracking-[0.14em] text-ink-3">
                {liveConnected ? "SYNCING PRICE CHANNEL…" : "PRICE CHANNEL CONNECTING…"}
              </span>
            </div>
          ) : (
            <>
              <div
                className="tape-track flex w-max items-center py-1.5 pl-3 hover:[animation-play-state:paused]"
                style={{ animationDuration: `${glide}s` }}
              >
                {rows.map((r) => cell(r, "a", false))}
                {rows.map((r) => cell(r, "b", true))}
              </div>
              {/* edge fades — the tape dissolves instead of hard-clipping */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[rgba(7,12,16,0.92)] to-transparent"
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[rgba(7,12,16,0.92)] to-transparent"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
