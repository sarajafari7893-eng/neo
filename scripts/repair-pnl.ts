/**
 * One-off data repair: recompute absurd pnlPercent values produced by the
 * old TP3 formula (riskReward/slDist*100). Correct: rr × slDist × lev × 100.
 * Run: bun scripts/repair-pnl.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function correctPnl(s: { status: string; entryPrice: number; stopLoss: number; leverage: number; riskReward: number; pnlPercent: number }): number | null {
  const slDist = Math.abs((s.entryPrice - s.stopLoss) / s.entryPrice);
  if (s.status === "TP3") return Number((s.riskReward * slDist * s.leverage * 100).toFixed(2));
  if (s.status === "TP2") return Number((1.8 * slDist * s.leverage * 100).toFixed(2));
  if (s.status === "TP1") return Number((1.0 * slDist * s.leverage * 100).toFixed(2));
  if (s.status === "SL") return Number((-slDist * s.leverage * 100).toFixed(2));
  // EXPIRED / others: clamp anything absurd to ±80%
  if (Math.abs(s.pnlPercent) > 400) return Number(Math.max(-80, Math.min(80, s.pnlPercent)).toFixed(2));
  return null;
}

async function main() {
  const signals = await db.signal.findMany({ where: { closedAt: { not: null } } });
  let fixed = 0;
  for (const s of signals) {
    const corrected = correctPnl(s);
    if (corrected === null || Math.abs(corrected - s.pnlPercent) < 0.5) continue;
    await db.signal.update({ where: { id: s.id }, data: { pnlPercent: corrected } });
    fixed++;
    if (Math.abs(s.pnlPercent) > 500) {
      console.log(`fixed ${s.symbol} ${s.status}: ${s.pnlPercent}% → ${corrected}%`);
    }
  }
  const agg = await db.signal.aggregate({ _avg: { pnlPercent: true }, _max: { pnlPercent: true }, _min: { pnlPercent: true } });
  console.log(`✔ repaired ${fixed}/${signals.length} closed signals`);
  console.log("pnl% avg/max/min:", agg._avg.pnlPercent?.toFixed(1), agg._max.pnlPercent?.toFixed(1), agg._min.pnlPercent?.toFixed(1));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
