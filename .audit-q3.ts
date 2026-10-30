import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const fa = (d?: Date | null): string => (d ? new Date(d.getTime() + 12600000).toISOString().replace('T', ' ').slice(0, 19) : '-');
async function main() {
  const s = await p.signal.findUnique({ where: { serial: 3196 }, select: { expiresAt: true, closedAt: true } });
  console.log('S3196-TIME', JSON.stringify({ expiresAt: fa(s?.expiresAt), closedAt: fa(s?.closedAt) }));
  const ext = await p.signalEvent.findMany({ where: { type: 'TTL_EXTENDED' }, orderBy: { createdAt: 'desc' }, take: 5, select: { message: true, createdAt: true, signalId: true } });
  console.log('RECENT-TTL-EXT'); for (const e of ext) console.log(`  ${fa(e.createdAt)} ${e.message.slice(0, 150)}`);
  const expired = await p.signalEvent.findMany({ where: { type: { in: ['TTL_EXPIRED', 'EARLY_EXIT'] } }, orderBy: { createdAt: 'desc' }, take: 6, select: { type: true, message: true, createdAt: true } });
  console.log('RECENT-EXPIRY'); for (const e of expired) console.log(`  ${fa(e.createdAt)} ${e.type} ${e.message.slice(0, 150)}`);
}
main().finally(() => p.$disconnect());
