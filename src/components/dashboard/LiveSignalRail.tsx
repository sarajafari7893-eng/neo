"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { ArrowRight, TrendingDown, TrendingUp } from "lucide-react";
import { CountdownRing, LiveDot, NeonBadge, SectionHeader } from "@/components/shared/primitives";
import { useNow } from "@/hooks/usePulse";
import type { MarketAssetDTO, SignalDTO } from "@/lib/api-types";
import { fmtPct, fmtPrice, levelProgress, STATUS_META } from "@/lib/format";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";

const OPEN_STATUSES = new Set(["ACTIVE", "TP1", "TP2"]);

const statusTone: Record<string, "neon" | "danger" | "amber" | "muted"> = {
  live: "neon",
  win: "neon",
  loss: "danger",
  warn: "amber",
  muted: "muted",
};

function ttlLabel(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function RailCard({ signal, price }: { signal: SignalDTO; price: number }) {
  const setView = useUi((s) => s.setView);
  const now = useNow(1000);
  const live = now > 0;

  const long = signal.direction === "LONG";
  const up = signal.pnlPercent >= 0;
  const meta = STATUS_META[signal.status] ?? { label: signal.status, tone: "muted" as const };

  const totalTtl = Math.max(1, signal.ttlMinutes * 60_000);
  const remaining = live ? Math.max(0, new Date(signal.expiresAt).getTime() - now) : 0;
  const progress = live ? Math.min(1, Math.max(0, remaining / totalTtl)) : 1;
  /* final-minute panic treatment mirrors SignalCard */
  const ttlFinal = live && remaining > 0 && remaining <= 60_000;

  const hits = signal.status === "TP2" ? 2 : signal.status === "TP1" ? 1 : 0;

  /* SL → TP3 ladder progress (0 = at SL, 1 = TP3) */
  const prog = levelProgress(price, signal.entryPrice, signal.stopLoss, signal.tp3);
  const span = signal.tp3 - signal.stopLoss || 1;
  const entryFrac = Math.min(1, Math.max(0, (signal.entryPrice - signal.stopLoss) / span));

  return (
    <button
      type="button"
      onClick={() => setView("signals")}
      aria-label={`Open ${signal.symbol} ${signal.direction} signal detail`}
      className="bento group w-[280px] shrink-0 snap-start p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:w-[300px]"
    >
      {/* header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-terminal text-base font-extrabold tracking-wide text-foreground">{signal.symbol}</span>
          <NeonBadge tone={long ? "neon" : "magenta"} glow>
            {long ? <TrendingUp className="h-3 w-3" aria-hidden /> : <TrendingDown className="h-3 w-3" aria-hidden />}
            {signal.direction}
          </NeonBadge>
        </div>
        <NeonBadge tone={statusTone[meta.tone]}>{meta.label}</NeonBadge>
      </div>
      <div className="label-tech mt-1 truncate">
        {signal.strategy} · {signal.timeframe} · {signal.leverage}x
      </div>

      {/* entry + live pnl */}
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="label-tech">ENTRY</div>
          <div className="truncate font-terminal text-sm font-bold text-ink">{fmtPrice(signal.entryPrice)}</div>
        </div>
        <motion.div
          key={signal.pnlPercent.toFixed(2)}
          initial={{ opacity: 0.35, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="min-w-0 text-right"
        >
          <div className="label-tech">LIVE PNL</div>
          <div className={cn("font-terminal text-lg font-extrabold tabular-nums", up ? "text-neon neon-text" : "text-danger-neon neon-text-danger")}>
            {fmtPct(signal.pnlPercent)}
          </div>
        </motion.div>
        <div className={cn("shrink-0 rounded-full", ttlFinal && "ttl-final")}>
          <CountdownRing
            progress={progress}
            label={live ? ttlLabel(remaining) : "··:··"}
            sub="TTL"
            size={48}
            tone={ttlFinal ? "amber" : undefined}
            urgent={progress < 0.2}
          />
        </div>
      </div>

      {/* TP ladder dots */}
      <div className="mt-3 flex items-center gap-3">
        {(["TP1", "TP2", "TP3"] as const).map((tp, i) => {
          const hit = i < hits;
          return (
            <div key={tp} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "h-2 w-2 rounded-full border",
                  hit ? "border-neon bg-neon shadow-[0_0_6px_rgb(var(--neon-rgb)/0.8)]" : "border-white/20 bg-transparent"
                )}
                aria-hidden
              />
              <span className={cn("font-terminal text-[9px] font-bold tracking-[0.14em]", hit ? "text-neon" : "text-ink-3")}>{tp}</span>
            </div>
          );
        })}
        <span className="ml-auto font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">conf {signal.confidence}%</span>
      </div>

      {/* SL → TP3 progress with entry marker */}
      <div className="mt-2.5">
        <div className="relative h-1.5 rounded-full bg-white/5" aria-hidden>
          <div
            className={cn("absolute inset-y-0 left-0 rounded-full", up ? "bg-neon" : "bg-danger-neon")}
            style={{ width: `${prog * 100}%`, boxShadow: "0 0 8px currentColor", transition: "width 0.9s linear" }}
          />
          <div className="absolute -top-[3px] h-3 w-[2px] bg-ink-2/80" style={{ left: `${entryFrac * 100}%` }} title="Entry" />
        </div>
        <div className="mt-1 flex justify-between font-terminal text-[9px] tracking-[0.1em] text-ink-3">
          <span>SL {fmtPrice(signal.stopLoss)}</span>
          <span>TP3 {fmtPrice(signal.tp3)}</span>
        </div>
      </div>
    </button>
  );
}

export default function LiveSignalRail({ signals, market }: { signals: SignalDTO[]; market: MarketAssetDTO[] }) {
  const setView = useUi((s) => s.setView);

  const priceBySymbol = useMemo(() => new Map(market.map((a) => [a.symbol, a.price])), [market]);
  const open = useMemo(() => signals.filter((s) => OPEN_STATUSES.has(s.status)), [signals]);

  return (
    <section aria-label="Live deployments">
      <SectionHeader
        index="01"
        title="LIVE DEPLOYMENTS"
        subtitle="Engine-open positions with TTL countdowns and ladder progress"
        right={
          <button
            type="button"
            onClick={() => setView("signals")}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 font-terminal text-xs font-bold uppercase tracking-[0.18em] text-neon transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60"
          >
            View all <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        }
      />

      {open.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-neon/25 bg-white/[0.015] p-8 text-center">
          <span className="relative flex h-4 w-4 items-center justify-center">
            <span className="anim-pulse-dot absolute h-3 w-3 rounded-full bg-neon" />
            <span className="absolute h-8 w-8 animate-ping rounded-full border border-neon/30" aria-hidden />
          </span>
          <span className="label-tech">Engine scanning…</span>
          <p className="text-sm text-ink-2">next deployment imminent</p>
        </div>
      ) : (
        <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-3">
          {open.map((s) => (
            <RailCard key={s.id} signal={s} price={priceBySymbol.get(s.symbol) ?? s.entryPrice} />
          ))}
          {/* trailing nudge card */}
          <button
            type="button"
            onClick={() => setView("signals")}
            aria-label="View all signals"
            className="flex min-h-44 w-36 shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neon/20 text-ink-3 transition hover:border-neon/45 hover:text-neon focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60"
          >
            <LiveDot />
            <span className="font-terminal text-[10px] uppercase tracking-[0.18em]">More</span>
          </button>
        </div>
      )}
    </section>
  );
}
