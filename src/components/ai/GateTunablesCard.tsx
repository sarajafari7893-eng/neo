"use client";

// ── GATE TUNABLES card (v6.0) — READ-ONLY window into agent-controlled gates ──
// FULL AUTONOMY (operator mandate: «هیچ حالت دستی برای یادگیری و استقرار
// نباید باشه»): deployment gates are tuned EXCLUSIVELY by the AI governor —
// it proposes changes each cycle, the core validates them against hard clamps,
// and every change is audited in the decision log. The manual sliders/APPLY
// control were removed; this card shows the live agent-set values + bounds.

import { useEffect, useState } from "react";
import { SlidersHorizontal, Bot } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";

interface Gate {
  minScore: number;
  flowShortlist: number;
  flowVetoScore: number;
  universeSize: number;
  ttlExtendMax: number;
  ttlExtendMinutes: number;
  ttlNearTpPct: number;
  slAtrMult: number;
  rrScale: number;
  regimeGuard: number;
  maxActive: number;
  riskPerTrade: number;
  onsetRetestGuard: number;
  chaseThrAdj: number;
  leveredRiskCap: number;
  beTrailPct: number;
  shortSizeMult: number;
  breakoutGuard: number;
  shortGuard: number;
  beArmMovePct: number;
  earlyExitGuard: number;
  earlyExitFrac: number;
  earlyExitR: number;
  researchShadow: number;
  probeDeploys: number;
}

const CLAMPS: Record<keyof Gate, [number, number]> = {
  minScore: [12, 60],
  flowShortlist: [1, 6],
  flowVetoScore: [4, 25],
  universeSize: [12, 64],
  ttlExtendMax: [0, 3],
  ttlExtendMinutes: [15, 240],
  ttlNearTpPct: [0.3, 5],
  slAtrMult: [0.8, 2.5],
  rrScale: [0.75, 1.35],
  regimeGuard: [0, 2],
  maxActive: [2, 8],
  riskPerTrade: [0.5, 1.5],
  onsetRetestGuard: [0, 1],
  chaseThrAdj: [0, 15],
  leveredRiskCap: [10, 100],
  beTrailPct: [0, 40],
  shortSizeMult: [0.3, 1],
  breakoutGuard: [0, 2],
  shortGuard: [0, 2],
  beArmMovePct: [0, 10],
  earlyExitGuard: [0, 1],
  earlyExitFrac: [0.3, 0.9],
  earlyExitR: [0, 1],
  researchShadow: [0, 1],
  probeDeploys: [0, 1],
};

const LABELS: Record<keyof Gate, string> = {
  minScore: "MIN_SCORE (+regime thrAdj)",
  flowShortlist: "FLOW-SHORTLIST",
  flowVetoScore: "FLOW-VETO ≤−",
  universeSize: "UNIVERSE SIZE",
  ttlExtendMax: "TTL-GATE ×MAX (0=OFF)",
  ttlExtendMinutes: "TTL-GATE +MIN",
  ttlNearTpPct: "TTL-GATE TP-BAND %",
  slAtrMult: "STOP DISTANCE ×ATR",
  rrScale: "R:R LADDER SCALE",
  regimeGuard: "REGIME GUARD L0–L2",
  maxActive: "MAX OPEN SIGNALS",
  riskPerTrade: "RISK PER TRADE ×",
  onsetRetestGuard: "ONSET-RETEST GATE 0/1",
  chaseThrAdj: "LONG-CHASE SURCHARGE +",
  leveredRiskCap: "LEVERED RISK CAP %",
  beTrailPct: "BE-TRAIL +NET% (v6.5)",
  shortSizeMult: "SHORT-SIZE ×",
  breakoutGuard: "BREAKOUT GUARD 0/1/2",
  shortGuard: "SHORT-GUARD 0/1/2 (R1)",
  beArmMovePct: "BE ARM +PRICE% (R2)",
  earlyExitGuard: "EARLY-EXIT SWITCH (R2/R7)",
  earlyExitFrac: "EARLY-EXIT %TTL",
  earlyExitR: "EARLY-EXIT −R CUT (R7)",
  researchShadow: "RESEARCH-SHADOW A/B (R5)",
  probeDeploys: "G4 RECOVERY PROBE 0/1",
};

const HINTS: Record<keyof Gate, string> = {
  minScore: "base confluence threshold — regime thrAdj makes it per-candidate",
  flowShortlist: "top candidates flow-checked per scan",
  flowVetoScore: "flow score below this vetoes the deploy",
  universeSize: "flow-ranked USDT-M perps the scanner tracks",
  ttlExtendMax: "dynamic expiry gate — max TTL extensions per signal",
  ttlExtendMinutes: "minutes granted per TTL extension",
  ttlNearTpPct: "unlevered % band to next TP that earns an extension",
  slAtrMult: "stop distance in ATR multiples (× regime widening)",
  rrScale: "governor scale on the computed TP2/TP3 ladder",
  regimeGuard: "chop veto hardening (L1) + BTC-spillover & vol MR veto (L2)",
  maxActive: "position capacity — max concurrent open signals",
  riskPerTrade: "margin sizing multiplier on confidence-sized margin",
  onsetRetestGuard: "block chasing a hot eruption until 30% retraced (v6.7.2)",
  chaseThrAdj: "extra threshold for LONG entries into extended bursts (v6.7.2)",
  leveredRiskCap: "max single-trade swing at stop — trims leverage (v6.7.2)",
  beTrailPct: "levered NET% that arms the breakeven trail (v6.5)",
  shortSizeMult: "margin multiplier on SHORT deployments (v6.5)",
  breakoutGuard: "BREAKOUT: 0 normal · 1 half-size · 2 veto (v6.5)",
  shortGuard: "audit R1: 0 normal · 1 HTF-align required · 2 SHORTs paused — 11.1% WR / −$9.69",
  beArmMovePct: "audit R2: unlevered +price% that decisively arms breakeven (leverage-invariant)",
  earlyExitGuard: "audit R2/R7: close unbanked trades early instead of riding to SL",
  earlyExitFrac: "fraction of TTL after which the early-exit arms (R2/R7)",
  earlyExitR: "audit R7: NET ≤ −R×1R after the TTL fraction closes at mark — EXPIRED +$2.66 vs SL −$12.61",
  researchShadow: "audit R5: journal the research ladder (slAtr 1.2 · rr 1.15) as a 1m-replay A/B twin",
  probeDeploys: "v8.4.1 G4: learned-gate closed + drought ≥2h → ONE bounded LONG-only deploy per 2h at half margin, tagged G4-PROBE — recharges the G1 rolling window",
};

export default function GateTunablesCard() {
  const [gate, setGate] = useState<Gate | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { gate: Gate };
          setGate(data.gate);
        }
      } catch {
        /* keep */
      }
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.15}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SlidersHorizontal className="size-4 text-amber-neon" aria-hidden />
        <span className="label-tech">GATE TUNABLES</span>
        <NeonBadge tone="violet" glow className="ml-auto">
          <Bot className="size-3" aria-hidden /> AGENT-CONTROLLED
        </NeonBadge>
      </div>

      {!gate ? (
        <p className="font-terminal text-[11px] text-ink-3">— loading gate settings… —</p>
      ) : (
        <div className="space-y-2.5">
          {(Object.keys(LABELS) as Array<keyof Gate>).map((key) => {
            const [lo, hi] = CLAMPS[key];
            const pct = Math.min(100, Math.max(0, ((gate[key] - lo) / (hi - lo)) * 100));
            return (
              <div key={key} className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-terminal text-[10px] font-bold tracking-[0.12em] text-ink-2">{LABELS[key]}</span>
                  <span className="ml-auto font-terminal text-sm font-bold tabular-nums text-ink">
                    {typeof gate[key] === "number" ? gate[key] : "—"}
                    <span className="ml-1 text-[9px] font-normal text-ink-3">
                      clamp {lo}–{hi}
                    </span>
                  </span>
                </div>
                <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/5" role="presentation">
                  <div className="h-full rounded-full bg-violet-neon" style={{ width: `${pct}%`, boxShadow: "0 0 8px rgba(178,107,255,0.6)" }} />
                </div>
                <p className="mt-1 font-terminal text-[9px] tracking-[0.06em] text-ink-3">{HINTS[key]}</p>
              </div>
            );
          })}
          <p className="flex items-start gap-1.5 rounded-lg border border-[rgba(178,107,255,0.25)] bg-[rgba(178,107,255,0.05)] px-3 py-2 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-ink-2">
            <LiveDot tone="violet" />
            <span>
              THE AI GOVERNOR SETS THESE — every cycle it reviews measured telemetry and may retune gates, always inside the hard clamps above; each change is audited in the governor decision log. Manual override endpoints were removed in v6.0.
            </span>
          </p>
        </div>
      )}
    </BentoCard>
  );
}
