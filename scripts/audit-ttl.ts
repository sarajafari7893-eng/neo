import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

async function main() {
  // 1) gate settings + telemetry
  const gs = await db.engineSetting.findUnique({ where: { key: "gate-settings" } });
  console.log("GATE-SETTINGS:", gs?.value ?? "MISSING");
  const tt = await db.engineSetting.findUnique({ where: { key: "ttl-gate" } });
  console.log("TTL-TELEMETRY:", tt?.value ?? "EMPTY (never fired)");

  // 2) expiry activity since gate shipped (v6.1 ~ deployed 2026-09-04 ~02:00 UTC)
  const since = new Date("2026-09-04T02:00:00Z");
  const expired = await db.signal.findMany({
    where: { status: "EXPIRED", closedAt: { gte: since } },
    orderBy: { closedAt: "desc" }, take: 15,
  });
  console.log(`\nEXPIRED SINCE GATE DEPLOY: ${expired.length}`);
  for (const s of expired) {
    const slDist = Math.abs((s.entryPrice - s.stopLoss) / s.entryPrice) * 100;
    console.log(`${s.symbol} ${s.direction?.slice(0,4)} ext=${s.ttlExtensions} closedAt=${s.closedAt?.toISOString()} pnl=${s.pnlPercent?.toFixed(2)}% ttl=${s.ttlMinutes}m age=${Math.round((s.closedAt!.getTime()-s.createdAt.getTime())/60000)}m slDist=${slDist.toFixed(1)}% tp1=${s.tp1} entry=${s.entryPrice}`);
  }

  // 3) active signals expiring soon (next candidates)
  const active = await db.signal.findMany({
    where: { status: { in: ["ACTIVE", "TP1", "TP2"] }, closedAt: null },
    orderBy: { expiresAt: "asc" }, take: 10,
  });
  console.log(`\nOPEN SIGNALS (next expiries): ${active.length}`);
  for (const s of active) {
    console.log(`${s.symbol} ${s.status} ext=${s.ttlExtensions} expires=${s.expiresAt.toISOString()} entry=${s.entryPrice} tp1=${s.tp1} sl=${s.stopLoss} ttl=${s.ttlMinutes}m`);
  }

  // 4) recent ENGINE / TTL_EXPIRED events since deploy
  const evs = await db.signalEvent.findMany({
    where: { createdAt: { gte: since }, type: { in: ["ENGINE", "TTL_EXPIRED"] } },
    orderBy: { createdAt: "desc" }, take: 25,
  });
  console.log(`\nENGINE/TTL EVENTS SINCE DEPLOY: ${evs.length}`);
  for (const e of evs) console.log(`${e.createdAt.toISOString()} [${e.type}] ${e.message.slice(0, 180)}`);
}
main().finally(() => db.$disconnect());
