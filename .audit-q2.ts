import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const fa = (d?: Date | null): string => (d ? new Date(d.getTime() + 12600000).toISOString().replace('T', ' ').slice(0, 19) : '-');
async function main() {
  const s = await p.signal.findUnique({ where: { serial: 3196 }, select: { beBankedFrac: true, beBankedMovePct: true, maxPostPnlPercent: true, initialStopLoss: true, entryZoneLow: true, entryZoneHigh: true, confidence: true, strategy: true, analysis: true } });
  console.log('S3196-X', JSON.stringify(s, null, 1));
  const evAll = await p.signalEvent.findMany({ where: { signal: { serial: 3196 } }, orderBy: { createdAt: 'desc' }, take: 8, select: { type: true, message: true, createdAt: true } });
  console.log('RECENT-EVENTS'); for (const e of evAll) console.log(`  ${fa(e.createdAt)} ${e.type} ${e.message.slice(0, 200)}`);
  const evSys = await p.signalEvent.findMany({ where: { type: { in: ['ENGINE', 'SYSTEM'] }, message: { contains: '3196' } }, orderBy: { createdAt: 'desc' }, take: 6, select: { type: true, message: true, createdAt: true } });
  console.log('SYS-RE-3196'); for (const e of evSys) console.log(`  ${fa(e.createdAt)} ${e.type} ${e.message.slice(0, 200)}`);
}
main().finally(() => p.$disconnect());
