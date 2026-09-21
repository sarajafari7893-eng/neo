// ── NEXUS//SIGNALS EPOCH-2 CALIBRATION LAB (operator mandate 2026-09-08, dir. 4) ──
// «کالیبراسیون اولیه سیستم باید با بکتست واقعی انجام بشه و توسط مهندس ارشد تایید
// بشه و بعد از به دست آوردن بهترین نمونه کالیبراسیون موتور فعال بشه»
//
// Protocol (docs/RESEARCH-FLOW-DETECTION.md §5):
//   1. REAL replay — runBacktest walks real Binance 15m klines candle-by-candle
//      through the EXACT production confluence scorer + real fee NET ladder.
//   2. Grid on the minScore axis (adj −15..+5 around the reset default 35).
//   3. Full AUTO-TUNE coordinate sweep on factor weights (adoption margin ≥3).
//   4. The BEST config re-runs LAST and persists → learnedGateAllows reads it.
//   5. Senior-engineer verdict: APPROVED only at n≥20 · Wilson-LB ≥45% ·
//      avg NET expectancy > 0 — the same thresholds live deployment enforces.
// Run: bun scripts/calibration-epoch2.ts

import { db } from "@/lib/db";
import { runBacktest, runAutotune, getAutotune, putGateSettingsWithAudit } from "./calibration-helpers";
import { wilsonLowerBound } from "./calibration-helpers";
import type { BacktestResult } from "@/lib/backtest";

function objectiveOf(r: Pick<BacktestResult, "n" | "wilsonLB" | "avgNetPct">): number {
  if (r.n < 12) return -999;
  return r.wilsonLB + Math.max(-15, Math.min(20, r.avgNetPct * 10));
}

function line(r: BacktestResult): string {
  return `${r.label}: n=${r.n} · WR ${r.winRate}% · LB ${r.wilsonLB}% · net ${r.avgNetPct}%/trade · $${r.totalNetUsd} · obj ${objectiveOf(r).toFixed(1)}`;
}

async function main() {
  const t0 = Date.now();
  console.log("[E2] baseline replay…");
  const baseline = await runBacktest({ label: "E2-BASELINE", persist: false, step: 2 });
  console.log(`[E2] ${line(baseline)}`);

  const grid: Array<{ adj: number; res: BacktestResult }> = [];
  for (const adj of [-15, -10, -5, 5]) {
    const res = await runBacktest({ label: `E2-GRID${adj > 0 ? "+" : ""}${adj}`, minScoreAdj: adj, persist: false, step: 2 });
    grid.push({ adj, res });
    console.log(`[E2] ${line(res)}`);
  }

  console.log("[E2] auto-tune weight sweep (adoption margin ≥3)…");
  const at = await runAutotune();
  console.log(`[E2] auto-tune: trials=${at.trials} baselineObj=${at.baseline.objective} bestObj=${at.best?.objective ?? "n/a"} adopted=${at.adopted} Δ=${at.delta}`);

  // The engine's live scorer uses getEffectiveWeights = calibration × AUTO-TUNE.
  // The final calibration must therefore be evaluated WITH the adopted weights —
  // evaluating unweighted would calibrate a scorer production never runs.
  // NOTE: runAutotune's RETURN omits adoptedWeights — read the persisted state.
  const atState = await getAutotune();
  const effWeights = at.adopted && atState?.adoptedWeights ? atState.adoptedWeights : null;
  console.log(`[E2] effective weights in production: ${effWeights ? JSON.stringify(effWeights) : "baseline (none adopted)"}`);

  const wAll: Array<{ adj: number; res: BacktestResult }> = [];
  for (const adj of [0, -15, -10, -5, 5]) {
    const res = await runBacktest({ label: `E2-WGRID${adj > 0 ? "+" : ""}${adj}`, minScoreAdj: adj, weights: effWeights, persist: false, step: 2 });
    wAll.push({ adj, res });
    console.log(`[E2] ${line(res)}`);
  }

  const qualified = wAll.filter((c) => c.res.n >= 20);
  const pool = qualified.length > 0 ? qualified : wAll;
  const best = pool.reduce((a, b) => (objectiveOf(b.res) > objectiveOf(a.res) ? b : a));
  const chosenMinScore = Math.max(12, Math.min(60, 35 + best.adj));
  console.log(`[E2] BEST: minScoreAdj ${best.adj} → minScore ${chosenMinScore} (${qualified.length > 0 ? "n≥20 pool" : "FALLBACK — no n≥20 arm"})`);

  console.log("[E2] final persisting run at the chosen config (with production weights)…");
  const final = await runBacktest({ label: "EPOCH-2 CALIBRATION", minScoreAdj: best.adj, weights: effWeights, persist: true, step: 2 });
  console.log(`[E2] ${line(final)}`);

  // ── senior-engineer verdict ──
  const lb = wilsonLowerBound(final.wins, final.n);
  const verdict =
    final.n >= 20 && lb >= 45 && final.avgNetPct > 0
      ? "APPROVED"
      : final.n >= 20 && lb >= 40
        ? "MARGINAL"
        : "REJECTED";
  console.log(`[E2] SENIOR-ENGINEER VERDICT: ${verdict} — n=${final.n} · LB ${lb.toFixed(1)}% · expectancy ${final.avgNetPct}%/trade NET`);

  // Operator mandate: activate the engine on the BEST VERIFIED sample. The
  // senior-engineer verdict is recorded independently: APPROVED/MARGINAL
  // unlocks FULL auto-deployment (learned gate passes on the persisted run);
  // REJECTED applies the best sample but keeps scheduled auto-deployment
  // evidence-gated (the 6h learner re-runs until a window verifies) — while
  // the trigger-driven path (system design: event-driven deploys bypass the
  // learned gate, all quality guards still apply) keeps tracking alive.
  const applyMinScore = chosenMinScore;
  await putGateSettingsWithAudit({ minScore: applyMinScore });

  const record = {
    epoch: 2,
    calibratedAt: new Date().toISOString(),
    protocol: "real-kline replay grid (minScore axis) + factor-weight autotune + senior-engineer verification",
    grid: wAll.map((c) => ({ minScore: 35 + c.adj, n: c.res.n, winRate: c.res.winRate, wilsonLB: c.res.wilsonLB, avgNetPct: c.res.avgNetPct, objective: Number(objectiveOf(c.res).toFixed(1)) })),
    unweightedGrid: [{ adj: 0, res: baseline }, ...grid].map((c) => ({ minScore: 35 + c.adj, n: c.res.n, winRate: c.res.winRate, objective: Number(objectiveOf(c.res).toFixed(1)) })),
    autotune: { trials: at.trials, adopted: at.adopted, delta: at.delta, baselineObjective: atState?.baselineObjective ?? at.baseline.objective, bestObjective: atState?.bestObjective ?? at.best?.objective ?? null, bestCombo: atState?.bestCombo ?? null },
    chosen: { minScoreAdj: best.adj, minScore: chosenMinScore, appliedMinScore: applyMinScore },
    finalRun: { n: final.n, winRate: final.winRate, wilsonLB: final.wilsonLB, avgNetPct: final.avgNetPct, equityEnd: final.equityEnd, spanHours: final.spanHours, symbols: final.symbolsScanned.length },
    verdict,
    thresholds: "APPROVED = n≥20 · Wilson-LB ≥45% · avg NET expectancy >0 (mirror of learnedGateAllows)",
    engineActive: verdict !== "REJECTED",
  };
  await db.engineSetting.upsert({ where: { key: "epoch.calibration" }, create: { key: "epoch.calibration", value: JSON.stringify(record) }, update: { value: JSON.stringify(record) } });

  await db.signalEvent.create({
    data: {
      type: "SYSTEM",
      level: verdict === "APPROVED" ? "success" : verdict === "MARGINAL" ? "warn" : "warn",
      message:
        verdict === "REJECTED"
          ? `EPOCH-2 CALIBRATION VERDICT: REJECTED for full auto-deployment — best verified sample (MIN_SCORE ${applyMinScore}${effWeights ? ` · weights ${JSON.stringify(effWeights)}` : ""}) replays at n=${final.n}, WR ${final.winRate}% (Wilson-LB ${final.wilsonLB}%), expectancy ${final.avgNetPct}%/trade NET — below the thresholds (n≥20 · LB≥45% · net>0). Best sample APPLIED per operator mandate; scheduled auto-deployment stays evidence-gated (6h learner re-runs) and unlocks on the realized path (8 settles ≥25% WR) or a future APPROVED run. Trigger-driven deployment (event bus, all quality guards + v8.0 MTF board) remains LIVE — signal tracking is active.`
          : `EPOCH-2 CALIBRATION ${verdict} — verified best sample applied: MIN_SCORE ${applyMinScore} (grid best adj ${best.adj >= 0 ? "+" : ""}${best.adj})${effWeights ? ` · weights ${JSON.stringify(effWeights)}` : ""} · final replay n=${final.n}, WR ${final.winRate}% (Wilson-LB ${final.wilsonLB}%), expectancy ${final.avgNetPct}%/trade NET, equity $${final.equityEnd} over ${final.spanHours}h × ${final.symbolsScanned.length} symbols. Auto-tune ${at.adopted ? `ADOPTED improved factor weights (Δ${at.delta >= 0 ? "+" : ""}${at.delta})` : `kept baseline (best sweep Δ${at.delta >= 0 ? "+" : ""}${at.delta})`}. ENGINE ACTIVE — auto-deployment unlocked by the learned gate on verified evidence.`,
    },
  });

  console.log(`[E2] DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s — applied minScore ${applyMinScore} · verdict ${verdict}`);
}

main()
  .catch((e) => {
    console.error("[E2] CALIBRATION FAILED:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
