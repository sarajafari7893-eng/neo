// ── NO-TOUCH FLOOR SHADOW-SIM (operator mandate 2026-11-03, trace 1a19e8f351a779ad item ④) ──
// The candidate from the 2026-11-02 winRate session: «شبیه‌سازی shadow کف no-touch».
//
// WHAT IT SIMULATES (shadow only — no order, no config change, FLAT-10 untouched):
//   A HARD PROFIT-FLOOR TRAIL: the moment a live position's MFE first reaches
//   the floor F (levered %), the stop is trailed so the position can never
//   close below F (the "no-touch floor" — the trade can no longer touch a
//   worse outcome). Current engine behavior: mid-ladder BE arm (beTrailPct/
//   beArmRMult 0.5R + beBankFrac 0.25) locks ≈ breakeven(+1.5%px) — the worst
//   14d tail (AI-SWING CHOP-SHORT small-caps) grabbed MFE up to +19.3% and
//   still closed −63% (full stop-outs): BRUSDT/IRYSUSDT/BTWUSDT/QUSDT/JCT/MAGMA.
//
// METHOD (honest MFE approximation, stated caveats):
//   · For every settled CLEAN row: F_row = F (levered %) or R-mult × R_row,
//     R_row = |entry−initialSL|/entry × leverage × 100 (fallback stopLoss).
//   · Counterfactual: pnl' = max(pnl, F_row) IF maxPnlPercent ≥ F_row else pnl.
//     (Pessimistic: exit exactly at F after first touch; real trail ≥ F.)
//   · Touch rate = share with MFE ≥ F; its complement IS the DECISIVE-filter
//     vocabulary "no-touch rate" at distance F.
//   · Rows with implausible R (≤0.1% or >200%) skipped (counted).
//   · beBanked rows: their pnl already includes the banked tranche; max()
//     override is applied uniformly — reported, not special-cased.
//   · Fees/swaps unchanged; TP-proven accounting untouched (floor never
//     changes reachedTp) — the sim therefore reports POSITIVE-PNL accounting
//     and net$ deltas, which is the accounting the dual-rate line uses.
// Run: bun scripts/no-touch-floor-sim-20261103.ts
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

interface Row {
  strategy: string; status: string; pnlPercent: number; maxPnlPercent: number;
  marginUsd: number; feeUsd: number; swapUsd: number; leverage: number;
  entryPrice: number; initialStopLoss: number | null; stopLoss: number;
  beBankedFrac: number | null;
}

const db = new Database("db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout = 8000;");
const now = Date.now();

const rowsAll = db.query(`
  SELECT strategy,status,pnlPercent,maxPnlPercent,marginUsd,feeUsd,swapUsd,leverage,
         entryPrice,initialStopLoss,stopLoss,beBankedFrac
  FROM Signal
  WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED') AND qualityFlag IS NULL
    AND CAST(createdAt AS REAL) >= ${now - 30 * 86400e3}
`).all() as unknown as Row[];

let skipped = 0;
const rows = rowsAll.filter((r) => {
  const sl = r.initialStopLoss ?? r.stopLoss;
  const R = sl && r.entryPrice ? Math.abs(r.entryPrice - sl) / r.entryPrice * r.leverage * 100 : 0;
  if (!Number.isFinite(R) || R <= 0.1 || R > 200) { skipped++; return false; }
  return true;
});
const Rof = (r: Row) => Math.abs(r.entryPrice - (r.initialStopLoss ?? r.stopLoss)) / r.entryPrice * r.leverage * 100;

const net = (rs: Row[], pnlFn: (r: Row) => number) => rs.reduce((s, r) => s + (pnlFn(r) / 100) * (r.marginUsd || 10), 0)
  - rs.reduce((s, r) => s + (r.feeUsd || 0), 0)
  - rs.reduce((s, r) => s + (r.swapUsd || 0), 0);

const BASE_NET = net(rows, (r) => r.pnlPercent);
const BASE_POS = (rows.filter((r) => r.pnlPercent > 0).length / rows.length) * 100;
const STRATS = ["AI-SWING", "BREAKOUT", "MEAN-REVERT", "AI-SCALP", "MOMENTUM"];

function sweep(label: string, Fof: (r: Row, F: number) => number, floors: number[], fmt: (F: number) => string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  console.log(`\n──── FLOOR SWEEP ${label} (30d clean n=${rows.length}, skipped=${skipped}) ────`);
  console.log("floor      touch%  noTouch%  saved(loss→+)  posRate→     net$ →  Δnet$   | per-strategy Δnet$");
  for (const F of floors) {
    const touched = rows.filter((r) => r.maxPnlPercent >= Fof(r, F));
    const pnl2 = (r: Row) => (r.maxPnlPercent >= Fof(r, F) ? Math.max(r.pnlPercent, Fof(r, F)) : r.pnlPercent);
    const saved = rows.filter((r) => r.pnlPercent < 0 && pnl2(r) > 0).length;
    const pos2 = (rows.filter((r) => pnl2(r) > 0).length / rows.length) * 100;
    const net2 = net(rows, pnl2);
    const deltas = STRATS.map((s) => {
      const rs = rows.filter((r) => r.strategy === s);
      if (!rs.length) return null;
      const d = net(rs, pnl2) - net(rs, (r) => r.pnlPercent);
      return `${s} ${d >= 0 ? "+" : ""}${d.toFixed(1)}`;
    }).filter(Boolean).join(" · ");
    // pessimistic variant — EVERY touched row exits exactly at the floor
    // (winner truncation included): the honest LOWER bound of the same rule.
    const pnlPess = (r: Row) => (r.maxPnlPercent >= Fof(r, F) ? Fof(r, F) : r.pnlPercent);
    const netPess = net(rows, pnlPess);
    const posPess = (rows.filter((r) => pnlPess(r) > 0).length / rows.length) * 100;
    const row = {
      floor: fmt(F),
      touchPct: +((touched.length / rows.length) * 100).toFixed(1),
      noTouchPct: +((1 - touched.length / rows.length) * 100).toFixed(1),
      saved, posRateAfter: +pos2.toFixed(1),
      netUsd: +net2.toFixed(2), deltaNet: +(net2 - BASE_NET).toFixed(2),
      pessimisticNetUsd: +netPess.toFixed(2), pessimisticDeltaNet: +(netPess - BASE_NET).toFixed(2),
      pessimisticPosRate: +posPess.toFixed(1),
      perStrategyDelta: deltas,
    };
    out.push(row);
    console.log(
      `${String(row.floor).padEnd(8)} ${String(row.touchPct).padStart(5)}%  ${String(row.noTouchPct).padStart(6)}%  ${String(saved).padStart(10)}  ${BASE_POS.toFixed(1)}→${pos2.toFixed(1)}%  $${net2.toFixed(2).padStart(7)}  ${(net2 - BASE_NET >= 0 ? "+" : "") + (net2 - BASE_NET).toFixed(2).padStart(6)} | pess: $${netPess.toFixed(2)} (${(netPess - BASE_NET >= 0 ? "+" : "") + (netPess - BASE_NET).toFixed(2)}) pos→${posPess.toFixed(1)}% | ${deltas}`,
    );
  }
  return out;
}

console.log("═".repeat(120));
console.log(`NO-TOUCH FLOOR SHADOW-SIM 2026-11-03 — 30d clean ledger · BASE: net=$${BASE_NET.toFixed(2)} posRate=${BASE_POS.toFixed(1)}% (TPwr untouched by design)`);
console.log("═".repeat(120));

const leveredSweep = sweep("LEVERED % (pnlPercent units)", (_r, F) => F, [2, 4, 6, 8, 10, 12], (F) => `+${F}%`);
const rSweep = sweep("R-MULTIPLE (per-row R = SL-dist × lev)", (r, F) => F * Rof(r), [0.25, 0.5, 0.75, 1.0, 1.5], (F) => `${F}R`) as Array<Record<string, unknown>>;
const rOut: Array<Record<string, unknown>> = rSweep;

const report = {
  at: new Date().toISOString(),
  windowDays: 30,
  base: { n: rows.length, skipped, netUsd: +BASE_NET.toFixed(2), posRatePct: +BASE_POS.toFixed(1) },
  leveredSweep, rSweep: rOut,
  caveats: [
    "OPTIMISTIC variant: pnl' = max(pnl, F) for touched rows — only upgrades losers, never truncates winners (upper bound).",
    "PESSIMISTIC variant: every touched row exits exactly at F (winner truncation included) — lower bound. Truth between the bounds.",
    "MFE approximation: intra-trade path unknown; a real trail may exit before the true MFE (pessimistic side) or ride past F (optimistic side).",
    "TP-proven accounting untouched by design (reachedTp never changes) — deltas are positive-PnL accounting + net$.",
    "beBanked rows: pnl already includes the banked tranche; floor override applied uniformly.",
    "Shadow only — no order, no config change, engine.ts/FLAT-10 untouched.",
  ],
};
try { writeFileSync(".data/no-touch-floor-sim-20261103.json", JSON.stringify(report, null, 2)); console.log("\nsaved → .data/no-touch-floor-sim-20261103.json"); } catch { /* read-only fs fallback */ }
db.close();
console.log("(shadow sim complete — no writes to trading state)");
