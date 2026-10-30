import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const rows = await p.marketAsset.findMany({ where: { symbol: { in: ['1000PEPEUSDT', 'QNTUSDT', 'QUSDT', 'WLDUSDT'] } }, select: { symbol: true, source: true, exchanges: true } });
  for (const r of rows) {
    const v: Array<{ venue: string; price: number | null; ok?: boolean }> = JSON.parse(r.exchanges ?? '[]');
    console.log(`${r.symbol} src=${r.source}`);
    for (const q of v) console.log(`   ${q.venue.padEnd(14)} price=${q.price ?? 'null'} ok=${q.ok ?? '-'}`);
  }
}
main().finally(() => p.$disconnect());
