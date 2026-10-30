import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const fa = (d?: Date | null): string => (d ? new Date(d.getTime() + 12600000).toISOString().replace('T', ' ').slice(0, 19) : '-');
async function main() {
  const evs = await p.signalEvent.findMany({ where: { message: { contains: '1000PEPE' }, createdAt: { gte: new Date(Date.now() - 10 * 3600 * 1000) } }, orderBy: { createdAt: 'desc' }, take: 12, select: { type: true, message: true, createdAt: true } });
  console.log('PEPE-EV-10H'); for (const e of evs) console.log(`  ${fa(e.createdAt)} ${e.type} ${e.message.slice(0, 180)}`);
  const stalls = await p.signalEvent.findMany({ where: { message: { contains: 'settlement' } }, orderBy: { createdAt: 'desc' }, take: 6, select: { message: true, createdAt: true } });
  console.log('SETTLE-STALL-EV'); for (const e of stalls) console.log(`  ${fa(e.createdAt)} ${e.message.slice(0, 180)}`);
}
main().finally(() => p.$disconnect());
