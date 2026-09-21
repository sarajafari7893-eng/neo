"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkline } from "@/components/shared/primitives";
import { useMounted, usePulse } from "@/hooks/usePulse";
import type { MarketAssetDTO } from "@/lib/api-types";
import { fmtPct, fmtPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

type Flash = { dir: "up" | "down"; ts: number };

function TickerRow({ asset, flash }: { asset: MarketAssetDTO; flash?: Flash }) {
  const up = asset.change24h >= 0;
  return (
    <div
      key={`${asset.symbol}-${flash?.ts ?? 0}`}
      className="flex h-16 items-center gap-2.5 px-5"
      style={
        flash
          ? { animation: flash.dir === "up" ? "ticker-flash-up 0.9s ease-out" : "ticker-flash-down 0.9s ease-out" }
          : undefined
      }
    >
      <span className="font-terminal text-sm font-bold tracking-wide text-foreground">{asset.symbol}</span>
      <span className="font-terminal text-xs tabular-nums text-ink-2">{fmtPrice(asset.price)}</span>
      <span className={cn("font-terminal text-xs font-bold tabular-nums", up ? "text-neon" : "text-danger-neon")}>
        {up ? "▲" : "▼"} {fmtPct(asset.change24h)}
      </span>
      <Sparkline data={asset.sparkline} width={60} height={20} tone={up ? "neon" : "danger"} fill={false} strokeWidth={1.5} />
    </div>
  );
}

export default function TickerMarquee() {
  const { data } = usePulse();
  const mounted = useMounted();
  const market = data?.market;

  const prevRef = useRef<Map<string, number>>(new Map());
  const [flashes, setFlashes] = useState<Record<string, Flash>>({});

  useEffect(() => {
    if (!market || !mounted) return;
    const prev = prevRef.current;
    const next: Record<string, Flash> = {};
    for (const a of market) {
      const p = prev.get(a.symbol);
      if (p !== undefined && p !== a.price) {
        next[a.symbol] = { dir: a.price > p ? "up" : "down", ts: Date.now() };
      }
      prev.set(a.symbol, a.price);
    }
    /* rAF callback keeps setState out of the effect body (no cascading render) */
    const raf = requestAnimationFrame(() => setFlashes(next));
    return () => cancelAnimationFrame(raf);
  }, [market, mounted]);

  /* skeleton shimmer strip while the first snapshot loads */
  if (!market) {
    return (
      <div
        className="glass h-16 overflow-hidden rounded-xl border-y border-[rgb(var(--neon-rgb)/0.12)]"
        role="status"
        aria-label="Loading market ticker"
      >
        <div className="flex h-full items-center gap-10 px-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <div className="h-3 w-14 animate-pulse rounded bg-white/10" />
              <div className="h-3 w-10 animate-pulse rounded bg-white/[0.07]" />
              <div className="h-4 w-16 animate-pulse rounded bg-white/[0.05]" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="marquee-mask glass group/marquee h-16 overflow-hidden border-y border-[rgb(var(--neon-rgb)/0.12)]"
      role="region"
      aria-label="Live market ticker"
    >
      <div className="anim-marquee group-hover/marquee:[animation-play-state:paused] flex h-full w-max items-center">
        {market.map((a) => (
          <div key={a.symbol} className="flex items-center">
            <TickerRow asset={a} flash={flashes[a.symbol]} />
            <span aria-hidden className="mx-8 font-terminal text-[8px] text-neon/30">◆</span>
          </div>
        ))}
        <div aria-hidden className="contents">
          {market.map((a) => (
            <div key={`dup-${a.symbol}`} className="flex items-center">
              <TickerRow asset={a} />
              <span aria-hidden className="mx-8 font-terminal text-[8px] text-neon/30">◆</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
