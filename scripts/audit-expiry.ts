/**
 * Read-only DB audit: expired-signal outcomes, afterlife evidence, PnL accounting.
 * Feeds Task 2 (expired P/L in balance?) and Task 3 (dynamic expiry gate evidence).
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const total = await db.signal.count();
  console.log("TOTAL SIGNALS:", total);

  const byStatus = await db.signal.groupBy({
    by: ["status"],
    _count: { _all: true },
    _avg: { pnlPercent: true, maxPnlPercent: true, maxPostPnlPercent: true, confidence: true },
    _sum: { pnlPercent: true },
  });
  console.log("\n== BY STATUS ==");
  for (const s of byStatus) {
    console.log(
      `${s.status}: n=${s._count._all} avgPnl=${s._avg.pnlPercent?.toFixed(2)}% sumPnl=${s._sum.pnlPercent?.toFixed(2)}% avgMFE=${s._avg.maxPnlPercent?.toFixed(2)}% avgPostMFE=${s._avg.maxPostPnlPercent?.toFixed(2)}% avgConf=${s._avg.confidence?.toFixed(1)}`
    );
  }

  const expired = await db.signal.findMany({
    where: { status: "EXPIRED" },
    select: {
      id: true, serial: true, symbol: true, direction: true, strategy: true,
      confidence: true, entryPrice: true, tp1: true, tp2: true, tp3: true,
      stopLoss: true, pnlPercent: true, maxPnlPercent: true, maxPostPnlPercent: true,
      reachedTp: true, afterlife: true, createdAt: true, closedAt: true, ttlMinutes: true,
      ttlExtensions: true, leverage: true, marginUsd: true,
    },
  });
  console.log("\n== EXPIRED DETAIL ==", expired.length);

  let wouldHaveWon = 0, wouldHaveWonTp2 = 0, postMfePos = 0, expiredWithTpProven = 0;
  const rows: string[] = [];
  for (const s of expired) {
    const d = s.direction === "LONG" ? 1 : -1;
    const dist = (level: number) => ((level - s.entryPrice) / s.entryPrice) * 100 * d * (s.leverage || 1);
    const mfePost = s.maxPostPnlPercent ?? 0;
    const hitTp1Post = mfePost >= dist(s.tp1);
    const hitTp2Post = mfePost >= dist(s.tp2);
    const proven = s.reachedTp >= 1;
    if (proven) expiredWithTpProven++;
    if (hitTp1Post) wouldHaveWon++;
    if (hitTp2Post) wouldHaveWonTp2++;
    if (mfePost > 0) postMfePos++;
    rows.push(
      `${s.serial} ${s.symbol} ${s.direction} conf=${s.confidence} ttl=${s.ttlMinutes}m reachedTp=${s.reachedTp} afterlife=${s.afterlife} pnl@expiry=${s.pnlPercent?.toFixed(1)}% mfePre=${s.maxPnlPercent?.toFixed(1)}% mfePost=${mfePost.toFixed(1)}% postTP1=${hitTp1Post ? "YES" : "no"} postTP2=${hitTp2Post ? "YES" : "no"} lev=${s.leverage}x`
    );
  }
  rows.sort().forEach((r) => console.log(r));
  const n = expired.length || 1;
  console.log(`\nEXPIRED SUMMARY: wouldHaveHitTP1=${wouldHaveWon}/${n} (${((wouldHaveWon / n) * 100).toFixed(0)}%) · wouldHaveHitTP2=${wouldHaveWonTp2}/${n} · postMFE>0=${postMfePos}/${n} · reachedTp>=1 (proven pre/at expiry)=${expiredWithTpProven}/${n}`);

  // TTL distribution + avg time-to-TP for afterlife hits (rough proxy: closedAt null → use now)
  const ttls = await db.signal.groupBy({ by: ["ttlMinutes"], _count: { _all: true } });
  console.log("\nTTL DISTRIBUTION:", ttls.map((t) => `${t.ttlMinutes}m:${t._count._all}`).join(" "));

  // SignalEvent AFTERLIFE / TTL_EXPIRED counts
  const evts = await db.signalEvent.groupBy({ by: ["type"], _count: { _all: true } });
  console.log("\nEVENT TYPES:", evts.map((e) => `${e.type}:${e._count._all}`).join(" "));

  // Recent AFTERLIFE messages (evidence of follow-up reports)
  const afterlife = await db.signalEvent.findMany({
    where: { type: "AFTERLIFE" },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { message: true, createdAt: true },
  });
  console.log("\n== LAST 12 AFTERLIFE FOLLOW-UPS ==");
  afterlife.forEach((e) => console.log(`${e.createdAt.toISOString()} — ${e.message.slice(0, 160)}`));

  // Balance accounting: sum realized pnl USD over closed (closedAt != null)
  const closed = await db.signal.findMany({
    where: { closedAt: { not: null } },
    select: { status: true, marginUsd: true, pnlPercent: true },
  });
  let realized = 0;
  const bySt: Record<string, number> = {};
  for (const s of closed) {
    const usd = (s.marginUsd * s.pnlPercent) / 100;
    realized += usd;
    bySt[s.status] = (bySt[s.status] ?? 0) + usd;
  }
  console.log("\n== REALIZED (closedAt != null) ==");
  for (const [k, v] of Object.entries(bySt)) console.log(`${k}: ${v.toFixed(2)} USD`);
  console.log(`TOTAL REALIZED: ${realized.toFixed(2)} USD  → includes EXPIRED: ${bySt["EXPIRED"] !== undefined}`);

  // unrealized open
  const open = await db.signal.findMany({
    where: { status: { in: ["ACTIVE", "TP1", "TP2"] } },
    select: { marginUsd: true, pnlPercent: true },
  });
  const unreal = open.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  console.log(`OPEN UNREALIZED: ${unreal.toFixed(2)} USD over ${open.length} signals`);
}

main().finally(() => db.$disconnect());
