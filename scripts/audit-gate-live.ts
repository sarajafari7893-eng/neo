import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const evs = await db.signalEvent.findMany({ where: { createdAt: { gte: new Date(Date.now() - 90 * 60_000) }, type: { in: ["ENGINE", "TTL_EXPIRED", "TP1", "SL"] } }, orderBy: { createdAt: "desc" }, take: 20 });
  for (const e of evs) if (/GATE|TTL|BNB|extension/i.test(e.message)) console.log(`${e.createdAt.toISOString()} [${e.type}] ${e.message.slice(0, 220)}`);
  const tt = await db.engineSetting.findUnique({ where: { key: "ttl-gate" } });
  console.log("\nTELEMETRY:", tt?.value ?? "empty");
  const bnb = await db.signal.findFirst({ where: { symbol: "BNBUSDT", closedAt: null }, orderBy: { createdAt: "desc" } });
  console.log("BNBUSDT open:", bnb ? `status=${bnb.status} expires=${bnb.expiresAt.toISOString()} ext=${bnb.ttlExtensions}` : "none open");
}
main().finally(() => db.$disconnect());
