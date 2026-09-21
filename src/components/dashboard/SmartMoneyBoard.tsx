"use client";

/* ── SMART MONEY · WHALE FLOW board (AI CORE surface) ───────────────
   Operator request #37 surfaced this on the COMMAND DECK; request
   2026-09-07 «SMART MONEY · WHALE FLOW را به صفحه AI CORE ببر» moved it
   into the AI CORE desk beside the raw flow matrix. Per-symbol OI Δ
   (whale footprint), taker CVD (aggressive flow), crowd positioning
   (contrarian input) and funding — the exact inputs the engine's FLOW
   gate reads before every deployment. */

import { useEffect, useMemo, useState } from "react";
import { Waves } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge, Sparkline } from "@/components/shared/primitives";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";

interface FlowRowDTO {
  symbol: string;
  price: number;
  change24h: number;
  oiDelta1h: number | null;
  oiDelta10m: number | null;
  oiValueUsd: number | null;
  cvdNetPctOfVol: number | null;
  takerRatio: number | null;
  crowdLongShort: number | null;
  funding8h: number | null;
  history: Array<{ at: number; oiDelta1h: number }>;
}
interface FlowMatrixDTO {
  status: { covered: number; lastOkAt: number | null; lastError: string | null };
  fundingExtreme: { symbol: string; funding8h: number } | null;
  rows: FlowRowDTO[];
}

function useFlowMatrix(intervalMs = 30_000): FlowMatrixDTO | null {
  const [data, setData] = useState<FlowMatrixDTO | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/flow/matrix", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as FlowMatrixDTO;
        if (alive) setData(j);
      } catch {
        /* keep last-good — telemetry never breaks the page */
      }
    };
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return data;
}

type Verdict = { label: string; tone: "neon" | "danger" | "amber" | "violet" | "muted"; hint: string };

function verdictOf(r: FlowRowDTO): Verdict {
  const oi = r.oiDelta1h ?? 0;
  const cvd = r.cvdNetPctOfVol ?? 0;
  if (oi >= 0.5 && cvd >= 2) return { label: "LONG BUILD", tone: "neon", hint: "open interest rising while aggressive takers buy — whale accumulation footprint" };
  if (oi >= 0.5 && cvd <= -2) return { label: "SHORT BUILD", tone: "danger", hint: "open interest rising while aggressive takers sell — bearish positioning footprint" };
  if (oi <= -0.5) return { label: "UNWIND", tone: "violet", hint: "open interest unwinding — positions being closed, trend fuel draining" };
  return { label: "NEUTRAL", tone: "muted", hint: "no directional whale footprint above threshold" };
}

function crowdFlag(v: number | null): Verdict | null {
  if (v === null) return null;
  if (v >= 2.2) return { label: `CROWD LONG ${v.toFixed(1)}`, tone: "amber", hint: "retail crowd heavily long — contrarian headwind for upside" };
  if (v <= 0.8) return { label: `CROWD SHORT ${v.toFixed(1)}`, tone: "amber", hint: "retail crowd heavily short — contrarian headwind for downside" };
  return null;
}

const fmtPct = (v: number | null, digits = 1) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`);
const fmtX = (v: number | null) => (v === null ? "—" : v.toFixed(2));

export default function SmartMoneyBoard() {
  const fm = useFlowMatrix();
  const setSpotlightSymbol = useUi((s) => s.setSpotlightSymbol);

  const rows = useMemo(() => (fm?.rows ?? []).slice(0, 8), [fm]);
  const covered = fm?.status.covered ?? 0;

  return (
    <section aria-label="Smart money whale flow" className="mt-4">
      <BentoCard corners>
        <div aria-hidden className="grid-bg-fine pointer-events-none absolute inset-0 rounded-[inherit] opacity-20 [mask-image:radial-gradient(circle_at_15%_0%,black_10%,transparent_70%)]" />
        <div className="relative">
          {/* header */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Waves size={14} className="text-cyan-neon" aria-hidden />
              <span className="label-tech">SMART MONEY · WHALE FLOW</span>
              <LiveDot />
            </div>
            <div className="flex items-center gap-2">
              {fm?.fundingExtreme && (
                <NeonBadge tone="amber" className="px-2 py-0.5 text-[10px]" >
                  ⚡ FUND {fmtPct(fm.fundingExtreme.funding8h * 100, 2)} {fm.fundingExtreme.symbol.replace("USDT", "")}
                </NeonBadge>
              )}
              <span className="label-tech hidden text-[10px] text-ink-3 sm:inline">
                {covered} syms live · feeds the scan gate (FLOW-SHORTLIST · FLOW-VETO ≤ −8)
              </span>
            </div>
          </div>

          {/* column header */}
          <div className="mt-3 hidden grid-cols-[7rem_5rem_5rem_6rem_4.5rem_6rem_minmax(5rem,1fr)] items-center gap-2 px-1 md:grid">
            {["SYMBOL", "OI Δ10m", "OI Δ1h", "TAKER CVD", "TAKER", "CROWD L/S", "OI Δ1h TREND"].map((h) => (
              <span key={h} className="label-tech text-[9px] text-ink-3">{h}</span>
            ))}
          </div>

          {/* rows */}
          {rows.length === 0 ? (
            <div className="label-tech mt-3 rounded-lg border border-dashed border-cyan-neon/25 p-4 text-center text-[11px] text-ink-3">
              {fm ? "FLOW FEED DEGRADED — RETRYING" : "MEASURING ORDER FLOW…"}
            </div>
          ) : (
            <ul className="mt-1 max-h-96 divide-y divide-white/5 overflow-y-auto">
              {rows.map((r) => {
                const v = verdictOf(r);
                const cf = crowdFlag(r.crowdLongShort);
                const oi = r.oiDelta1h ?? 0;
                const cvd = r.cvdNetPctOfVol ?? 0;
                return (
                  <li key={r.symbol}>
                    <button
                      type="button"
                      onClick={() => setSpotlightSymbol(r.symbol)}
                      aria-label={`Open ${r.symbol} spotlight — ${v.label}, OI delta 1h ${fmtPct(oi)}, taker CVD ${fmtPct(cvd)}`}
                      className="grid w-full min-h-12 grid-cols-2 items-center gap-2 rounded-lg px-1 py-2 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/60 md:grid-cols-[7rem_5rem_5rem_6rem_4.5rem_6rem_minmax(5rem,1fr)]"
                    >
                      <span className="truncate font-terminal text-sm font-bold text-foreground">{r.symbol}</span>
                      <span className={cn("text-right font-terminal text-xs font-bold tabular-nums md:text-left", (r.oiDelta10m ?? 0) >= 0 ? "text-neon" : "text-danger-neon")} title="open interest change, 10 minutes — fastest whale footprint">
                        {fmtPct(r.oiDelta10m)}
                      </span>
                      <span className={cn("text-right font-terminal text-xs font-bold tabular-nums md:text-left", oi >= 0 ? "text-neon" : "text-danger-neon")} title="open interest change, 1 hour">
                        {fmtPct(oi)}
                      </span>
                      <span className={cn("hidden text-right font-terminal text-xs font-bold tabular-nums sm:block", cvd >= 0 ? "text-neon" : "text-danger-neon")} title="net taker CVD as % of volume — aggressive directional flow">
                        {fmtPct(cvd)}
                      </span>
                      <span className="hidden font-terminal text-xs tabular-nums text-ink-2 sm:block" title="taker buy/sell ratio">{fmtX(r.takerRatio)}</span>
                      <span className="hidden font-terminal text-xs tabular-nums text-ink-2 md:block" title="retail crowd long/short accounts ratio">{fmtX(r.crowdLongShort)}</span>
                      <span className="col-span-2 flex items-center gap-2 md:col-span-1">
                        <Sparkline data={(r.history ?? []).map((h) => h.oiDelta1h)} width={72} height={20} tone={oi >= 0 ? "neon" : "danger"} fill={false} className="hidden sm:block" />
                        <span className="ml-auto shrink-0" title={v.hint}>
                          <NeonBadge tone={v.tone} className="px-2 py-0.5 text-[9px]">{v.label}</NeonBadge>
                        </span>
                        {cf && (
                          <span className="hidden shrink-0 lg:inline" title={cf.hint}>
                            <NeonBadge tone={cf.tone} className="px-2 py-0.5 text-[9px]">{cf.label}</NeonBadge>
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-2 text-[10px] leading-snug text-ink-3">
            Whale footprint = notional-weighted OI Δ + aggressive taker CVD + crowd positioning + funding — the same
            measured inputs the engine's flow gate consumes before every deployment (not a separate sentiment feed).
          </p>
        </div>
      </BentoCard>
    </section>
  );
}
