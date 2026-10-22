// ── FlowRadar Neo replayed-history performance learner (v5.0, server-only) ──
// FORCES the engine to learn from PAST data instead of staying static:
//   1. REPLAY  — real Binance klines candle-by-candle through the exact
//      confluence+gate scorer with the real deployment ladder + fee NET math.
//   2. AUTO-TUNE — coordinate sweep over factor weights around the current
//      baseline; adopts the best combo ONLY when it genuinely improves the
//      objective (Wilson-LB + expectancy) — otherwise the baseline stands.
//   3. LEARNING PROGRESS — every run is appended to a persistent runs ring so
//      the operator can watch WR/expectancy/Wilson-LB evolve run over run.
//   4. SCHEDULER — re-runs itself every LEARNER_AUTO_H (default 6h), so the
//      learned mean keeps moving as new history accrues.
// Its verdicts feed the LEARNED GATE that decides when live auto-signals start.
//
// ── v10.16 PARITY FIX ────────────────────────────────────────────────────
// Settlement mirrors engine.ts resolveSignals (engine.ts:439-662): tranche
// 50/30/20 (LADDER_TRANCHES, accounting.ts:47) banked at RUNG prices, BE-trail
// at TP1 (stop := entry, engine.ts:493), +1R trail at TP2 (stop := tp1 rung,
// engine.ts:489), TP3 runner priced at the deploy-time tp3 RUNG — never the old
// 2.6R-on-full-margin projection (engine.ts:597) — SL-first ordering per candle
// (engine.ts:467/474), a single feeBreakdown NET pass on the full notional with
// the tranche-weighted move (engine.ts:607, accounting.ts:49-57), the mid-ladder
// BE arm (engine.ts:508-514) and early time-exit (engine.ts:515-541) evaluated
// at the candle close, and OPEN-SYMBOL DEDUP replacing the fabricated 24h
// per-symbol cooldown (engine.ts:989+1004 — live dedups open symbols only).
// Remaining known delta: dynamic TTL-extension gate not simulated (fixed TTL =
// conservative; live gate at engine.ts:541-562).

import { db } from "@/lib/db";
import { fetchFuturesKlines, type Candle } from "./market-feed";
import { buildSnapshot, scoreConfluence, type Confluence, type FactorWeights } from "./indicators";
import { feeBreakdown, confidenceMargin, ladderWeightedMove, LADDER_TRANCHES, ACCOUNT_START_USD } from "./accounting";
import { computeCalibration, type CalibrationState } from "./calibration";
import { getGateSettings, type GateSettings } from "./gate-settings";
import type { FlowAssessment } from "./flow";

export interface BacktestTrade {
  symbol: string;
  openedAt: number;
  direction: "LONG" | "SHORT";
  score: number;
  strategy: string;
  confidence: number;
  outcome: "SL" | "TP3" | "EXPIRED";
  grossPct: number;
  netPct: number;
  netUsd: number;
  heldMin: number;
  votes: Array<{ factor: string; vote: number }>;
}

export interface BacktestResult {
  ranAt: string;
  engine: string;
  label: string;
  symbolsScanned: string[];
  candlesPerSymbol: number;
  spanHours: number;
  candidatesEvaluated: number;
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  wilsonLB: number;
  avgNetPct: number;
  expectancyR: number;
  totalNetUsd: number;
  equityEnd: number;
  byStrategy: Array<{ strategy: string; n: number; wins: number; avgNetPct: number }>;
  factorLessons: Array<{ factor: string; n: number; winRate: number }>;
  equityCurve: Array<{ i: number; equity: number }>;
  trades: BacktestTrade[];
  verdict: string;
  calibration: Pick<CalibrationState, "status" | "settled" | "target">;
  weightsUsed: Record<string, number> | null;
  minScoreAdj: number;
  objective: number;
}

export interface AutoTuneState {
  adoptedAt: string | null;
  adoptedWeights: Record<string, number> | null;
  baselineObjective: number;
  bestObjective: number;
  bestCombo: Record<string, number> | null;
  trials: number;
  adopted: boolean;
  lastRunAt: string | null;
  history: Array<{ at: string; adopted: boolean; baseline: number; best: number; delta: number; summary: string }>;
}

export interface BacktestRunRow {
  ranAt: string;
  label: string;
  n: number;
  winRate: number;
  wilsonLB: number;
  avgNetPct: number;
  equityEnd: number;
  objective: number;
  adopted: boolean | null;
}

export interface BacktestBundle {
  result: BacktestResult | null;
  runs: BacktestRunRow[];
  autotune: AutoTuneState | null;
}

const INTERVAL = "15m";
const CANDLES = 500; // ~5.2 days per symbol
const WARMUP = 60;
const BASE_STEP = 2; // baseline evaluates every 2nd candle (30min grid)
const SWEEP_STEP = 4; // sweeps use a coarser grid (60min) for speed
const TTL_MIN: Record<string, number> = { "AI-SCALP": 75, BREAKOUT: 120, MOMENTUM: 150, "MEAN-REVERT": 90, "AI-SWING": 240 };

const KEY_BT = "backtest";
const KEY_RUNS = "backtest.runs";
const KEY_AT = "backtest.autotune";

// ── kline cache: every sweep reuses ONE fetch per symbol ──────
const klineCache = new Map<string, { at: number; candles: Candle[] }>();
const KLINE_TTL = 10 * 60_000;

async function primeKlines(symbols: string[]): Promise<string[]> {
  const ok: string[] = [];
  for (const s of symbols) {
    const hit = klineCache.get(s);
    if (hit && Date.now() - hit.at < KLINE_TTL) {
      ok.push(s);
      continue;
    }
    try {
      const candles = await fetchFuturesKlines(s, INTERVAL, CANDLES);
      klineCache.set(s, { at: Date.now(), candles });
      ok.push(s);
    } catch {
      /* skip symbol this run */
    }
  }
  return ok;
}

function wilsonLowerBound(wins: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom) * 100;
}

/** learner objective: Wilson-LB dominates, expectancy breaks ties, small-n disqualified. */
function objectiveOf(res: BacktestResult): number {
  if (res.n < 12) return -999;
  return res.wilsonLB + Math.max(-15, Math.min(20, res.avgNetPct * 10));
}

// v10.16: exported (pure — no db/network) so the parity settlement can be
// sanity-checked in isolation; nothing else consumes it.
export interface SimResult {
  outcome: BacktestTrade["outcome"];
  movePct: number; // UNLEVERED tranche-weighted move % — the live finalMovePct (engine.ts:584-606)
  lev: number;
  heldMin: number;
  reachedTp: number; // 0..3 banked rungs — live TP-PROVEN ledger (engine.ts:469-472)
  exitIdx: number; // resolution candle index — anchors the open-symbol dedup window
}

/** Knobs the pure settlement needs from the live gate (passed in, never fetched). */
export interface SimGateCtx {
  margin: number; // position margin — the live BE-arm NET check reads the real margin (engine.ts:456+510)
  gate: Pick<GateSettings, "beTrailPct" | "beArmMovePct" | "beArmRMult" | "beBankFrac" | "earlyExitGuard" | "earlyExitFrac" | "earlyExitR">;
}

/** Walk forward candles with the LIVE v6.6 settlement rules (parity — engine.ts resolveSignals 439-662):
 * SL-first ordering, 50/30/20 tranche banking at rung prices, BE-trail at TP1 (stop := entry),
 * +1R trail at TP2 (stop := tp1 rung), TP3 runner priced at the deploy-time tp3 rung, mid-ladder
 * BE arm, early time-exit, TTL expiry at the closing mark. Each branch cites its live line. */
export function simulate(candles: Candle[], entryIdx: number, dir: "LONG" | "SHORT", entry: number, sl: number, tp1: number, tp2: number, tp3: number, ttlCandles: number, ctx: SimGateCtx): SimResult {
  const isLong = dir === "LONG";
  const slDist = Math.abs(entry - sl) / entry;
  const lev = Math.round(Math.min(20, Math.max(5, 60 / Math.max(0.7, slDist * 100)))); // mirror engine leverage pick
  const rGross = slDist * 100 * lev; // 1R in levered %-on-margin — engine.ts:533 (rAnchor = initialStopLoss = deploy stop `sl`)
  const moveAtPct = (px: number): number => ((px - entry) / entry) * (isLong ? 1 : -1) * 100; // UNLEVERED — engine.ts:584
  const ttlMinutes = ttlCandles * 15;

  let stop = sl; // EFFECTIVE (trailed) stop — v5.4 semantics: trailed stops are real (engine.ts:461, 477-481)
  let reachedTp = 0; // TP-PROVEN ledger (engine.ts:469-472)
  let beBank: { frac: number; movePct: number } | null = null; // v11.2 BE-BANK — parity with the live ledger (engine.ts resolveSignals)

  // ── v6.6 TRANCHE-AWARE NET ACCOUNTING (arithmetic copied verbatim from engine.ts:569-607) ──
  function finalize(outcome: BacktestTrade["outcome"], exitIdx: number, mark: number): SimResult {
    let finalMovePct: number;
    // v11.2 BE-BANK tranche — parity with engine.ts settlement: the banked leg
    // exits at its arm mark, the ladder weights scale by 1−frac so tranches
    // still sum to 1. Legacy rows (never banked) keep the exact old math.
    const remain = beBank ? 1 - beBank.frac : 1;
    if (reachedTp >= 1) {
      // TRANCHES FIRST — 50%/30% already left the book at their RUNG prices while
      // the trade was open; the runner leg exits by final status: TP3 → tp3 rung
      // (a deploy-time price stop moves can never touch) · SL → EFFECTIVE (trailed)
      // stop · EXPIRED → closing mark (engine.ts:592-601).
      const runnerMove = outcome === "TP3" ? moveAtPct(tp3) : outcome === "SL" ? moveAtPct(stop) : moveAtPct(mark);
      const tranches: Array<{ weight: number; movePct: number }> = [];
      if (beBank) tranches.push({ weight: beBank.frac, movePct: beBank.movePct });
      tranches.push({ weight: LADDER_TRANCHES.tp1 * remain, movePct: moveAtPct(tp1) });
      if (reachedTp >= 2) tranches.push({ weight: LADDER_TRANCHES.tp2 * remain, movePct: moveAtPct(tp2) });
      tranches.push({ weight: (1 - LADDER_TRANCHES.tp1 - LADDER_TRANCHES.tp2) * remain, movePct: runnerMove });
      finalMovePct = ladderWeightedMove(tranches);
    } else if (beBank) {
      // BE-banked, no rung — bank leg @ arm mark + remainder at the real exit
      // (SL → the post-arm stop at entry · EXPIRED → the closing mark).
      finalMovePct = ladderWeightedMove([
        { weight: beBank.frac, movePct: beBank.movePct },
        { weight: remain, movePct: outcome === "SL" ? moveAtPct(stop) : moveAtPct(mark) },
      ]);
    } else if (outcome === "SL") {
      finalMovePct = moveAtPct(stop); // effective (trailed) stop is the real exit — nothing was banked (engine.ts:602-603)
    } else {
      finalMovePct = moveAtPct(mark); // EXPIRED without a banked rung — mark on full margin (engine.ts:604-605)
    }
    return { outcome, movePct: finalMovePct, lev, heldMin: (exitIdx - entryIdx) * 15, reachedTp, exitIdx };
  }

  for (let j = entryIdx + 1; j < candles.length && j <= entryIdx + ttlCandles; j++) {
    const c = candles[j]!;
    const heldMin = (j - entryIdx) * 15;

    // ① SL FIRST — live evaluates hitSl before every TP branch in the same tick
    // (engine.ts:467 + 474). Within one 15m candle the intracandle order is
    // unknowable; the mandated conservative reading stops the trade first.
    // The runner (plus any unbanked margin) exits at the EFFECTIVE stop, which
    // may already be BE/+1R after trails (engine.ts:479, 597, 603).
    if (isLong ? c.low <= stop : c.high >= stop) return finalize("SL", j, stop);

    // ② TP ladder — banks price at RUNG levels exactly like the live ledger
    // (engine.ts:598-600). A tp3 touch geometrically implies tp1+tp2 were touched
    // (same-side extremes), so reachedTp=3 prices all three legs below.
    if (isLong ? c.high >= tp3 : c.low <= tp3) {
      reachedTp = 3;
      return finalize("TP3", j, tp3); // runner exits at the tp3 RUNG — engine.ts:597
    }
    if (isLong ? c.high >= tp2 : c.low <= tp2) {
      reachedTp = 2; // TP1 leg banked earlier or same candle — both legs priced in finalize
      stop = tp1; // v5.4: trail to the TP1 RUNG = the announced +1R lock (engine.ts:489; tp1 = entry ± 1×risk, engine.ts:1515)
    } else if (isLong ? c.high >= tp1 : c.low <= tp1) {
      reachedTp = 1;
      stop = entry; // v5.4: breakeven trail enforced at TP1 (engine.ts:493)
    }

    // ③ mid-ladder BE arm / ④ early time-exit — only while UNBANKED (live
    // requires s.status === "ACTIVE", engine.ts:508 + 527). Mark-based checks
    // evaluate at the candle CLOSE — the coarse-grained analogue of the live
    // 3.5s tick. Live orders these as one else-if chain per tick (508 → 515).
    if (reachedTp === 0) {
      const closeMovePct = moveAtPct(c.close);
      const stillUntrailed = isLong ? stop < entry : stop > entry; // engine.ts:509
      if (
        stillUntrailed &&
        ((ctx.gate.beArmRMult > 0 && slDist * 100 > 0 && closeMovePct >= ctx.gate.beArmRMult * slDist * 100) ||
          (ctx.gate.beArmMovePct > 0 && closeMovePct >= ctx.gate.beArmMovePct) ||
          (ctx.gate.beTrailPct > 0 && feeBreakdown(ctx.margin, lev, closeMovePct, heldMin).netPct >= ctx.gate.beTrailPct))
      ) {
        // v11.2 STRUCTURAL R-ARM + BE-BANK (engine.ts:699-738): primary trigger
        // = the trade's own risk geometry (price ≥ beArmRMult × slDist), the
        // absolute-price arm stays as the wide-stop ceiling, the legacy NET arm
        // stays governor-available. The bank tranche is captured at the arm
        // CLOSE mark (candle-close analogue of the live 3.5s tick mark).
        stop = entry;
        if (ctx.gate.beBankFrac > 0) beBank = { frac: ctx.gate.beBankFrac, movePct: closeMovePct };
      } else if (ctx.gate.earlyExitGuard > 0 && heldMin >= ctx.gate.earlyExitFrac * ttlMinutes) {
        // v8.4 R2/R7 EARLY TIME-EXIT (engine.ts:515-541): an unbanked trade after
        // earlyExitFrac of TTL closes at the mark when ADVERSE (NET ≤ −earlyExitR × 1R)
        // or STALLED (|gross| ≤ 0.15R) — booked EXPIRED, not ridden to −1R.
        const fb = feeBreakdown(ctx.margin, lev, closeMovePct, heldMin);
        const adverse = ctx.gate.earlyExitR > 0 && fb.netPct <= -(ctx.gate.earlyExitR * rGross);
        const stalled = Math.abs(closeMovePct * lev) <= 0.15 * rGross;
        if (adverse || stalled) return finalize("EXPIRED", j, c.close);
      }
    }
  }

  // ⑤ TTL expiry — auto-close at the closing mark (engine.ts:541-567 + 597/605).
  // KNOWN DELTA: the live DYNAMIC EXPIRY GATE (TTL extensions, engine.ts:541-562)
  // is not simulated — fixed TTL is the conservative bound.
  const endIdx = Math.min(candles.length - 1, entryIdx + ttlCandles);
  return finalize("EXPIRED", endIdx, candles[endIdx]!.close);
}

export interface BacktestOpts {
  symbolsOverride?: string[];
  weights?: FactorWeights | null;
  minScoreAdj?: number;
  step?: number;
  label?: string;
  persist?: boolean;
}

export async function runBacktest(opts: BacktestOpts = {}): Promise<BacktestResult> {
  const t0 = Date.now();
  const persist = opts.persist !== false;
  const step = opts.step ?? BASE_STEP;
  const gate = await getGateSettings();
  const cal = await computeCalibration();

  const assets = await db.marketAsset.findMany({ orderBy: { volume24h: "desc" }, take: 12 });
  const wanted = (opts.symbolsOverride?.length ? opts.symbolsOverride : assets.map((a) => a.symbol)).slice(0, 12);
  const symbols = await primeKlines(wanted);

  const weights: FactorWeights | null = opts.weights ?? (Object.keys(cal.weights).length ? cal.weights : null);
  const minScore = Math.max(15, Math.min(65, gate.minScore + (opts.minScoreAdj ?? 0)));

  const trades: BacktestTrade[] = [];
  let candidatesEvaluated = 0;
  let equity = ACCOUNT_START_USD;
  const equityCurve: Array<{ i: number; equity: number }> = [{ i: 0, equity }];
  const factorAcc = new Map<string, { wins: number; n: number }>();
  let candlesPerSymbol = 0;
  let spanHours = 0;

  for (const symbol of symbols) {
    const candles = klineCache.get(symbol)?.candles;
    if (!candles || candles.length < WARMUP + 30) continue;
    candlesPerSymbol = candles.length;
    spanHours = Math.max(spanHours, (candles[candles.length - 1]!.openTime - candles[0]!.openTime) / 3600_000);
    // v10.16: open-symbol dedup window for THIS symbol (per-symbol scope, like the
    // live openSymbols set — engine.ts:989)
    let openUntilIdx = -1;

    for (let i = WARMUP; i < candles.length - 5; i += step) {
      const c = candles[i]!;
      // v10.16 OPEN-SYMBOL DEDUP (parity — engine.ts:989 openSymbols fetch +
      // :1004 `if (openSymbols.has(asset.symbol)) return false`, applied at the
      // scan pool BEFORE scoring): a candidate is skipped while its symbol already
      // carries an open simulated position. The previous 24h per-symbol cooldown
      // was FABRICATED — the live engine has no such rule — and it throttled the
      // replay sample ~24× per symbol.
      if (i <= openUntilIdx) continue;
      const snap = buildSnapshot(symbol, candles.slice(0, i + 1));
      if (!snap) continue;
      const conf: Confluence = scoreConfluence(snap, weights ?? undefined);
      candidatesEvaluated++;
      if (Math.abs(conf.score) < minScore) continue;

      // simulate the ladder
      const isLong = conf.direction === "LONG";
      const entry = c.close;
      const slDistPct = Math.min(4.5, Math.max(0.7, 1.5 * snap.atrPct)) / 100;
      const sl = entry * (isLong ? 1 - slDistPct : 1 + slDistPct);
      const risk = Math.abs(entry - sl);
      const tp1 = isLong ? entry + risk : entry - risk;
      const tp2 = isLong ? entry + risk * 1.8 : entry - risk * 1.8;
      const tp3 = isLong ? entry + risk * 2.6 : entry - risk * 2.6;
      const ttlCandles = Math.round((TTL_MIN[conf.strategy] ?? 120) / 15);

      // margin sized BEFORE the walk — the live mid-trade BE-arm reads the real
      // position margin for its NET check (engine.ts:456 + :510)
      const margin = confidenceMargin(conf.confidence, equity, equity * 0.9);
      const sim = simulate(candles, i, conf.direction, entry, sl, tp1, tp2, tp3, ttlCandles, { margin, gate });
      // v10.16: the symbol stays dedup-blocked until the simulated position resolves
      openUntilIdx = sim.exitIdx;

      // fee-aware NET on a running $100 equity account — ONE feeBreakdown pass on
      // the FULL notional with the tranche-weighted move (engine.ts:607; the three
      // exit fills sum to one position, so commission/swap totals are unchanged —
      // accounting.ts:49-57). sim.movePct = UNLEVERED weighted move.
      const lev = sim.lev;
      const fb = feeBreakdown(margin, lev, sim.movePct, sim.heldMin);
      equity += fb.netUsd;
      equityCurve.push({ i: trades.length + 1, equity: Number(equity.toFixed(2)) });

      // win stays NET-based (exported stat semantics unchanged); with tranche
      // accounting a TP1-banked round-trip now nets ≈ +0.5R−fees like live. Note:
      // live regime telemetry additionally counts any reachedTp≥1 close as a win
      // (engine.ts:615) — the backtest WR deliberately keeps its NET definition.
      const win = fb.netPct > 0;
      for (const v of conf.votes) {
        if (Math.abs(v.vote) < 8) continue;
        const cell = factorAcc.get(v.factor) ?? { wins: 0, n: 0 };
        cell.n++;
        if (win) cell.wins++;
        factorAcc.set(v.factor, cell);
      }

      trades.push({
        symbol,
        openedAt: c.openTime,
        direction: conf.direction,
        score: conf.score,
        strategy: conf.strategy,
        confidence: conf.confidence,
        outcome: sim.outcome,
        grossPct: Number((sim.movePct * sim.lev).toFixed(2)),
        netPct: Number(fb.netPct.toFixed(2)),
        netUsd: Number(fb.netUsd.toFixed(3)),
        heldMin: sim.heldMin,
        votes: conf.votes.map((v) => ({ factor: v.factor, vote: v.vote })),
      });

      // v10.16: NO per-symbol cooldown — live re-deploys as soon as the symbol has
      // no open position (engine.ts:1004 dedups OPEN symbols only).
    }
  }

  const n = trades.length;
  const wins = trades.filter((t) => t.netPct > 0).length;
  const losses = n - wins;
  const winRate = n ? (wins / n) * 100 : 0;
  const avgNetPct = n ? trades.reduce((a, t) => a + t.netPct, 0) / n : 0;
  const expectancyR = n ? trades.reduce((a, t) => a + t.netPct / 100, 0) / n : 0;
  const wilsonLB = wilsonLowerBound(wins, n);

  const stratAcc = new Map<string, { n: number; wins: number; net: number }>();
  for (const t of trades) {
    const cell = stratAcc.get(t.strategy) ?? { n: 0, wins: 0, net: 0 };
    cell.n++;
    if (t.netPct > 0) cell.wins++;
    cell.net += t.netPct;
    stratAcc.set(t.strategy, cell);
  }

  const factorLessons = [...factorAcc.entries()]
    .filter(([, c]) => c.n >= 5)
    .map(([factor, c]) => ({ factor, n: c.n, winRate: Number(((c.wins / c.n) * 100).toFixed(1)) }))
    .sort((a, b) => b.winRate - a.winRate);

  const byStrategy = [...stratAcc.entries()].map(([strategy, c]) => ({ strategy, c0: c.n, c1: c.wins, c2: Number((c.net / c.n).toFixed(2)) })).sort((a, b) => b.c0 - a.c0).map(({ strategy, c0, c1, c2 }) => ({ strategy, n: c0, wins: c1, avgNetPct: c2 }));

  const verdict =
    n === 0
      ? `NO QUALIFYING SETUPS in the replayed window — minScore ${minScore} too strict for this volatility regime`
      : wilsonLB >= 45 && avgNetPct > 0
        ? `LEARNED EDGE CONFIRMED — WR ${winRate.toFixed(0)}% (Wilson-LB ${wilsonLB.toFixed(0)}%) · expectancy ${avgNetPct.toFixed(2)}%/trade NET — live auto-deployment UNLOCKED by the learned gate`
        : wilsonLB >= 40
          ? `MARGINAL — WR ${winRate.toFixed(0)}% (LB ${wilsonLB.toFixed(0)}%), expectancy ${avgNetPct.toFixed(2)}%/trade — auto-deploy stays gated, keep observing`
          : `NO LEARNED EDGE — WR ${winRate.toFixed(0)}% (LB ${wilsonLB.toFixed(0)}%), expectancy ${avgNetPct.toFixed(2)}%/trade NET — live auto-deployment stays SUPPRESSED until recalibration`;

  const objective = objectiveOf({ n, wilsonLB, avgNetPct } as BacktestResult);

  const result: BacktestResult = {
    ranAt: new Date().toISOString(),
    engine: "FLOWRADAR-NEO v5.1 BACKTEST & LEARNER",
    label: opts.label ?? (persist ? "REPLAY" : "sweep"),
    symbolsScanned: symbols,
    candlesPerSymbol,
    spanHours: Number(spanHours.toFixed(1)),
    candidatesEvaluated,
    n,
    wins,
    losses,
    winRate: Number(winRate.toFixed(1)),
    wilsonLB: Number(wilsonLB.toFixed(1)),
    avgNetPct: Number(avgNetPct.toFixed(2)),
    expectancyR: Number(expectancyR.toFixed(3)),
    totalNetUsd: Number((equity - ACCOUNT_START_USD).toFixed(2)),
    equityEnd: Number(equity.toFixed(2)),
    byStrategy,
    factorLessons,
    equityCurve: equityCurve.slice(-64),
    trades: persist ? trades.slice(-24).reverse() : [],
    verdict,
    calibration: { status: cal.status, settled: cal.settled, target: cal.target },
    weightsUsed: weights ? Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, Number(v.toFixed(3))])) : null,
    minScoreAdj: opts.minScoreAdj ?? 0,
    objective: Number(objective.toFixed(1)),
  };

  if (persist) {
    await db.engineSetting.upsert({ where: { key: KEY_BT }, create: { key: KEY_BT, value: JSON.stringify(result) }, update: { value: JSON.stringify(result) } });
    const runs = await getRuns();
    runs.unshift({ ranAt: result.ranAt, label: result.label, n, winRate: result.winRate, wilsonLB: result.wilsonLB, avgNetPct: result.avgNetPct, equityEnd: result.equityEnd, objective: result.objective, adopted: null });
    await db.engineSetting.upsert({ where: { key: KEY_RUNS }, create: { key: KEY_RUNS, value: JSON.stringify(runs.slice(0, 14)) }, update: { value: JSON.stringify(runs.slice(0, 14)) } });
  }

  console.log(`[backtest] v5.1 ${result.label} done in ${Date.now() - t0}ms — ${n} sim trades from ${candidatesEvaluated} candidates (step=${step}, minScore=${minScore}) · objective ${result.objective}`);
  return result;
}

// ── AUTO-TUNE: coordinate sweep that can actually IMPROVE the engine ──
const TUNED_FACTORS = ["EMA STACK", "MACD MOMENTUM", "RANGE BREAKOUT", "RSI POSITION"];
const SWEEP_VALUES = [0.75, 0.9, 1.1, 1.25];
const ADOPT_MARGIN = 3; // best must beat baseline objective by ≥3
let autotuneInFlight = false;

export function isAutotuneRunning(): boolean {
  return autotuneInFlight;
}

export async function runAutotune(): Promise<{ baseline: BacktestResult; best: BacktestResult | null; adopted: boolean; trials: number; delta: number }> {
  if (autotuneInFlight) throw new Error("auto-tune already running");
  autotuneInFlight = true;
  try {
    // baseline on the full grid with current effective weights
    const baseline = await runBacktest({ label: "AUTO-TUNE BASELINE", persist: true });
    const baseWeights: FactorWeights = baseline.weightsUsed ?? {};
    const baseObj = objectiveOf(baseline);

    let best: BacktestResult | null = null;
    let bestCombo: Record<string, number> | null = null;
    let trials = 0;

    for (const factor of TUNED_FACTORS) {
      for (const val of SWEEP_VALUES) {
        // skip combos that equal the untouched baseline weight (1.0 excluded by grid)
        const combo: FactorWeights = { ...baseWeights, [factor]: val };
        const res = await runBacktest({ label: `SWEEP ${factor}×${val}`, weights: combo, step: SWEEP_STEP, persist: false });
        trials++;
        if (!best || objectiveOf(res) > objectiveOf(best)) {
          best = res;
          bestCombo = combo;
        }
      }
    }

    const bestObj = best ? objectiveOf(best) : -999;
    const delta = Number((bestObj - baseObj).toFixed(1));
    const adopt = best !== null && bestObj >= baseObj + ADOPT_MARGIN && best.n >= baseline.n * 0.8;

    let at = await getAutotune();
    if (!at) {
      at = { adoptedAt: null, adoptedWeights: null, baselineObjective: baseObj, bestObjective: bestObj, bestCombo: null, trials, adopted: false, lastRunAt: new Date().toISOString(), history: [] };
    }
    at.baselineObjective = Number(baseObj.toFixed(1));
    at.bestObjective = Number(bestObj.toFixed(1));
    at.bestCombo = adopt ? Object.fromEntries(Object.entries(bestCombo!).map(([k, v]) => [k, Number(v.toFixed(3))])) : at.bestCombo;
    at.trials = trials;
    at.adopted = adopt;
    at.lastRunAt = new Date().toISOString();
    if (adopt) at.adoptedAt = at.lastRunAt;
    if (adopt && bestCombo) at.adoptedWeights = Object.fromEntries(Object.entries(bestCombo).map(([k, v]) => [k, Number(v.toFixed(3))]));
    at.history.unshift({
      at: at.lastRunAt,
      adopted: adopt,
      baseline: at.baselineObjective,
      best: at.bestObjective,
      delta,
      summary: adopt
        ? `ADOPTED — ${TUNED_FACTORS.filter((f) => at!.adoptedWeights?.[f] !== undefined && at!.adoptedWeights![f] !== baseWeights[f]).map((f) => `${f}×${at!.adoptedWeights![f]!.toFixed(2)}`).join(" ")} — objective ${baseObj.toFixed(1)}→${bestObj.toFixed(1)}`
        : `NO ADOPTION — best sweep objective ${bestObj.toFixed(1)} < baseline ${baseObj.toFixed(1)} + ${ADOPT_MARGIN} margin; baseline stands`,
    });
    at.history = at.history.slice(0, 8);

    await db.engineSetting.upsert({ where: { key: KEY_AT }, create: { key: KEY_AT, value: JSON.stringify(at) }, update: { value: JSON.stringify(at) } });

    // mark the adopted flag on the newest runs rows
    const runs = await getRuns();
    if (runs[0]) runs[0].adopted = adopt;
    await db.engineSetting.upsert({ where: { key: KEY_RUNS }, create: { key: KEY_RUNS, value: JSON.stringify(runs.slice(0, 14)) }, update: { value: JSON.stringify(runs.slice(0, 14)) } });

    console.log(`[backtest:autotune] trials=${trials} baseline=${baseObj.toFixed(1)} best=${bestObj.toFixed(1)} adopted=${adopt}`);
    return { baseline, best, adopted: adopt, trials, delta };
  } finally {
    autotuneInFlight = false;
  }
}

export async function getAutotune(): Promise<AutoTuneState | null> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY_AT } });
    return row ? (JSON.parse(row.value) as AutoTuneState) : null;
  } catch {
    return null;
  }
}

export async function getRuns(): Promise<BacktestRunRow[]> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY_RUNS } });
    return row ? (JSON.parse(row.value) as BacktestRunRow[]) : [];
  } catch {
    return [];
  }
}

export async function getBacktestBundle(): Promise<BacktestBundle> {
  const [result, runs, autotune] = await Promise.all([getBacktest(), getRuns(), getAutotune()]);
  return { result, runs, autotune };
}

export async function getBacktest(): Promise<BacktestResult | null> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY_BT } });
    return row ? (JSON.parse(row.value) as BacktestResult) : null;
  } catch {
    return null;
  }
}

// ── SCHEDULER: the learner re-runs itself so the mean never goes stale ──
// v6.0 FULL AUTONOMY: the scheduler is ALWAYS ON — the pre-v6 manual
// enable/disable toggle (`setLearnerAuto`) was removed with the operator
// mandate «هیچ حالت دستی برای یادگیری و استقرار نباید باشه». Only the cadence
// (intervalHours) is configurable, and the stored config can never disable it.
const AUTO_KEY = "learner.auto";
const KEY_BASELINE = "learner.baseline"; // v8.4.1 G2 — frozen-mode baseline replay clock
let autoInFlight = false;
let autoLastAt = 0;
const AUTO_MIN_INTERVAL_MS = 60_000; // DB guard between checks

export interface LearnerAutoState {
  enabled: boolean;
  intervalHours: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  running: boolean;
}

async function getAutoCfg(): Promise<{ enabled: true; intervalHours: number }> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: AUTO_KEY } });
    if (row) {
      const v = JSON.parse(row.value) as { enabled: boolean; intervalHours: number };
      // enabled is FORCED true — a stale persisted pause can never freeze learning
      return { enabled: true, intervalHours: Math.min(24, Math.max(1, Number(v.intervalHours) || 6)) };
    }
  } catch {
    /* defaults */
  }
  return { enabled: true, intervalHours: 6 };
}

export async function getLearnerAutoState(): Promise<LearnerAutoState> {
  const cfg = await getAutoCfg();
  const at = await getAutotune();
  const last = at?.lastRunAt ?? null;
  const next = last ? new Date(new Date(last).getTime() + cfg.intervalHours * 3600_000).toISOString() : null;
  return { ...cfg, lastRunAt: last, nextRunAt: next, running: autoInFlight };
}

/** Called by the engine tick — throttled; fires a full baseline+autotune in the background. */
export async function maybeAutoLearner(): Promise<void> {
  if (autoInFlight) return;
  if (Date.now() - autoLastAt < AUTO_MIN_INTERVAL_MS) return;
  autoLastAt = Date.now();
  const cfg = await getAutoCfg();
  if (!cfg.enabled) return;
  const at = await getAutotune();
  if (at?.lastRunAt && Date.now() - new Date(at.lastRunAt).getTime() < cfg.intervalHours * 3600_000) return;

  autoInFlight = true;
  void (async () => {
    try {
      // v9.0 LIFECYCLE LEARNING (operator request 2026-09-12): TTL-extension,
      // BE-trail and afterlife outcomes are now measured + persisted on every
      // learner cadence — the evidence the governor/advisor read. Self-throttled
      // inside the module (5h floor); failure never blocks the learner.
      void import("./lifecycle-learning").then((m) => m.recordLifecycleLearning()).catch((e) => console.error("[lifecycle-learning]", e));

      // v8.4 R6 + v8.4.1 G2 (operator mandate 2026-09-11): while the calibration
      // freeze is ON, autotune ADOPTION stays pointless — getEffectiveWeights
      // ignores adopted weights until the epoch-2 book reaches n≥100. BUT the
      // baseline backtest REPLAY must keep running: learnedGateAllows() consumes
      // it as the second gate-evidence path, and a stale replay froze that path
      // shut too (the deadlock). Decoupled: frozen → baseline replay refreshes
      // on its own 6h clock (KEY_BASELINE), sweep+adoption stay suspended.
      const frozen = await db.engineSetting.findUnique({ where: { key: "calibration.frozen" } }).then((r) => (r ? (JSON.parse(r.value) as { frozen: boolean }).frozen : false)).catch(() => false);
      if (frozen) {
        const lastBase = await db.engineSetting.findUnique({ where: { key: KEY_BASELINE } }).then((r) => (r ? (JSON.parse(r.value) as { at: string }).at : null)).catch(() => null);
        if (lastBase && Date.now() - new Date(lastBase).getTime() < cfg.intervalHours * 3600_000) return;
        const baseline = await runBacktest({ label: "AUTO-BASELINE (FROZEN)", persist: true });
        await db.engineSetting.upsert({ where: { key: KEY_BASELINE }, create: { key: KEY_BASELINE, value: JSON.stringify({ at: new Date().toISOString() }) }, update: { value: JSON.stringify({ at: new Date().toISOString() }) } });
        await import("./engine").then((m) =>
          m.fireEvent(null, null, "ENGINE", "info", `AUTO-LEARNER (frozen, R6/G2): baseline replay refreshed — ${baseline.n} sim trades, objective ${baseline.objective}, WR ${baseline.winRate}% (LB ${baseline.wilsonLB?.toFixed(0) ?? "--"}%) — sweep + weight adoption stay SUSPENDED until n≥100; gate evidence stays live.`),
        );
        return;
      }
      const { baseline, adopted, delta } = await runAutotune();
      await import("./engine").then((m) =>
        m.fireEvent(null, null, "ENGINE", "ai", `AUTO-LEARNER (6h cycle): replay ${baseline.n} sim trades — objective ${baseline.objective}; auto-tune ${adopted ? `ADOPTED improved weights (Δ+${delta})` : `kept baseline (best sweep Δ${delta >= 0 ? "+" : ""}${delta})`} — learned mean refreshed`),
      );
    } catch (err) {
      console.error("[auto-learner]", err);
    } finally {
      autoInFlight = false;
    }
  })();
}

/** Learned gate: does past performance justify live auto-deployment?
 * v8.4.1 G1 (operator mandate 2026-09-11 «اقدامات بعدی رو کامل و مهندسی انجام بده»):
 * realized WR is now measured over the CURRENT ledger epoch (EPOCH-2 tags) with
 * a ROLLING window of the last 30 settles. The old cumulative all-time book
 * mixed pre-audit geometry (WR poison) into the gate and — combined with the
 * R6 freeze skipping autotune sweeps — deadlocked auto-deployment forever
 * (no deploys → WR can never rise → no deploys). The gate must judge the NEW
 * engine on the NEW book; old rows roll OUT of the window as new ones land. */
const LEARNED_GATE_WINDOW = 30;
const SETTLED_IN = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] as const;

export async function learnedGateAllows(): Promise<{ allowed: boolean; reason: string }> {
  const bt = await getBacktest();
  const rows = await db.signal.findMany({
    where: { status: { in: [...SETTLED_IN] }, tags: { contains: "EPOCH-2" } },
    orderBy: { createdAt: "desc" },
    take: LEARNED_GATE_WINDOW,
    select: { pnlPercent: true },
  });
  const settled = rows.length;
  const wins = rows.filter((r) => r.pnlPercent > 0).length;
  const realizedWr = settled >= 1 ? (wins / settled) * 100 : 0;
  if (settled >= 8 && realizedWr >= 25)
    return { allowed: true, reason: `realized WR ${realizedWr.toFixed(0)}% over ${settled} EPOCH-2 settles (rolling window ${LEARNED_GATE_WINDOW}) — above 25% floor` };
  if (bt && bt.n >= 20 && bt.wilsonLB >= 45 && bt.avgNetPct > 0)
    return { allowed: true, reason: `backtest learner: WR ${bt.winRate}% (Wilson-LB ${bt.wilsonLB}%, n=${bt.n}) — learned edge confirmed` };
  if (settled < 8 && (!bt || bt.n < 20))
    return { allowed: false, reason: `insufficient evidence — ${settled}/8 EPOCH-2 settles, ${bt?.n ?? 0}/20 backtest trades` };
  return { allowed: false, reason: `learned performance below threshold — realized WR ${realizedWr.toFixed(0)}% (${settled} EPOCH-2 rolling), backtest LB ${bt?.wilsonLB.toFixed(0) ?? "--"}%` };
}

export type { FlowAssessment };
