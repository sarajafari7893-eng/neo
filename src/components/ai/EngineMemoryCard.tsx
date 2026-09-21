"use client";

// ── ENGINE MEMORY card — the exact grounded object the AI analyst sees (R14) ──
// Includes the AI CALIBRATION block (R17): OBSERVING progress or ACTIVE weight bars.

import { useEffect, useState } from "react";
import { Database, GraduationCap } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge, ConfidenceBar } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";
import type { EngineMemory } from "@/lib/ai-memory";

export default function EngineMemoryCard() {
  const [memory, setMemory] = useState<EngineMemory | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/ai/memory", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { memory: EngineMemory };
        if (alive) {
          setMemory(data.memory);
          setLive(true);
        }
      } catch {
        if (alive) setLive(false);
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const cal = memory?.calibration;

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.05}>
      <div className="mb-3 flex items-center gap-2">
        <Database className="size-4 text-violet-neon" aria-hidden />
        <span className="label-tech">ENGINE MEMORY</span>
        <NeonBadge tone={live ? "violet" : "muted"} className="ml-auto">
          <LiveDot tone={live ? "violet" : "amber"} /> {live ? "VERIFIED LIVE" : "LINKING…"}
        </NeonBadge>
      </div>

      {!memory ? (
        <p className="font-terminal text-[11px] text-ink-3">— building memory object… —</p>
      ) : (
        <div className="space-y-3">
          {/* headline chips */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "RESOLVED", value: String(memory.realized.resolved), cls: "text-ink" },
              { label: "WIN RATE", value: `${memory.realized.winRate.toFixed(0)}%`, cls: memory.realized.winRate >= 50 ? "text-neon" : memory.realized.winRate >= 25 ? "text-amber-neon" : "text-danger-neon" },
              { label: "NET PNL", value: `${memory.realized.netPnlUsd >= 0 ? "+" : ""}$${memory.realized.netPnlUsd.toFixed(2)}`, cls: memory.realized.netPnlUsd >= 0 ? "text-neon" : "text-danger-neon" },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2">
                <div className="label-tech text-[9px]">{c.label}</div>
                <div className={cn("mt-0.5 font-terminal text-sm font-bold tabular-nums", c.cls)}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* per-strategy realized bars */}
          {memory.perStrategy.length > 0 && (
            <div>
              <div className="label-tech mb-1.5">REALIZED EDGE — BY STRATEGY</div>
              <div className="space-y-1.5">
                {memory.perStrategy.slice(0, 4).map((s) => (
                  <div key={s.strategy} className="flex items-center gap-2 font-terminal text-[10px]">
                    <span className="w-24 shrink-0 truncate uppercase tracking-[0.1em] text-ink-2">{s.strategy}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full bg-violet-neon"
                        style={{ width: `${Math.min(100, (s.wins / Math.max(1, s.n)) * 100)}%`, boxShadow: "0 0 6px currentColor" }}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right tabular-nums text-ink-3">
                      WR {Math.round((s.wins / Math.max(1, s.n)) * 100)}% · n={s.n}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI CALIBRATION block (R17) */}
          <div className="rounded-lg border border-[rgba(178,107,255,0.25)] bg-[rgba(178,107,255,0.05)] p-3">
            <div className="mb-2 flex items-center gap-2">
              <GraduationCap className="size-3.5 text-violet-neon" aria-hidden />
              <span className="label-tech">AI CALIBRATION</span>
              <NeonBadge tone={cal?.status === "ACTIVE" ? "neon" : cal?.status === "FROZEN" ? "violet" : "amber"} className="ml-auto">
                {cal?.status ?? "…"}
              </NeonBadge>
            </div>
            {!cal ? (
              <p className="font-terminal text-[10px] text-ink-3">— calibration state loading… —</p>
            ) : cal.status === "FROZEN" ? (
              <>
                <div className="flex items-center gap-2">
                  <ConfidenceBar value={Math.min(100, (cal.settled / Math.max(1, cal.target)) * 100)} className="flex-1" />
                  <span className="font-terminal text-[10px] font-bold tabular-nums text-violet-neon">
                    {cal.settled}/{cal.target}
                  </span>
                </div>
                <p className="mt-2 font-terminal text-[10px] leading-relaxed text-ink-3">
                  FROZEN (R3/R6) — weights locked at the epoch-2 recalibration; the freeze auto-lifts when the epoch-2 book reaches n≥{cal.target} settled (now {cal.settled}). Learned/advisor weight writes are ignored while frozen; baseline replay evidence stays live (G2).
                </p>
              </>
            ) : cal.status === "OBSERVING" ? (
              <>
                <div className="flex items-center gap-2">
                  <ConfidenceBar value={Math.min(100, (cal.settled / Math.max(1, cal.target)) * 100)} className="flex-1" />
                  <span className="font-terminal text-[10px] font-bold tabular-nums text-violet-neon">
                    {cal.settled}/{cal.target}
                  </span>
                </div>
                <p className="mt-2 font-terminal text-[10px] leading-relaxed text-ink-3">
                  OBSERVING — factor weights stay baseline until {cal.target} settled live signals. Net-PNL expectancy is recorded per strong factor vote (|vote|≥8) but never moves weights early.
                </p>
              </>
            ) : (
              <div className="space-y-1">
                {memory.realized.sampleCaveat.startsWith("LOW") && (
                  <p className="mb-1.5 font-terminal text-[10px] text-amber-neon">sample caveat still applies — weights bounded ±25%</p>
                )}
                <p className="mb-1 font-terminal text-[9px] tracking-[0.08em] text-ink-3">WEIGHTS = NET-PNL EXPECTANCY + PROFIT FACTOR (not raw WR) · ±4.5%/trade ≈ ±0.3 weight</p>
                {cal.rows.length === 0 ? (
                  <p className="font-terminal text-[10px] text-ink-3">no factor reached the n≥10 floor yet — weights baseline</p>
                ) : (
                  cal.rows.map((r) => (
                    <div key={r.factor} className="flex items-center gap-2 font-terminal text-[10px]">
                      <span className="w-28 shrink-0 truncate uppercase tracking-[0.1em] text-ink-2">{r.factor}</span>
                      <span className={cn("font-bold tabular-nums", r.weight >= 1 ? "text-neon" : "text-danger-neon")}>×{r.weight.toFixed(2)}</span>
                      <span className="ml-auto tabular-nums text-ink-3">
                        {r.avgPct !== undefined ? (
                          <>
                            <span className={r.avgPct >= 0 ? "text-neon" : "text-danger-neon"}>{r.avgPct >= 0 ? "+" : ""}{r.avgPct.toFixed(1)}%/trade</span> · ${r.pnlUsd?.toFixed(2) ?? "—"} · n={r.n}
                          </>
                        ) : (
                          <>n={r.n} · WR {r.winRate}%</>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* v9.1 — central-intelligence extensions (operator 2026-09-13):
              radar performance journal + RAW-CAL capture status — the same
              objects the analyst prompt + governor context receive */}
          {memory.pumpRadar && (
            <div className="rounded-lg border border-magenta-neon/25 bg-magenta-neon/[0.04] px-3 py-2">
              <div className="label-tech mb-1 text-magenta-neon">PUMP/DUMP RADAR JOURNAL</div>
              <p className="font-terminal text-[10px] leading-relaxed text-ink-2">{memory.pumpRadar.headline}</p>
              <p className="mt-1 font-terminal text-[9px] leading-relaxed text-ink-3">
                24H DECLARED {memory.pumpRadar.window24h.declared} · SUCCESS {memory.pumpRadar.window24h.success} · FAILURE {memory.pumpRadar.window24h.failure} · RADAR SIGNALS {memory.pumpRadar.totals.spawnedSignals} · {memory.pumpRadar.note}
              </p>
            </div>
          )}
          {memory.rawCal && (
            <div className={cn("rounded-lg border px-3 py-2", memory.rawCal.armed ? "border-amber-neon/30 bg-amber-neon/[0.05]" : "border-white/8 bg-white/[0.02]")}>
              <div className="label-tech mb-1">RAW-CAL CAPTURE · {memory.rawCal.armed ? "ARMED" : "OFF"}</div>
              <p className="font-terminal text-[10px] leading-relaxed text-ink-2">{memory.rawCal.note}</p>
              <p className="mt-1 font-terminal text-[9px] leading-relaxed text-ink-3">
                LIFETIME RAW {memory.rawCal.issuedTotal} · SETTLED {memory.rawCal.settledRaw}
                {memory.rawCal.rawWinRatePct !== null ? ` · WR ${memory.rawCal.rawWinRatePct}%` : ""} · BOOK {memory.rawCal.settledN}/{memory.rawCal.target}
              </p>
              {memory.rawCal.paceLine && (
                <p className="mt-1 font-terminal text-[9px] leading-relaxed text-amber-neon/80" title="v9.2 pace digest — issuance rhythm + book-growth watching">
                  {memory.rawCal.paceLine}
                </p>
              )}
              {memory.rawCal.qualityLine && (
                <p className="mt-1 font-terminal text-[9px] leading-relaxed text-mint-neon/80" title="v9.3 sample quality lab — is the raw cohort healthy enough for the R6 calibration to rest on">
                  {memory.rawCal.qualityLine}
                </p>
              )}
              {memory.rawCal.r6Gate && <p className="font-terminal text-[9px] leading-relaxed text-ink-3">{memory.rawCal.r6Gate}</p>}
            </div>
          )}

          {/* backtest summary if present */}
          {memory.backtest && (
            <div className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
              <div className="label-tech mb-1">LEARNER (LAST REPLAY)</div>
              <p className="font-terminal text-[10px] leading-relaxed text-ink-3">
                n={memory.backtest.n} · WR {memory.backtest.winRate}% · Wilson-LB {memory.backtest.wilsonLB}% · expectancy {memory.backtest.avgNetPct >= 0 ? "+" : ""}
                {memory.backtest.avgNetPct}%/trade
              </p>
            </div>
          )}

          <p className="font-terminal text-[9px] leading-relaxed tracking-[0.08em] text-ink-3">THE ANALYST SEES EXACTLY THIS OBJECT — {memory.dataBasis}</p>
        </div>
      )}
    </BentoCard>
  );
}
