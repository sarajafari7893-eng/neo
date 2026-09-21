/**
 * backtest-post-tightening.ts — read-only backtest of signals deployed AFTER
 * the operator-mandated tightening (2026-09-05T19:16Z: MIN_SCORE 42, FLOW-VETO −12,
 * CAP 4, SL 1.75×ATR, REGIME-GUARD L2) vs the cohort deployed BEFORE it.
 *
 * Answers: are the stricter filters producing a better cohort (or at least fewer,
 * better-selected trades)?
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const TIGHTEN_AT = new Date("2026-09-05T19:16:00Z");

interface Cohort {
  label: string;
  n: number;
  settled: number;
  active: number;
  tpProvenWins: number;
  sl: number;
  expired: number;
  sumPct: number;
  avgPct: number;
  sumUsd: number;
  wins: string[];
}

function blank(label: string): Cohort {
  return { label, n: 0, settled: 0, active: 0, tpProvenWins: 0, sl: 0, expired: 0, sumPct: 0, avgPct: 0, sumUsd: 0, wins: [] };
}

async function main() {
  const all = await db.signal.findMany({
    where: { createdAt: { gte: new Date("2026-09-04T00:00:00Z") } },
    orderBy: { createdAt: "asc" },
  });

  const before = blank("BEFORE tightening (< 19:16Z Sep-05)");
  const after = blank("AFTER tightening (≥ 19:16Z Sep-05)");

  for (const s of all) {
    const c = s.createdAt >= TIGHTEN_AT ? after : before;
    c.n++;
    const settled = s.status !== "ACTIVE";
    if (!settled) { c.active++; continue; }
    c.settled++;
    if (s.reachedTp >= 1) c.tpProvenWins++;
    if (s.status === "SL") c.sl++;
    if (s.status === "EXPIRED") c.expired++;
    const pnl = s.pnlPercent || 0;
    const net = pnl - (s.feeUsd || 0) / Math.max(1, s.marginUsd) * 100;
    c.sumPct += net;
    c.sumUsd += (net / 100) * Math.max(1, s.marginUsd);
    if (s.reachedTp >= 1) c.wins.push(`${s.symbol} ${s.direction} +${net.toFixed(1)}%`);
  }

  for (const c of [before, after]) {
    c.avgPct = c.settled ? c.sumPct / c.settled : 0;
    const wr = c.settled ? (100 * c.tpProvenWins) / c.settled : 0;
    console.log(`\n== ${c.label}`);
    console.log(`   deployed n=${c.n} (settled ${c.settled}, active ${c.active})`);
    console.log(`   WR(TP-proven) ${wr.toFixed(1)}%  SL ${c.sl}  EXPIRED ${c.expired}`);
    console.log(`   Σ net ${c.sumPct.toFixed(1)}%  avg ${c.avgPct.toFixed(2)}%/trade  Σ $ ${c.sumUsd.toFixed(2)}`);
    if (c.wins.length) console.log(`   wins: ${c.wins.slice(0, 12).join(" | ")}`);
  }

  // strategy × cohort cross for the AFTER cohort
  const byStrat = new Map<string, { n: number; sumPct: number; tp: number }>();
  for (const s of all) {
    if (s.createdAt < TIGHTEN_AT || s.status === "ACTIVE") continue;
    const row = byStrat.get(s.strategy) ?? { n: 0, sumPct: 0, tp: 0 };
    row.n++;
    const net = (s.pnlPercent || 0) - (s.feeUsd || 0) / Math.max(1, s.marginUsd) * 100;
    row.sumPct += net;
    if (s.reachedTp >= 1) row.tp++;
    byStrat.set(s.strategy, row);
  }
  console.log("\n== AFTER cohort × strategy (settled)");
  for (const [k, v] of [...byStrat.entries()].sort((a, b) => a[1].sumPct - b[1].sumPct)) {
    console.log(`   ${k.padEnd(14)} n=${String(v.n).padStart(3)} WR ${((100 * v.tp) / v.n).toFixed(0).padStart(3)}%  Σ ${v.sumPct.toFixed(1)}%  avg ${(v.sumPct / v.n).toFixed(2)}%/trade`);
  }

  // regime tags for the AFTER cohort
  const byRegime = new Map<string, { n: number; sumPct: number; tp: number }>();
  for (const s of all) {
    if (s.createdAt < TIGHTEN_AT || s.status === "ACTIVE") continue;
    const tags = (s.tags || "").split(",").map(t => t.trim().toUpperCase());
    const regime = tags.find(t => ["CHOP", "TREND-UP", "TREND-DOWN", "VOLATILE"].includes(t)) ?? "UNTAGGED";
    const row = byRegime.get(regime) ?? { n: 0, sumPct: 0, tp: 0 };
    row.n++;
    const net = (s.pnlPercent || 0) - (s.feeUsd || 0) / Math.max(1, s.marginUsd) * 100;
    row.sumPct += net;
    if (s.reachedTp >= 1) row.tp++;
    byRegime.set(regime, row);
  }
  console.log("\n== AFTER cohort × regime tag (settled)");
  for (const [k, v] of [...byRegime.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`   ${k.padEnd(12)} n=${String(v.n).padStart(3)} WR ${((100 * v.tp) / v.n).toFixed(0).padStart(3)}%  Σ ${v.sumPct.toFixed(1)}%  avg ${(v.sumPct / v.n).toFixed(2)}%/trade`);
  }

  const settledAll = await db.signal.findMany({ where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } }, select: { pnlPercent: true, marginUsd: true } });
  const openAll = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { pnlPercent: true, marginUsd: true } });
  const realized = settledAll.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const unrealized = openAll.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  console.log(`\nEquity: $${(100 + realized + unrealized).toFixed(2)} (start $100) — realized ${realized.toFixed(2)} unrealized ${unrealized.toFixed(2)}`);
}

main()
  .catch(e => { console.error("BACKTEST ERROR", e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
