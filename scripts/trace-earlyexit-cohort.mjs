// v14.2 — READ-ONLY: quantify the EARLY-EXIT(STALLED) cost on the 10-30→11-03
// zero-TP cohort — how many were cut early and hit TP1 only in afterlife.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const t0 = new Date("2026-10-30T00:00:00Z");
const rows = await db.signal.findMany({
  where: { createdAt: { gte: t0 }, status: { in: ["SL", "EXPIRED", "CLOSED", "TP1", "TP2", "TP3"] } },
  select: { serial: true, symbol: true, direction: true, status: true, reachedTp: true, afterlife: true,
    maxPnlPercent: true, pnlPercent: true, leverage: true, marginUsd: true, createdAt: true, events: { select: { type: true, message: true }, take: 20 } },
});
let early = 0, earlyTp1After = 0, tpAny = 0, total = 0, earlyNet = 0, foregone = 0;
for (const r of rows) {
  total++;
  if (r.reachedTp >= 1) tpAny++;
  const evs = r.events ?? [];
  const isEarly = evs.some(e => e.type === "EARLY_EXIT");
  if (isEarly) {
    early++;
    earlyNet += (r.marginUsd * r.pnlPercent) / 100;
    if (r.afterlife === "TP1_HIT" || r.afterlife === "TP2_HIT" || r.afterlife === "TP3_HIT") {
      earlyTp1After++;
      foregone += (r.marginUsd * (r.maxPostPnlPercent ?? 0)) / 100;
    }
  }
}
console.log(JSON.stringify({ window: "2026-10-30T00:00Z→now", total, reachedTp: tpAny, earlyExitClosed: early,
  earlyExitThenAfterlifeTP: earlyTp1After, earlyExitNetUsd: Number(earlyNet.toFixed(2)) }, null, 1));
await db.$disconnect();
