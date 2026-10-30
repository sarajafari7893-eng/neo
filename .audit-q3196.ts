import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const fa = (d?: Date | null): string => (d ? new Date(d.getTime() + 12600000).toISOString().replace('T', ' ').slice(0, 19) : '-');
async function main() {
  const s = await p.signal.findUnique({ where: { serial: 3196 } });
  if (s) console.log('S3196', JSON.stringify({ serial: s.serial, symbol: s.symbol, direction: s.direction, status: s.status, entryPrice: s.entryPrice, stopLoss: s.stopLoss, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, qualityFlag: s.qualityFlag, ttlMinutes: s.ttlMinutes, createdAt: fa(s.createdAt), afterlife: s.afterlife, afterlifeAt: fa(s.afterlifeAt), reachedTp: s.reachedTp, maxPnlPercent: s.maxPnlPercent, pnlPercent: s.pnlPercent, leverage: s.leverage, timeframe: s.timeframe, ttlExtensions: s.ttlExtensions }, null, 1));
  else console.log('S3196 NOT FOUND');
  const ev = await p.signalEvent.findMany({ where: { signal: { serial: 3196 } }, orderBy: { createdAt: 'asc' }, select: { type: true, message: true, createdAt: true } });
  console.log('EVENTS'); for (const e of ev) console.log(`  ${fa(e.createdAt)} ${e.type} ${e.message.slice(0, 130)}`);
  const latest = await p.signal.findMany({ orderBy: { serial: 'desc' }, take: 15, select: { serial: true, symbol: true, direction: true, status: true, qualityFlag: true, createdAt: true } });
  console.log('LATEST15'); for (const r of latest) console.log(`  ${r.serial} ${r.symbol} ${r.direction} ${r.status} q=${r.qualityFlag ?? '-'} ${fa(r.createdAt)}`);
  const cnt6h = await p.signal.count({ where: { createdAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) } } });
  const cnt24h = await p.signal.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } });
  const activeList = await p.signal.findMany({ where: { status: 'ACTIVE' }, select: { serial: true, symbol: true, direction: true, createdAt: true, qualityFlag: true, stopLoss: true, entryPrice: true } });
  console.log(`COUNTS 6h=${cnt6h} 24h=${cnt24h} activeTotal=${activeList.length}`);
  for (const a of activeList) console.log(`  ACTIVE ${a.serial} ${a.symbol} ${a.direction} born=${fa(a.createdAt)} q=${a.qualityFlag ?? '-'} SL==E?${Math.abs(a.stopLoss - a.entryPrice) < 1e-9}`);
  const lastEvent = await p.signalEvent.findFirst({ orderBy: { createdAt: 'desc' }, select: { type: true, message: true, createdAt: true } });
  if (lastEvent) console.log(`LAST_EVENT ${fa(lastEvent.createdAt)} ${lastEvent.type} ${lastEvent.message.slice(0, 140)}`);
}
main().finally(() => p.$disconnect());
