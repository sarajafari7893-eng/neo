"use client";

// ── EXCHANGE CONSENSUS card (R14) — per-venue live mids for the active symbol ──

import { ArrowLeftRight } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { fmtPrice } from "@/lib/format";
import { usePulse } from "@/hooks/usePulse";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";

interface Quote {
  venue: string;
  price: number | null;
  latencyMs: number | null;
}

export default function ExchangeConsensusCard() {
  const { data: pulse } = usePulse(6000);
  const activeSymbol = useUi((s) => s.activeSymbol);

  const market = pulse?.market ?? [];
  const spotlight = activeSymbol ? market.find((m) => m.symbol === activeSymbol) ?? market[0] : market[0];
  const symbol = spotlight?.symbol ?? "";
  const quotes: Quote[] = spotlight?.exchanges ?? [];
  const devBps = spotlight?.maxDevBps ?? 0;

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.1}>
      <div className="mb-3 flex items-center gap-2">
        <ArrowLeftRight className="size-4 text-cyan-neon" aria-hidden />
        <span className="label-tech">EXCHANGE CONSENSUS</span>
        {symbol && <NeonBadge tone="muted" className="ml-auto">{symbol}</NeonBadge>}
      </div>

      {!spotlight || quotes.length === 0 ? (
        <p className="font-terminal text-[11px] text-ink-3">— consensus sweep warming up… —</p>
      ) : (
        <div className="space-y-1.5">
          {quotes.map((q) => (
            <div key={q.venue} className="flex items-center gap-2 rounded border border-white/5 bg-white/[0.02] px-2.5 py-1.5 font-terminal text-[11px]">
              <LiveDot tone={q.price ? "neon" : "amber"} />
              <span className="w-24 shrink-0 font-bold tracking-[0.12em] text-ink-2">{q.venue}</span>
              <span className={cn("ml-auto tabular-nums", q.price ? "text-ink" : "text-ink-3")}>{q.price ? `$${fmtPrice(q.price)}` : "—"}</span>
              {q.latencyMs !== null && q.price && <span className="w-14 shrink-0 text-right tabular-nums text-ink-3">{q.latencyMs}ms</span>}
            </div>
          ))}
          <div className="flex items-center justify-between pt-1 font-terminal text-[10px] tracking-[0.1em]">
            <span className="text-ink-3">MAX DEV</span>
            <span className={cn("font-bold tabular-nums", devBps > 12 ? "text-amber-neon" : "text-cyan-neon")}>{devBps.toFixed(1)} bps</span>
          </div>
          <p className="font-terminal text-[9px] leading-relaxed tracking-[0.08em] text-ink-3">TERMINAL PRICE = MEDIAN WHEN ≥2 VENUES AGREE — single-venue outliers cannot move it</p>
        </div>
      )}
    </BentoCard>
  );
}
