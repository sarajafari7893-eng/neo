/**
 * TASK 53-c — READ-ONLY ledger forensics: why did برآیند weaken since 17/10?
 * Daily Tehran-day buckets: closed net PnL (marginUsd×pnlPercent/100), trade count,
 * win rate (pnl>0), created count, status mix, FLOW-NO-DATA tag share.
 * NO writes. bun scripts/audit-pnl-trend.ts
 */
import { db } from "../src/lib/db";

const TEH_OFFSET_MIN = 210; // UTC+03:30

function tehDayKey(d: Date): string {
  const shifted = new Date(d.getTime() + TEH_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

async function main() {
  const since = new Date("2026-10-11T00:00:00.000Z");
  const closed = await db.signal.findMany({
    where: { closedAt: { not: null, gte: since } },
    select: {
      symbol: true, status: true, pnlPercent: true, marginUsd: true,
      feeUsd: true, swapUsd: true, closedAt: true, createdAt: true,
      tags: true, strategy: true, qualityFlag: true, beBankedFrac: true,
    },
  });

  const created = await db.signal.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, tags: true, status: true, strategy: true },
  });

  const days = new Map<string, { pnl: number; n: number; wins: number; created: number; flowNoData: number; statuses: Record<string, number> }>();
  const day = (k: string) => {
    let v = days.get(k);
    if (!v) { v = { pnl: 0, n: 0, wins: 0, created: 0, flowNoData: 0, statuses: {} }; days.set(k, v); }
    return v;
  };

  for (const s of closed) {
    if (s.qualityFlag) continue; // clean-ledger doctrine — excluded rows
    const k = tehDayKey(s.closedAt!);
    const v = day(k);
    v.pnl += (s.marginUsd * s.pnlPercent) / 100;
    v.n += 1;
    if (s.pnlPercent > 0) v.wins += 1;
    v.statuses[s.status] = (v.statuses[s.status] ?? 0) + 1;
  }
  for (const s of created) {
    const k = tehDayKey(s.createdAt);
    const v = day(k);
    v.created += 1;
    if (s.tags.includes("FLOW-NO-DATA")) v.flowNoData += 1;
  }

  const keys = [...days.keys()].sort();
  console.log("day(Tehran) | closedN | netPnL$ | WR% | created | FLOW-NO-DATA | statusMix");
  for (const k of keys) {
    const v = days.get(k)!;
    const wr = v.n ? ((v.wins / v.n) * 100).toFixed(0) : "-";
    const mix = Object.entries(v.statuses).map(([s, c]) => `${s}:${c}`).join(",");
    console.log(`${k} | ${String(v.n).padStart(3)} | ${v.pnl.toFixed(2).padStart(9)} | ${wr.padStart(3)} | ${String(v.created).padStart(3)} | ${String(v.flowNoData).padStart(3)} | ${mix}`);
  }

  // Oct 17 boundary (Tehran day) comparison
  const before = { pnl: 0, n: 0, wins: 0 };
  const after = { pnl: 0, n: 0, wins: 0 };
  for (const s of closed) {
    if (s.qualityFlag) continue;
    const k = tehDayKey(s.closedAt!);
    const t = k < "2026-10-17" ? before : after;
    t.pnl += (s.marginUsd * s.pnlPercent) / 100;
    t.n += 1;
    if (s.pnlPercent > 0) t.wins += 1;
  }
  console.log("\n=== WINDOW COMPARE (Tehran day boundary) ===");
  for (const [label, w] of [["Oct11→Oct16", before], ["Oct17→now", after]] as const) {
    console.log(`${label}: n=${w.n} net=$${w.pnl.toFixed(2)} WR=${w.n ? ((w.wins / w.n) * 100).toFixed(1) : "-"}% exp/trade=$${w.n ? (w.pnl / w.n).toFixed(2) : "-"}`);
  }

  // strategy split for the after-window
  const strat = new Map<string, { pnl: number; n: number }>();
  for (const s of closed) {
    if (s.qualityFlag) continue;
    const k = tehDayKey(s.closedAt!);
    if (k < "2026-10-17") continue;
    const v = strat.get(s.strategy) ?? { pnl: 0, n: 0 };
    v.pnl += (s.marginUsd * s.pnlPercent) / 100;
    v.n += 1;
    strat.set(s.strategy, v);
  }
  console.log("\n=== AFTER-WINDOW (Oct17→) BY STRATEGY ===");
  for (const [k, v] of [...strat.entries()].sort((a, b) => a[1].pnl - b[1].pnl)) {
    console.log(`${k}: n=${v.n} net=$${v.pnl.toFixed(2)}`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
