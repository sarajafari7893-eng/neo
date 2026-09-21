import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const gate = await db.engineSetting.findUnique({ where: { key: "gate" } });
  console.log("GATE (key=gate):", gate?.value ?? "MISSING→defaults(ttlExtendMax=1)");
  const evs = await db.signalEvent.findMany({
    where: { type: "TTL_EXPIRED" }, orderBy: { createdAt: "desc" }, take: 12,
  });
  console.log(`\nRECENT TTL_EXPIRED (${evs.length}):`);
  for (const e of evs) console.log(`${e.createdAt.toISOString()} ${e.message.slice(0, 240)}`);
  // since deploy only
  const since = new Date("2026-09-04T02:00:00Z");
  const n = await db.signalEvent.count({ where: { type: "TTL_EXPIRED", createdAt: { gte: since } } });
  const ext = await db.signalEvent.count({ where: { type: "ENGINE", message: { contains: "DYNAMIC EXPIRY GATE" }, createdAt: { gte: since } } });
  console.log(`\nsince deploy: TTL_EXPIRED=${n}, GATE-GRANT events=${ext}`);
}
main().finally(() => db.$disconnect());
