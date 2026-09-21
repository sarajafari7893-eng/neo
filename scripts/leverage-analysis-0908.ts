// ── LEVERAGE QUESTION ANALYSIS (operator 2026-09-08: «آیا میانگین اهرم بالاتر شرایط را بهتر می‌کند؟») ──
// READ-ONLY. Grounds the answer in the realized ledger:
//   buckets: leverage → n / win-rate / avg net pnl% / Σ pnl$ / avg fee$ / avg SL-dist
//   plus the deploy invariant (lev ≈ 60 / slDist) and what raising avg lev actually does.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const settled = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    select: { leverage: true, pnlPercent: true, marginUsd: true, feeUsd: true, reachedTp: true, strategy: true, direction: true, status: true, createdAt: true },
  });
  const active = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { leverage: true } });

  console.log(`settled=${settled.length} active=${active.length}`);
  const avgLev = settled.reduce((a, s) => a + s.leverage, 0) / (settled.length || 1);
  console.log(`avg leverage (settled): ${avgLev.toFixed(1)}x · active now avg: ${(active.reduce((a, s) => a + s.leverage, 0) / (active.length || 1)).toFixed(1)}x`);

  const buckets: Array<[string, number, number]> = [["5-9x", 5, 10], ["10-12x", 10, 13], ["13-16x", 13, 17], ["17-20x", 17, 21]];
  console.log("\noutcome by leverage bucket:");
  for (const [label, lo, hi] of buckets) {
    const rows = settled.filter((s) => s.leverage >= lo && s.leverage < hi);
    if (!rows.length) { console.log(`  ${label.padEnd(7)} n=0`); continue; }
    const wins = rows.filter((s) => s.reachedTp >= 1).length;
    const pnl = rows.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
    const avgPnl = rows.reduce((a, s) => a + s.pnlPercent, 0) / rows.length;
    const fees = rows.reduce((a, s) => a + s.feeUsd, 0);
    const sls = rows.filter((s) => s.status === "SL" && s.reachedTp === 0).length;
    console.log(`  ${label.padEnd(7)} n=${String(rows.length).padStart(3)} win=${((wins / rows.length) * 100).toFixed(0).padStart(3)}% avgPnl=${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(1)}% Σpnl=$${pnl.toFixed(2)} fees=$${fees.toFixed(2)} straightSL=${sls}`);
  }

  // epoch slice (EPOCH-V7 = smarter gate era)
  const v7 = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, tags: { contains: "EPOCH-V7" } },
    select: { leverage: true, pnlPercent: true, marginUsd: true, reachedTp: true, status: true },
  });
  if (v7.length) {
    const wins = v7.filter((s) => s.reachedTp >= 1).length;
    const pnl = v7.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
    const avgL = v7.reduce((a, s) => a + s.leverage, 0) / v7.length;
    console.log(`\nEPOCH-V7 settled slice: n=${v7.length} win=${((wins / v7.length) * 100).toFixed(0)}% Σpnl=$${pnl.toFixed(2)} avgLev=${avgL.toFixed(1)}x`);
  }

  // damage concentration: worst-10 losers — their leverage vs the rest
  const losers = [...settled].sort((a, b) => (a.marginUsd * a.pnlPercent) / 100 - (b.marginUsd * b.pnlPercent) / 100).slice(0, 10);
  const loserLev = losers.reduce((a, s) => a + s.leverage, 0) / losers.length;
  const loserLoss = losers.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const restPnl = settled.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0) - loserLoss;
  console.log(`\nworst-10 losers: avgLev=${loserLev.toFixed(1)}x Σ=$${loserLoss.toFixed(2)} — ALL OTHER ${settled.length - 10} trades Σ=$${restPnl.toFixed(2)}`);

  // fee math: fee scales on NOTIONAL = margin × leverage → taker 0.05% ×2 sides
  const marginAvg = settled.reduce((a, s) => a + s.marginUsd, 0) / settled.length;
  console.log(`\nfee math: avg margin $${marginAvg.toFixed(2)} → at 10x notional $${(marginAvg * 10).toFixed(0)} roundtrip fee ≈ $${(marginAvg * 10 * 0.001).toFixed(2)} · at 20x ≈ $${(marginAvg * 20 * 0.001).toFixed(2)} (2× cost per trade)`);
}

main().finally(() => db.$disconnect());
