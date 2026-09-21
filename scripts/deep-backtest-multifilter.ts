/**
 * deep-backtest-multifilter.ts — DEEPER BACKTEST (operator request #1, 2026-09-06)
 * «سیستم از چند فیلتر استفاده می‌کند؛ بک‌تست عمیق‌تر برای expectancy بالاتر»
 *
 * Beyond the MIN_SCORE sweep (verify-calibration-claim.ts), this replays the
 * system's REAL multi-filter decision surface on all settled signals:
 *   Part A — ENTRY side: 2-way+ interaction grid over the knobs the deploy gate
 *     actually uses (strategy × direction × flow-verdict × confluence-strength
 *     band × regime × confidence band), with a 60/40 TRAIN→TEST time split and
 *     Wilson 95% CI — only cells that HOLD out-of-sample are reported as edge.
 *   Part B — EXIT side (tracking/رديابی): re-prices the TP ladder policies on
 *     the same signals — ACTUAL engine ladder vs TP1-FLAT vs TP2-LET-RUN vs
 *     TP3-or-nothing — using persisted tp1/tp2/tp3 + reachedTp semantics
 *     (reachedTp≥1 ⇒ TP1 was hit BEFORE close, so the policy sim is path-safe).
 * Honest limits: no candle replay (PricePoint keeps only 48h), so SL-width
 * re-simulation is NOT possible from persisted data — noted, not faked.
 * Read-only.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

interface Row {
  strategy: string;
  direction: string;
  flow: string;
  regime: string;
  confBand: string;
  strengthBand: string;
  netPct: number;
  netUsd: number;
  tp: boolean;
  reachedTp: number;
  createdAt: Date;
  // exit-policy sim fields
  tp1Pct: number;
  tp2Pct: number;
  tp3Pct: number;
  feePct: number;
  margin: number;
}

const REGIMES = ["CHOP", "TREND-UP", "TREND-DOWN", "VOLATILE"];

function wilsonLB(k: number, n: number, z = 1.96): number {
  if (!n) return 0;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (100 * (c - m)) / d;
}

function agg(rows: Row[], label: string) {
  const n = rows.length;
  if (!n) return null;
  const exp = rows.reduce((a, r) => a + r.netPct, 0) / n;
  const wins = rows.filter((r) => r.netPct > 0).length;
  const gains = rows.filter((r) => r.netUsd > 0).reduce((a, r) => a + r.netUsd, 0);
  const losses = Math.abs(rows.filter((r) => r.netUsd < 0).reduce((a, r) => a + r.netUsd, 0));
  return {
    label, n, exp,
    wrNet: (100 * wins) / n,
    wrTp: (100 * rows.filter((r) => r.tp).length) / n,
    lb: wilsonLB(wins, n),
    sumUsd: rows.reduce((a, r) => a + r.netUsd, 0),
    pf: losses > 0 ? Math.min(99, gains / losses) : 99,
  };
}

function fmtA(a: ReturnType<typeof agg>): string {
  if (!a) return "(empty)";
  return `n=${String(a.n).padStart(3)}  exp ${a.exp >= 0 ? "+" : ""}${a.exp.toFixed(2)}%/trade  WR(net>0) ${a.wrNet.toFixed(0).padStart(3)}%  WR(TP) ${a.wrTp.toFixed(0).padStart(3)}%  CI-lb ${a.lb.toFixed(0).padStart(3)}%  Σ$${a.sumUsd.toFixed(2)}  PF ${a.pf.toFixed(2)}`;
}

async function main() {
  const all = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    orderBy: { createdAt: "asc" },
  });

  const rows: Row[] = all.map((s) => {
    const margin = Math.max(1, s.marginUsd);
    const feePct = ((s.feeUsd || 0) / margin) * 100;
    const netPct = (s.pnlPercent || 0) - feePct;
    let strength = 0;
    try {
      const votes = JSON.parse(s.factorsJson || "[]") as { vote: number }[];
      strength = Math.abs(votes.reduce((a, v) => a + (v.vote || 0), 0));
    } catch { strength = 0; }
    let flow = "OTHER";
    try {
      const f = JSON.parse(s.flowJson || "null") as { verdict?: string } | null;
      if (f?.verdict) flow = f.verdict;
    } catch { /* none */ }
    const tags = (s.tags || "").split(",").map((x) => x.trim().toUpperCase());
    const regime = tags.find((x) => REGIMES.includes(x)) ?? "UNTAGGED";
    const entry = (s.entryZoneLow + s.entryZoneHigh) / 2 || s.entryPrice;
    const lev = s.leverage || 1;
    const tpPct = (tp: number) => (s.direction === "LONG" ? ((tp - entry) / entry) * 100 * lev : ((entry - tp) / entry) * 100 * lev);
    return {
      strategy: s.strategy,
      direction: s.direction,
      flow,
      regime,
      confBand: s.confidence >= 80 ? "80+" : "<80",
      strengthBand: strength >= 55 ? "≥55" : strength >= 45 ? "45-54" : "<45",
      netPct, netUsd: (netPct / 100) * margin,
      tp: s.reachedTp >= 1,
      reachedTp: s.reachedTp,
      createdAt: s.createdAt,
      tp1Pct: tpPct(s.tp1), tp2Pct: tpPct(s.tp2), tp3Pct: tpPct(s.tp3),
      feePct, margin,
    };
  });

  console.log(`DEEP BACKTEST — ${rows.length} settled signals (${rows[0]?.createdAt.toISOString()} → ${rows[rows.length - 1]?.createdAt.toISOString()})`);
  const split = Math.floor(rows.length * 0.6);
  const train = rows.slice(0, split);
  const test = rows.slice(split);
  console.log(`split: TRAIN n=${train.length} (→ ${train[train.length - 1]?.createdAt.toISOString()}) | TEST n=${test.length} (${test[0]?.createdAt.toISOString()} →)`);
  console.log(`BASELINE  TRAIN: ${fmtA(agg(train, "train"))}`);
  console.log(`BASELINE  TEST : ${fmtA(agg(test, "test"))}`);

  // ── PART A: interaction grid over the REAL deploy-filter surface ────────
  console.log(`\n══ PART A — MULTI-FILTER INTERACTION GRID (train→test holdout) ══`);
  const cells = new Map<string, Row[]>();
  for (const r of rows) {
    // one cell per combination of the gate's live dimensions (2-way+ collapsed key)
    const key = `${r.strategy}|${r.direction}|${r.flow}|${r.strengthBand}|${r.confBand}|${r.regime}`;
    (cells.get(key) ?? cells.set(key, []).get(key)!).push(r);
  }
  const candidates: Array<{ key: string; trainAgg: ReturnType<typeof agg>; testAgg: ReturnType<typeof agg> }> = [];
  for (const [key, arr] of cells) {
    const tAgg = agg(arr.filter((r) => train.includes(r)), "t");
    const sAgg = agg(arr.filter((r) => test.includes(r)), "s");
    if (!tAgg || tAgg.n < 8 || tAgg.exp < 1.5) continue; // train gate: real n + real edge
    candidates.push({ key, trainAgg: tAgg, testAgg: sAgg });
  }
  candidates.sort((a, b) => (b.trainAgg!.exp * Math.sqrt(b.trainAgg!.n)) - (a.trainAgg!.exp * Math.sqrt(a.trainAgg!.n)));
  console.log(`cells with train n≥8 & exp≥+1.5%/trade: ${candidates.length}`);
  for (const c of candidates.slice(0, 10)) {
    const holds = c.testAgg ? c.testAgg.exp > 0 : false;
    console.log(`  ${c.key}`);
    console.log(`     TRAIN ${fmtA(c.trainAgg)}`);
    console.log(`     TEST  ${fmtA(c.testAgg)}  ${holds ? "✓ HOLDS" : "✗ fails out-of-sample"}`);
  }
  const survivors = candidates.filter((c) => c.testAgg && c.testAgg.exp > 0);
  console.log(`→ SURVIVORS (positive in BOTH halves): ${survivors.length}`);
  for (const c of survivors) {
    const pool = [...cells.get(c.key)!];
    console.log(`   ${c.key} → POOLED ${fmtA(agg(pool, "pooled"))}`);
  }

  // ── PART B: exit-ladder policy backtest (رديابی / tracking side) ─────────
  console.log(`\n══ PART B — EXIT-LADDER POLICY BACKTEST (path-safe: reachedTp proves TP1 hit before close) ══`);
  const policies: Array<{ name: string; pnl: (r: Row) => number }> = [
    { name: "ACTUAL (engine ladder + TTL)", pnl: (r) => r.netPct },
    { name: "TP1-FLAT (all out at TP1)", pnl: (r) => (r.reachedTp >= 1 ? r.tp1Pct - r.feePct : r.netPct) },
    { name: "TP2-LET-RUN (TP1 half → TP2)", pnl: (r) => (r.reachedTp >= 2 ? 0.5 * r.tp1Pct + 0.5 * r.tp2Pct - r.feePct : r.reachedTp >= 1 ? r.tp1Pct - r.feePct : r.netPct) },
    { name: "TP3-OR-NOTHING (hold runner)", pnl: (r) => (r.reachedTp >= 3 ? r.tp3Pct - r.feePct : r.netPct) },
  ];
  for (const p of policies) {
    const sim = rows.map((r) => ({ ...r, netPct: p.pnl(r) }));
    const a = agg(sim, p.name);
    // recompute netUsd for the sim
    a!.sumUsd = sim.reduce((s, r) => s + (r.netPct / 100) * r.margin, 0);
    console.log(`  ${p.name.padEnd(34)} ${fmtA(a)}`);
  }

  console.log(`\nLIMITS: SL-width re-simulation impossible (PricePoint history = 48h only); TP-fill assumes limit fill at level (no slippage).`);
  console.log(`DEEP BACKTEST COMPLETE (read-only)`);
}

main()
  .catch((e) => { console.error("DEEP BACKTEST ERROR", e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
