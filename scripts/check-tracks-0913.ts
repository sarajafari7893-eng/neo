import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const rows = await db.pumpTrack.findMany({
    where: { signalId: { not: null } },
    select: { symbol: true, kind: true, anchorPrice: true, score: true, detectedAt: true, signalId: true },
    orderBy: { detectedAt: "desc" },
    take: 30,
  });
  for (const r of rows) console.log(`${r.symbol} ${r.kind} anchor=${r.anchorPrice} score=${r.score} at=${r.detectedAt.toISOString()} sig=${r.signalId!.slice(0, 8)}`);
  const sig = await db.signal.findFirst({ where: { symbol: "BNBUSDT", tags: { contains: "PUMP" } }, select: { id: true, serial: true, entryPrice: true, createdAt: true, tags: true } });
  console.log("BNB sig:", sig ? `${sig.serial} entry=${sig.entryPrice} at=${sig.createdAt.toISOString()} tags=${sig.tags.slice(0, 80)}` : "none");
  const track = await db.pumpTrack.findFirst({ where: { symbol: "BNBUSDT" }, orderBy: { detectedAt: "desc" }, select: { anchorPrice: true, detectedAt: true, signalId: true, kind: true, score: true } });
  console.log("BNB track:", JSON.stringify(track));
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
