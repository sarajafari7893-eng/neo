import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const fa = (d?: Date | null): string => (d ? new Date(d.getTime() + 12600000).toISOString().replace('T', ' ').slice(0, 19) : '-');
async function main() {
  const first = await p.signalEvent.findFirst({ where: { message: { contains: 'SETTLEMENT STALLED' }, message: { contains: '1000PEPE' } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true, message: true } });
  console.log('FIRST-PEPE-STALL', first ? fa(first.createdAt) : 'none');
  const firstFloor = await p.signalEvent.findFirst({ where: { message: { contains: 'LIQUIDITY-FLOOR' }, message: { contains: '1000PEPE' } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  console.log('FIRST-PEPE-FLOOR', firstFloor ? fa(firstFloor.createdAt) : 'none');
  const pts = await p.pricePoint.findMany({ where: { symbol: '1000PEPEUSDT' }, orderBy: { createdAt: 'desc' }, take: 3, select: { price: true, createdAt: true } });
  console.log('LAST-PRICEPOINTS'); for (const x of pts) console.log(`  ${fa(x.createdAt)} ${x.price}`);
}
main().finally(() => p.$disconnect());
