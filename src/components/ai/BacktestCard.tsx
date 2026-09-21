"use client";

// ── v6.0 BACKTEST & LEARNER — the self-running learner ──
// FULL AUTONOMY (operator mandate: no manual learning modes): the scheduler is
// ALWAYS ON — history replay + 16-trial auto-tune sweep fire automatically and
// adopt only genuine improvements. The manual RUN REPLAY / AUTO-TUNE / ON-OFF
// controls were removed; this card is a read-only window into the evolving
// learned mean.
// 1. REPLAY: engine replays real past klines through its own scorer/ladder/fees
// 2. AUTO-TUNE: coordinate weight sweep — adopts only on genuine improvement
// 3. LEARNING PROGRESS: persistent runs ring — the mean evolves run over run
// 4. SCHEDULER: re-runs itself every N hours (uninterruptible)

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, GraduationCap, SlidersHorizontal, TrendingUp, HelpCircle, Timer, Infinity as InfinityIcon } from "lucide-react";
import { BentoCard, ConfidenceBar, LiveDot, NeonBadge, Sparkline } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";
import type { BacktestBundle } from "@/lib/backtest";
import type { BacktestResult } from "@/lib/backtest";

interface LearnerState {
  enabled: boolean;
  intervalHours: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  running: boolean;
}

function outcomeTone(o: string): string {
  if (o === "TP3") return "text-neon";
  if (o === "SL") return "text-danger-neon";
  return "text-amber-neon"; // EXPIRED
}

const FACTOR_KEYS = ["EMA STACK", "MACD MOMENTUM", "RANGE BREAKOUT", "RSI POSITION"] as const;

export default function BacktestCard() {
  const [bundle, setBundle] = useState<BacktestBundle | null>(null);
  const [learner, setLearner] = useState<LearnerState | null>(null);
  const [fetching, setFetching] = useState(true);
  const [showHow, setShowHow] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const res = await fetch("/api/backtest", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as BacktestBundle & { learner: LearnerState };
        setBundle({ result: data.result, runs: data.runs ?? [], autotune: data.autotune });
        setLearner(data.learner ?? null);
      }
    } catch {
      /* card shows empty state */
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
    const t = setInterval(() => void fetchAll(), 120_000);
    return () => clearInterval(t);
  }, [fetchAll]);

  const result = bundle?.result ?? null;
  const at = bundle?.autotune ?? null;
  const runs = bundle?.runs ?? [];

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.08}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FlaskConical className="size-4 text-cyan-neon" aria-hidden />
        <div>
          <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">BACKTEST &amp; LEARNER</h3>
          <p className="label-tech mt-0.5">replayed-history performance learner · v6.0 · self-running</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {result && (
            <NeonBadge tone={result.wilsonLB >= 45 ? "neon" : "amber"} glow={result.wilsonLB >= 45}>
              <LiveDot tone={result.wilsonLB >= 45 ? "neon" : "amber"} /> {result.wilsonLB >= 45 ? "EDGE CONFIRMED" : "OBSERVING"}
            </NeonBadge>
          )}
          <NeonBadge tone="cyan" glow>
            <InfinityIcon className="size-3" aria-hidden /> FULLY AUTONOMOUS
          </NeonBadge>
        </div>
      </div>

      {/* HOW IT WORKS — explainer (Q1) */}
      <div className="mb-3">
        <button
          type="button"
          onClick={() => setShowHow((s) => !s)}
          aria-expanded={showHow}
          className="flex min-h-8 items-center gap-1.5 font-terminal text-[10px] font-bold uppercase tracking-[0.14em] text-ink-3 transition-colors hover:text-cyan-neon focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
        >
          <HelpCircle className="size-3.5" aria-hidden />
          {showHow ? "HIDE MECHANISM" : "HOW IT WORKS — is it static?"}
        </button>
        {showHow && (
          <div className="mt-2 space-y-1.5 rounded-lg border border-white/8 bg-white/[0.02] p-3 font-terminal text-[10px] leading-relaxed text-ink-2">
            <p><span className="text-cyan-neon">1 · REPLAY</span> — the engine scores ~5 days of real 15m klines per symbol through ITS OWN scorer, deployment ladder and fee math. Nothing simulated-by-hand; the same code path that trades live.</p>
            <p><span className="text-violet-neon">2 · AUTO-TUNE</span> — after every baseline, a coordinate sweep tries factor-weight variants (×0.75…×1.25 on the 4 heaviest factors). Adoption ONLY when the objective (Wilson-LB + expectancy) beats baseline by ≥3 — otherwise the baseline stands. Adopted weights multiply into live scoring.</p>
            <p><span className="text-neon">3 · LEARNING PROGRESS</span> — every run lands in a persistent ring (below) so the learned mean visibly EVOLVES; it is never a fixed constant.</p>
            <p><span className="text-amber-neon">4 · SCHEDULER</span> — auto re-run every {learner?.intervalHours ?? 6}h, so new history keeps recalibrating the verdict that feeds the LEARNED GATE (auto-deploy unlocks at Wilson-LB ≥ 45%).</p>
          </div>
        )}
      </div>

      {!result && fetching && <p className="font-terminal text-[11px] text-ink-3">— loading last learner run… —</p>}

      {!result && !fetching && (
        <div className="rounded-lg border border-white/8 bg-white/[0.02] p-4">
          <p className="font-terminal text-[11px] leading-relaxed text-ink-3">
            The learner runs ITSELF — its always-on scheduler replays history through the real scorer and sweeps factor weights every {learner?.intervalHours ?? 6}h without any operator trigger. The LEARNED GATE uses this evidence to decide when live auto-deployment starts.
          </p>
        </div>
      )}

      {result && (
        <div className="space-y-3">
          {/* learned-mean headline */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "SIM TRADES", value: String(result.n), cls: "text-ink" },
              { label: "WIN RATE", value: `${result.winRate.toFixed(0)}%`, cls: result.winRate >= 50 ? "text-neon" : result.winRate >= 40 ? "text-amber-neon" : "text-danger-neon" },
              { label: "WILSON LB", value: `${result.wilsonLB.toFixed(0)}%`, cls: result.wilsonLB >= 45 ? "text-neon" : "text-amber-neon" },
              { label: "EXPECTANCY", value: `${result.avgNetPct >= 0 ? "+" : ""}${result.avgNetPct.toFixed(2)}%`, cls: result.avgNetPct >= 0 ? "text-neon" : "text-danger-neon" },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                <div className="label-tech">{c.label}</div>
                <div className={cn("mt-1 font-terminal text-lg font-bold tabular-nums", c.cls)}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* verdict */}
          <div className="flex items-start gap-2 rounded-lg border border-[rgba(69,240,223,0.25)] bg-[rgba(69,240,223,0.05)] px-3 py-2.5">
            <GraduationCap className="mt-0.5 size-4 shrink-0 text-cyan-neon" aria-hidden />
            <p className="font-terminal text-[11px] leading-relaxed text-cyan-neon/90">{result.verdict}</p>
          </div>

          {/* meta line */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-terminal text-[10px] tracking-[0.12em] text-ink-3">
            <span>{result.symbolsScanned.length} SYMBOLS</span>
            <span>·</span>
            <span>{result.candlesPerSymbol}×15m CANDLES/SYMBOL (~{result.spanHours.toFixed(0)}H)</span>
            <span>·</span>
            <span>{result.candidatesEvaluated} CANDIDATES</span>
            <span>·</span>
            <span>EQUITY→${result.equityEnd.toFixed(2)}</span>
            <span>·</span>
            <span>{result.ranAt.slice(11, 16)}Z</span>
          </div>

          {/* AUTO-TUNER block (Q1: what does it do after backtesting to improve?) */}
          <div className="rounded-lg border border-[rgba(178,107,255,0.25)] bg-[rgba(178,107,255,0.04)] p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <SlidersHorizontal className="size-3.5 text-violet-neon" aria-hidden />
              <span className="label-tech">Auto-Tuner</span>
              {at?.adopted ? (
                <NeonBadge tone="violet" glow>
                  <LiveDot tone="violet" /> WEIGHTS ADOPTED
                </NeonBadge>
              ) : at ? (
                <NeonBadge tone="muted">BASELINE STANDS</NeonBadge>
              ) : (
                <NeonBadge tone="muted">NOT RUN YET</NeonBadge>
              )}
              {at?.lastRunAt && <span className="ml-auto font-terminal text-[9px] text-ink-3">{at.lastRunAt.slice(11, 16)}Z · {at.trials} trials</span>}
            </div>
            {at ? (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded border border-white/8 bg-white/[0.02] px-2 py-1.5">
                    <div className="label-tech text-[9px]">BASELINE OBJ</div>
                    <div className="font-terminal text-sm font-bold tabular-nums text-ink">{at.baselineObjective.toFixed(1)}</div>
                  </div>
                  <div className="rounded border border-white/8 bg-white/[0.02] px-2 py-1.5">
                    <div className="label-tech text-[9px]">BEST SWEEP</div>
                    <div className={cn("font-terminal text-sm font-bold tabular-nums", at.bestObjective > at.baselineObjective ? "text-neon" : "text-ink-2")}>{at.bestObjective.toFixed(1)}</div>
                  </div>
                  <div className="rounded border border-white/8 bg-white/[0.02] px-2 py-1.5">
                    <div className="label-tech text-[9px]">Δ OBJECTIVE</div>
                    <div className={cn("font-terminal text-sm font-bold tabular-nums", at.bestObjective - at.baselineObjective >= 3 ? "text-neon" : "text-ink-2")}>{(at.bestObjective - at.baselineObjective).toFixed(1)}</div>
                  </div>
                  <div className="rounded border border-white/8 bg-white/[0.02] px-2 py-1.5">
                    <div className="label-tech text-[9px]">ADOPT MARGIN</div>
                    <div className="font-terminal text-sm font-bold tabular-nums text-ink-2">≥ +3.0</div>
                  </div>
                </div>
                {at.adoptedWeights && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {FACTOR_KEYS.map((f) => {
                      const w = at.adoptedWeights?.[f];
                      if (w === undefined) return null;
                      const stronger = w > 1;
                      return (
                        <span key={f} title={`${f} weight multiplier`} className={cn("rounded border px-2 py-0.5 font-terminal text-[9px] font-bold tracking-[0.08em]", stronger ? "border-[rgb(var(--neon-rgb)/0.4)] text-neon" : "border-[rgba(255,179,71,0.4)] text-amber-neon")}>
                          {f} ×{w.toFixed(2)}
                        </span>
                      );
                    })}
                    <span className="font-terminal text-[9px] leading-5 text-ink-3">→ multiply into live confluence scoring (clamped ×0.7–1.3)</span>
                  </div>
                )}
                {at.history[0] && <p className="mt-2 font-terminal text-[9px] leading-relaxed text-ink-3">{at.history[0].summary}</p>}
              </>
            ) : (
              <p className="font-terminal text-[10px] leading-relaxed text-ink-3">
                AUTO-TUNE sweeps 16 factor-weight variants against the baseline and adopts only a genuine improvement — the engine&apos;s weights are NOT static.
              </p>
            )}
          </div>

          {/* LEARNING PROGRESS — runs ring (proof it is not fixed) */}
          {runs.length > 1 && (
            <div className="rounded-lg border border-white/8 bg-white/[0.02] p-3">
              <div className="mb-2 flex items-center gap-2">
                <TrendingUp className="size-3.5 text-neon" aria-hidden />
                <span className="label-tech">Learning Progress</span>
                <span className="ml-auto font-terminal text-[9px] text-ink-3">{runs.length} runs stored · Wilson-LB trend</span>
              </div>
              <Sparkline data={runs.map((r) => r.wilsonLB).reverse()} width={260} height={36} tone="neon" fill={false} className="h-9 w-full" />
              <div className="mt-2 max-h-28 space-y-1 overflow-y-auto pr-1">
                {[...runs].reverse().slice(-6).map((r, i) => (
                  <div key={`${r.ranAt}-${i}`} className="flex items-center gap-2 font-terminal text-[9px] tabular-nums">
                    <span className="text-ink-3">{r.ranAt.slice(5, 16).replace("T", " ")}</span>
                    <span className="w-24 shrink-0 truncate uppercase tracking-[0.08em] text-ink-3">{r.label}</span>
                    <span className="text-ink-2">{r.n}t</span>
                    <span className={cn(r.winRate >= 50 ? "text-neon" : r.winRate >= 40 ? "text-amber-neon" : "text-danger-neon")}>WR {r.winRate.toFixed(0)}%</span>
                    <span className="text-ink-2">LB {r.wilsonLB.toFixed(0)}%</span>
                    <span className={cn("ml-auto", r.avgNetPct >= 0 ? "text-neon" : "text-danger-neon")}>{r.avgNetPct >= 0 ? "+" : ""}{r.avgNetPct.toFixed(2)}%</span>
                    {r.adopted === true && <span className="rounded bg-[rgba(178,107,255,0.15)] px-1 font-bold text-violet-neon">ADOPT</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* scheduler row — autonomous, no toggle (v6.0) */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
            <Timer className="size-3.5 text-amber-neon" aria-hidden />
            <span className="label-tech">Auto Re-Run</span>
            <span className="font-terminal text-[10px] text-ink-2">
              always-on · every {learner?.intervalHours ?? 6}h{learner?.nextRunAt ? ` · next ${learner.nextRunAt.slice(11, 16)}Z` : ""}
              {learner?.running ? " · RUNNING…" : ""}
            </span>
            <span className="ml-auto flex min-h-9 items-center rounded border border-neon/50 bg-neon/10 px-2.5 font-terminal text-[9px] font-bold uppercase tracking-[0.12em] text-neon">
              <LiveDot tone="neon" /> UNINTERRUPTIBLE
            </span>
          </div>

          {/* equity curve + strategy split */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-white/8 bg-white/[0.02] p-3">
              <div className="label-tech mb-2">REPLAY EQUITY (NET, $100 start)</div>
              <Sparkline data={result.equityCurve.map((p) => p.equity)} width={240} height={40} tone="cyan" fill={false} className="h-10 w-full" />
            </div>
            <div className="rounded-lg border border-white/8 bg-white/[0.02] p-3">
              <div className="label-tech mb-2">BY STRATEGY</div>
              <div className="space-y-1.5">
                {result.byStrategy.slice(0, 4).map((s) => (
                  <div key={s.strategy} className="flex items-center gap-2 font-terminal text-[10px]">
                    <span className="w-24 shrink-0 truncate uppercase tracking-[0.1em] text-ink-2">{s.strategy}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                      <div className="h-full rounded-full bg-violet-neon" style={{ width: `${Math.min(100, (s.n / Math.max(1, result.byStrategy[0]?.n ?? 1)) * 100)}%`, boxShadow: "0 0 6px currentColor" }} />
                    </div>
                    <span className="w-20 shrink-0 text-right tabular-nums text-ink-3">
                      {s.n}·{s.avgNetPct >= 0 ? "+" : ""}
                      {s.avgNetPct.toFixed(1)}%
                    </span>
                  </div>
                ))}
                {result.byStrategy.length === 0 && <p className="font-terminal text-[10px] text-ink-3">no simulated deployments</p>}
              </div>
            </div>
          </div>

          {/* factor lessons */}
          {result.factorLessons.length > 0 && (
            <div className="rounded-lg border border-white/8 bg-white/[0.02] p-3">
              <div className="label-tech mb-2">FACTOR LESSONS (strong votes only)</div>
              <div className="flex flex-wrap gap-1.5">
                {result.factorLessons.slice(0, 6).map((f) => (
                  <span
                    key={f.factor}
                    title={`n=${f.n}`}
                    className={cn(
                      "rounded border px-2 py-0.5 font-terminal text-[10px] font-bold tracking-[0.08em]",
                      f.winRate >= 50 ? "border-[rgb(var(--neon-rgb)/0.4)] text-neon" : "border-white/10 text-ink-3"
                    )}
                  >
                    {f.factor} {f.winRate.toFixed(0)}%
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* last trades table */}
          {result.trades.length > 0 && (
            <div className="max-h-44 overflow-y-auto rounded-lg border border-white/8">
              <table className="w-full font-terminal text-[10px]">
                <thead className="sticky top-0 bg-[rgba(0,0,0,0.5)] backdrop-blur">
                  <tr className="text-left text-ink-3">
                    <th className="px-2 py-1.5 font-medium tracking-[0.12em]">SYMBOL</th>
                    <th className="px-2 py-1.5 font-medium tracking-[0.12em]">DIR</th>
                    <th className="px-2 py-1.5 font-medium tracking-[0.12em]">SCORE</th>
                    <th className="px-2 py-1.5 font-medium tracking-[0.12em]">OUTCOME</th>
                    <th className="px-2 py-1.5 text-right font-medium tracking-[0.12em]">NET %</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.slice(0, 12).map((t, i) => (
                    <tr key={`${t.symbol}-${t.openedAt}-${i}`} className="border-t border-white/5 text-ink-2">
                      <td className="px-2 py-1.5 font-bold text-ink">{t.symbol.replace("USDT", "")}</td>
                      <td className={cn("px-2 py-1.5", t.direction === "LONG" ? "text-neon" : "text-magenta-neon")}>{t.direction}</td>
                      <td className="px-2 py-1.5 tabular-nums">{t.score}</td>
                      <td className={cn("px-2 py-1.5 font-bold", outcomeTone(t.outcome))}>{t.outcome.replace("_", " ")}</td>
                      <td className={cn("px-2 py-1.5 text-right tabular-nums font-bold", t.netPct >= 0 ? "text-neon" : "text-danger-neon")}>
                        {t.netPct >= 0 ? "+" : ""}
                        {t.netPct.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="label-tech">LEARNED-GATE STATUS</span>
            <ConfidenceBar value={Math.min(100, result.wilsonLB)} className="max-w-40" />
            <span className="font-terminal text-[10px] text-ink-3">Wilson-LB → auto-deploy unlocks ≥45%</span>
          </div>
        </div>
      )}
    </BentoCard>
  );
}
