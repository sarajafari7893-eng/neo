// One-shot DB audit for the operator review round (safe, read-only).
import { db } from "../src/lib/db";
import { Prisma } from "@prisma/client";

async function main() {
  const total = await db.signal.count();
  const byStatus = await db.signal.groupBy({ by: ["status"], _count: { _all: true }, _sum: { pnlPercent: true } });
  const byReached = await db.signal.groupBy({ by: ["reachedTp"], _count: { _all: true }, where: { status: { in: ["EXPIRED"] } } });
  const byReachedAll = await db.signal.groupBy({ by: ["reachedTp"], _count: { _all: true }, _sum: { pnlPercent: true } });
  const byAfterlife = await db.signal.groupBy({ by: ["afterlife"], _count: { _all: true }, where: { status: "EXPIRED" } });

  const expired = await db.signal.findMany({
    where: { status: "EXPIRED" },
    select: { id: true, symbol: true, reachedTp: true, pnlPercent: true, afterlife: true, maxPostPnlPercent: true, confidence: true, createdAt: true, closedAt: true },
    orderBy: { createdAt: "desc" }, take: 50,
  });

  const settled = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL"] } },
    select: { status: true, pnlPercent: true, reachedTp: true, _count: { select: { events: true } } },
  });

  // engine settings persisted agent states
  const afterlifeEvents = await db.signalEvent.count({ where: { type: "AFTERLIFE" } });
  const ttlEvents = await db.signalEvent.count({ where: { type: "TTL_EXPIRED" } });

  // recent TTL_EXPIRED events (where do follow-up reports go?)
  const recentTtl = await db.signalEvent.findMany({
    where: { type: { in: ["TTL_EXPIRED", "AFTERLIFE"] } },
    orderBy: { createdAt: "desc" }, take: 8,
    select: { type: true, symbol: true, message: true, createdAt: true },
  });

  // engine settings persisted agent states
  const settings = await db.engineSetting.findMany({ where: { key: { in: ["governor", "supervisor", "deep-learn", "calibration", "backtest"] } }, select: { key: true } });

  console.log(JSON.stringify({
    ts: Date.now(),
    total,
    byStatus: byStatus.map(b => ({ status: b.status, n: b._count._all, pnlSum: b._sum.pnlPercent })),
    expiredByReachedTp: byReached.map(b => ({ reachedTp: b.reachedTp, n: b._count._all })),
    allByReachedTp: byReachedAll.map(b => ({ reachedTp: b.reachedTp, n: b._count._all, pnlSum: b._sum.pnlPercent })),
    expiredByAfterlife: byAfterlife.map(b => ({ afterlife: b.afterlife, n: b._count._all })),
    settledCount: settled.length,
    settledPnlSum: settled.reduce((a, s) => a + (s.pnlPercent ?? 0), 0).toFixed(2),
    afterlifeEvents, ttlEvents,
    recentTtl,
    settingsKeys: settings.map(s => s.key),
    expiredSamples: expired.slice(0, 12),
  }, null, 2));
}

main().then(() => process.exit(0)).catch(e => { console.error("AUDIT FAIL", e.message); process.exit(1); });
