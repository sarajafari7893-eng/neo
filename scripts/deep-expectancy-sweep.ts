/**
 * deep-expectancy-sweep.ts — DEEPER MULTI-FILTER BACKTEST (operator Q1)
 * «معیار بکتست فقط MIN_SCORE نبود — سیستم از چند فیلتر استفاده می‌کند؛
 *  بکتست عمیق‌تر بگیر تا expectancy بالاتر پیدا کنیم»
 *
 * Joint grid over the SIX deploy-time filter dimensions the engine actually uses
 * (confluence strength, flow verdict, direction, strategy, timeframe, regime —
 * regime parsed correctly from REGIME-* tags, which the earlier audit missed),
 * ranked by EXPECTANCY (not WR). Includes:
 *   · single-dimension sweeps for readability
 *   · full joint enumeration (n≥20 / n≥30 cells)
 *   · chronological split-half validation — in-sample winners that die
 *     out-of-sample are flagged, so we don't hand the governor curve-fit noise
 * Honest limitation (stated, not hidden): SL width / RR scale / TTL knobs are
 * outcome-level parameters — replaying them needs candle-level re-simulation
 * (that is what the engine's own auto-tune backtest does; governor ran it 21:24Z).
 * Read-only against DB.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

interface Row {
  strategy: string;
  direction: string;
  timeframe: string;
  regime: string;
  flowConfirm: boolean;
  strength: number;
  netPct: number;
  netUsd: number;
  tp: boolean;
  createdAt: Date;
}

interface Cell {
  key: string;
  n: number;
  wr: number;
  exp: number;
  sumUsd: number;
  pf: number;
  ciLo: number;
  ciHi: number;
}

function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [100 * Math.max(0, (c - m) / d), 100 * Math.min(1, (c + m) / d)];
}

function cellOf(rows: Row[], key: string): Cell | null {
  const n = rows.length;
  if (!n) return null;
  const wins = rows.filter((r) => r.tp).length;
  const exp = rows.reduce((a, r) => a + r.netPct, 0) / n;
  const gains = rows.filter((r) => r.netUsd > 0).reduce((a, r) => a + r.netUsd, 0);
  const losses = Math.abs(rows.filter((r) => r.netUsd < 0).reduce((a, r) => a + r.netUsd, 0));
  const [ciLo, ciHi] = wilson(wins, n);
  return {
    key, n,
    wr: (100 * wins) / n,
    exp,
    sumUsd: rows.reduce((a, r) => a + r.netUsd, 0),
    pf: losses > 0 ? Math.min(99, gains / losses) : 99,
    ciLo, ciHi,
  };
}

function fmt(c: Cell): string {
  return `n=${String(c.n).padStart(3)}  WR ${c.wr.toFixed(0).padStart(3)}%  CI[${c.ciLo.toFixed(0)}–${c.ciHi.toFixed(0)}]  exp ${c.exp >= 0 ? "+" : ""}${c.exp.toFixed(2)}%/trade  Σ$${c.sumUsd.toFixed(2)}  PF ${c.pf.toFixed(2)}`;
}

// ── the six filter dimensions, each as an ordered list of refinements ──
const STRENGTH = [["str:any", 0], ["str:≥40", 40], ["str:≥45", 45], ["str:≥50", 50], ["str:≥55", 55]] as const;
const FLOW = [["flow:any", false], ["flow:CONFIRM", true]] as const;
const DIR = [["dir:both", "both"], ["dir:LONG", "LONG"], ["dir:SHORT", "SHORT"]] as const;
const STRATS: Array<[string, (s: string) => boolean]> = [
  ["strat:any", () => true],
  ["strat:SWING", (s) => s === "AI-SWING"],
  ["strat:SWING+SCALP", (s) => s === "AI-SWING" || s === "AI-SCALP"],
  ["strat:noBREAKOUT", (s) => s !== "BREAKOUT"],
];
const TFS: Array<[string, (t: string) => boolean]> = [
  ["tf:any", () => true],
  ["tf:15m", (t) => t === "15m"],
  ["tf:1h", (t) => t === "1h"],
  ["tf:4h", (t) => t === "4h"],
  ["tf:no5m", (t) => t !== "5m"],
];
const REGIMES: Array<[string, (r: string) => boolean]> = [
  ["reg:any", () => true],
  ["reg:noCHOP", (r) => r !== "CHOP"],
  ["reg:TRENDonly", (r) => r === "TREND-UP" || r === "TREND-DOWN"],
  ["reg:noCHOPnoUNK", (r) => r !== "CHOP" && r !== "UNKNOWN" && r !== "MISSING"],
];

function passes(r: Row, minStr: number, needFlow: boolean, dir: string, stratOk: (s: string) => boolean, tfOk: (t: string) => boolean, regOk: (x: string) => boolean): boolean {
  return r.strength >= minStr && (!needFlow || r.flowConfirm) && (dir === "both" || r.direction === dir) && stratOk(r.strategy) && tfOk(r.timeframe) && regOk(r.regime);
}

async function main() {
  const all = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    orderBy: { createdAt: "asc" },
  });

  const rows: Row[] = all.map((s) => {
    const margin = Math.max(1, s.marginUsd);
    const netPct = (s.pnlPercent || 0) - ((s.feeUsd || 0) / margin) * 100;
    let strength = 0;
    try {
      const votes = JSON.parse(s.factorsJson || "[]") as { vote: number }[];
      strength = Math.abs(votes.reduce((a, v) => a + (v.vote || 0), 0));
    } catch { strength = 0; }
    const tags = (s.tags || "").split(",").map((t) => t.trim().toUpperCase());
    const rawReg = tags.find((t) => t.startsWith("REGIME-"));
    const regName = rawReg ? rawReg.replace(/^REGIME-/, "") : "MISSING";
    return {
      strategy: s.strategy,
      direction: s.direction,
      timeframe: s.timeframe,
      regime: ["CHOP", "TREND-UP", "TREND-DOWN", "VOLATILE"].includes(regName) ? regName : regName === "UNKNOWN" ? "UNKNOWN" : "MISSING",
      flowConfirm: tags.includes("FLOW-CONFIRM"),
      strength,
      netPct,
      netUsd: (netPct / 100) * margin,
      tp: s.reachedTp >= 1,
      createdAt: s.createdAt,
    };
  });

  const base = cellOf(rows, "ALL");
  if (!base) throw new Error("no settled signals");
  console.log(`DEEP EXPECTANCY SWEEP — ${rows.length} settled · baseline: ${fmt(base)}`);
  const regCounts = new Map<string, number>();
  for (const r of rows) regCounts.set(r.regime, (regCounts.get(r.regime) ?? 0) + 1);
  console.log(`regime parse (fixed): ${[...regCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  const flowCount = rows.filter((r) => r.flowConfirm).length;
  console.log(`FLOW-CONFIRM tags: ${flowCount}/${rows.length}`);

  // ── 1. single-dimension sweeps ──
  console.log(`\n── single dimensions (each vs baseline exp ${base.exp.toFixed(2)}%/trade) ──`);
  for (const [label, min] of STRENGTH) { const c = cellOf(rows.filter((r) => r.strength >= min), label); if (c) console.log(`  ${label.padEnd(16)} ${fmt(c)}`); }
  for (const [label, need] of FLOW) { const c = cellOf(rows.filter((r) => !need || r.flowConfirm), label); if (c) console.log(`  ${label.padEnd(16)} ${fmt(c)}`); }
  for (const [label, d] of DIR) { const c = cellOf(rows.filter((r) => d === "both" || r.direction === d), label); if (c) console.log(`  ${label.padEnd(16)} ${fmt(c)}`); }
  for (const [label, ok] of STRATS) { const c = cellOf(rows.filter((r) => ok(r.strategy)), label); if (c) console.log(`  ${label.padEnd(16)} ${fmt(c)}`); }
  for (const [label, ok] of TFS) { const c = cellOf(rows.filter((r) => ok(r.timeframe)), label); if (c) console.log(`  ${label.padEnd(16)} ${fmt(c)}`); }
  for (const [label, ok] of REGIMES) { const c = cellOf(rows.filter((r) => ok(r.regime)), label); if (c) console.log(`  ${label.padEnd(16)} ${fmt(c)}`); }

  // ── 2. full joint enumeration ──
  const cells: Cell[] = [];
  for (const [sLbl, minS] of STRENGTH)
    for (const [fLbl, needF] of FLOW)
      for (const [dLbl, d] of DIR)
        for (const [stLbl, stOk] of STRATS)
          for (const [tfLbl, tfOk] of TFS)
            for (const [rLbl, rOk] of REGIMES) {
              const sub = rows.filter((r) => passes(r, minS, needF, d, stOk, tfOk, rOk));
              const c = cellOf(sub, `${sLbl}+${fLbl}+${dLbl}+${stLbl}+${tfLbl}+${rLbl}`);
              if (c) cells.push(c);
            }
  console.log(`\n── joint grid: ${cells.length} cells enumerated ──`);
  for (const minN of [20, 30]) {
    const pool = cells.filter((c) => c.n >= minN);
    console.log(`  ── top-8 by EXPECTANCY among n≥${minN} (pool ${pool.length}):`);
    for (const c of pool.sort((a, b) => b.exp - a.exp).slice(0, 8)) console.log(`    ${c.key.padEnd(58)} ${fmt(c)}`);
  }

  // ── 3. split-half validation (60/40 chronological) ──
  console.log(`\n── SPLIT-HALF VALIDATION (build on first 60%, test on last 40%) ──`);
  const cut = Math.floor(rows.length * 0.6);
  const h1 = rows.slice(0, cut);
  const h2 = rows.slice(cut);
  const h1Cells: Cell[] = [];
  for (const [sLbl, minS] of STRENGTH)
    for (const [fLbl, needF] of FLOW)
      for (const [dLbl, d] of DIR)
        for (const [stLbl, stOk] of STRATS)
          for (const [tfLbl, tfOk] of TFS)
            for (const [rLbl, rOk] of REGIMES) {
              const sub = h1.filter((r) => passes(r, minS, needF, d, stOk, tfOk, rOk));
              const c = cellOf(sub, `${sLbl}+${fLbl}+${dLbl}+${stLbl}+${tfLbl}+${rLbl}`);
              if (c && c.n >= 15) h1Cells.push(c);
            }
  const topH1 = h1Cells.sort((a, b) => b.exp - a.exp).slice(0, 5);
  // recover predicates from labels
  const find = <T,>(list: ReadonlyArray<readonly [string, T]>, label: string): T => list.find(([l]) => label === l)![1];
  for (const c of topH1) {
    const [sLbl, fLbl, dLbl, stLbl, tfLbl, rLbl] = c.key.split("+");
    const minS = find(STRENGTH, sLbl), needF = find(FLOW, fLbl), d = find(DIR, dLbl);
    const stOk = STRATS.find(([l]) => l === stLbl)![1], tfOk = TFS.find(([l]) => l === tfLbl)![1], rOk = REGIMES.find(([l]) => l === rLbl)![1];
    const sel2 = h2.filter((r) => passes(r, minS, needF, d, stOk, tfOk, rOk));
    const oos = cellOf(sel2, "OOS");
    const verdict = oos && oos.n >= 8 ? (oos.exp > 0 ? "HOLDS ✓" : "DIES ✗") : "n<8 — inconclusive";
    console.log(`  ${c.key}`);
    console.log(`    IS : ${fmt(c)}`);
    console.log(`    OOS: ${oos ? fmt(oos) : "no trades"}  → ${verdict}`);
  }

  // ── 4. reference: what the CURRENT live gates approximate ──
  const live = cellOf(rows.filter((r) => r.strength >= 42 && (r.strategy === "AI-SWING" || r.strategy === "AI-SCALP") && (!r.flowConfirm || true) && r.regime !== "CHOP" ? (r.strategy === "AI-SWING" || r.strategy === "AI-SCALP") : false), "≈live-gates");
  if (live) console.log(`\n≈live-gates reference (strength≥42 + SWING/SCALP): ${fmt(live)}`);

  console.log("\nSWEEP COMPLETE (read-only)");
}

main()
  .catch((e) => { console.error("SWEEP ERROR", e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
