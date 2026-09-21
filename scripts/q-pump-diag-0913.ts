import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const byOutcome = await db.pumpTrack.groupBy({ by: ["outcome"], _count: { _all: true } });
  console.log("pumpTrack byOutcome:", JSON.stringify(byOutcome.map((g) => ({ outcome: g.outcome, n: g._count._all }))));
  const total = await db.pumpTrack.count();
  console.log("pumpTrack total:", total);
  const recent = await db.pumpTrack.findMany({ orderBy: { detectedAt: "desc" }, take: 12, select: { id: true, symbol: true, kind: true, phase: true, outcome: true, score: true, vel5mPct: true, volBurstX: true, detectedAt: true, resolvedAt: true, signalId: true } });
  console.log("recent tracks:");
  for (const r of recent) console.log(` ${r.detectedAt.toISOString()} ${r.kind} ${r.symbol} score=${r.score} vel5m=${r.vel5mPct} burst=${r.volBurstX} phase=${r.phase} outcome=${r.outcome} signalId=${r.signalId ? "YES" : "-"}`);
  const settings = await db.engineSetting.findMany({ where: { key: { startsWith: "pump." } } });
  console.log("pump settings:", JSON.stringify(settings.map((s) => ({ key: s.key, value: s.value }))));
  const evs = await db.engineEvent.findMany({ where: { kind: { contains: "PUMP" } }, orderBy: { at: "desc" }, take: 15, select: { at: true, symbol: true, kind: true, severity: true, message: true } });
  console.log("recent PUMP events:");
  for (const e of evs) console.log(` ${e.at.toISOString()} [${e.kind}/${e.severity}] ${e.symbol ?? "-"} :: ${e.message.slice(0, 150)}`);
  const radarVeto = await db.engineEvent.findMany({ where: { message: { contains: "RADAR" } }, orderBy: { at: "desc" }, take: 10, select: { at: true, kind: true, message: true } });
  console.log("recent RADAR-mention events:");
  for (const e of radarVeto) console.log(` ${e.at.toISOString()} [${e.kind}] ${e.message.slice(0, 150)}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
