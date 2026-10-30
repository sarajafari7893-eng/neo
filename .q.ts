import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const fa = (d?: Date | null): string => (d ? new Date(d.getTime() + 12600000).toISOString().replace('T', ' ').slice(0, 19) : '-');
async function main() {
  const rows = await p.signal.findMany({ where: { serial: { in: [3203, 3204, 3206, 3207, 3208, 3209, 3210, 3211] } }, orderBy: { serial: 'asc' }, select: { serial: true, symbol: true, direction: true, status: true, pnlPercent: true, reachedTp: true, closedAt: true } });
  for (const r of rows) console.log(`${r.serial} ${r.symbol} ${r.direction} ${r.status} pnl=${r.pnlPercent} tp=${r.reachedTp} closed=${fa(r.closedAt)}`);
}
main().finally(() => p.$disconnect());
