const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
async function main() {
  const settled = ['TP1','TP2','TP3','SL','EXPIRED','CLOSED'];
  const epoch2Settled = await db.signal.count({ where: { status: { in: settled }, tags: { contains: 'EPOCH-2' } } });
  const totalSettled = await db.signal.count({ where: { status: { in: settled } } });
  const totalSignals = await db.signal.count();
  const active = await db.signal.count({ where: { status: { in: ['ACTIVE','TP1','TP2'] } } });
  const last5 = await db.signal.findMany({ orderBy: { serial: 'desc' }, take: 5, select: { serial: true, symbol: true, direction: true, status: true, strategy: true, createdAt: true, tags: true } });
  const pumpRows = await db.pumpTrack.findMany({ orderBy: { detectedAt: 'desc' }, take: 10, select: { symbol: true, kind: true, phase: true, outcome: true, score: true, mfePct: true, maePct: true, detectedAt: true, resolvedAt: true } });
  const gateRow = await db.engineSetting.findUnique({ where: { key: 'pump.gate.unlockedAt' } });
  const calRow = await db.engineSetting.findUnique({ where: { key: 'calibration.frozen' } });
  console.log(JSON.stringify({ epoch2Settled, totalSettled, totalSignals, active, last5, pumpRows, pumpGateUnlocked: gateRow, calFrozen: calRow ? JSON.parse(calRow.value).frozen : null }, null, 1));
  await db.$disconnect();
}
main();
