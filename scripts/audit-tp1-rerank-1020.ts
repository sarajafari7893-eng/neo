// OP-AUDIT-TP-1020 follow-up — counterfactual replay for the v12.6 TP1 MFE-SCALE
// RE-RANK (operator mandate 2026-10-20, proposal ①). READ-ONLY — touches no rows.
//
// Question it answers with the live ledger: "how many of the rows that never
// proved a TP would have banked the first rung if TP1 sat at m×R instead of 1R?"
//
// Method (and its honest limits):
//   · R (price)        = |tp1 − entryPrice| — every legacy row stored tp1 = entry ± 1R,
//                        so this is the deploy-time risk anchor on ALL rows.
//   · MFE (price)      = entry × (maxPnlPercent / 100 / leverage) — best favorable
//                        excursion, expressed in R units: mfeR.
//   · counterfactual    first-rung hit at multiplier m  ⇔  mfeR ≥ m.
//   · UPPER bound       = all rows counted (assumes TP1 always preceded the stop).
//   · TIGHT bound       = SL rows excluded (a stopped-out row may have touched the
//                        m×R line before dying — ordering is unknowable from MFE).
//   · m = 1.0 is the sanity anchor: it must reproduce the legacy TP1-proven rate.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const MULTS = [0.5, 0.55, 0.6, 1.0] as const;
const SINCE_45D = new Date(Date.now() - 45 * 24 * 3600 * 1000);

interface Row {
  strategy: string;
  status: string;
  reachedTp: number;
  entryPrice: number;
  tp1: number;
  leverage: number;
  maxPnlPercent: number;
  createdAt: Date;
}

function rate(rows: Row[], m: number, tight: boolean): { n: number; hits: number; pct: number } {
  let n = 0;
  let hits = 0;
  for (const r of rows) {
    if (tight && r.status === "SL") continue;
    const R = Math.abs(r.tp1 - r.entryPrice);
    if (!(R > 0) || !r.leverage) continue;
    const mfeR = (r.maxPnlPercent / 100 / r.leverage) * r.entryPrice / R;
    n++;
    if (mfeR >= m) hits++;
  }
  return { n, hits, pct: n ? (hits / n) * 100 : 0 };
}

async function main() {
  const rows: Row[] = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, createdAt: { gte: SINCE_45D } },
    select: { strategy: true, status: true, reachedTp: true, entryPrice: true, tp1: true, leverage: true, maxPnlPercent: true, createdAt: true },
  });
  console.log(`settled rows (45d): ${rows.length}`);

  const windows: Array<[string, (r: Row) => boolean]> = [
    ["7d", (r) => r.createdAt.getTime() >= Date.now() - 7 * 864e5],
    ["14d", (r) => r.createdAt.getTime() >= Date.now() - 14 * 864e5],
    ["45d", () => true],
  ];

  for (const [label, pred] of windows) {
    const w = rows.filter(pred);
    console.log(`\n── window ${label}: n=${w.length}`);
    for (const m of MULTS) {
      const up = rate(w, m, false);
      const tg = rate(w, m, true);
      console.log(
        `  TP1@${m.toFixed(2)}R  UPPER ${up.pct.toFixed(1)}% (${up.hits}/${up.n})   TIGHT(no-SL) ${tg.pct.toFixed(1)}% (${tg.hits}/${tg.n})`,
      );
    }
    const proven = w.filter((r) => r.reachedTp >= 1).length;
    console.log(`  legacy TP1-proven (reachedTp≥1): ${((proven / Math.max(1, w.length)) * 100).toFixed(1)}%`);
  }

  // per-strategy at the approved 0.55R (45d, upper bound) — where the lift concentrates
  const byStrat = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byStrat.get(r.strategy) ?? [];
    arr.push(r);
    byStrat.set(r.strategy, arr);
  }
  console.log("\n── per-strategy @0.55R (45d, UPPER bound)");
  for (const [s, arr] of [...byStrat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const u = rate(arr, 0.55, false);
    const l = rate(arr, 1.0, false);
    console.log(`  ${s.padEnd(12)} n=${String(arr.length).padStart(4)}  TP1@0.55R ${u.pct.toFixed(1)}%  vs legacy@1R ${l.pct.toFixed(1)}%`);
  }

  // the operator's exact complaint cohort: rows that proved NO tp rung
  const noTp = rows.filter((r) => r.reachedTp === 0);
  const u55 = rate(noTp, 0.55, false);
  console.log(`\n── no-TP cohort (reachedTp=0, 45d): n=${noTp.length} → ${u55.pct.toFixed(1)}% would have banked a 0.55R first rung (UPPER)`);
}

main()
  .finally(() => db.$disconnect())
  .catch((e) => {
    console.error("AUDIT FAILED:", e);
    process.exit(1);
  });
