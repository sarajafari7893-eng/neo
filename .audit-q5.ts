import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const fa = (d?: Date | null): string => (d ? new Date(d.getTime() + 12600000).toISOString().replace('T', ' ').slice(0, 19) : '-');
async function main() {
  const rows = await p.marketAsset.findMany({ where: { symbol: { in: ['1000PEPEUSDT', 'QUSDT', 'JCTUSDT', 'EVAAUSDT', 'APRUSDT', 'QNTUSDT', 'BTCUSDT', 'ETHUSDT'] } }, select: { symbol: true, price: true, source: true, exchanges: true, volume24h: true, updatedAt: true } });
  for (const r of rows) {
    let venues: Array<{ venue: string; price: number }> = [];
    try { venues = JSON.parse(r.exchanges ?? '[]'); } catch {}
    console.log(`${r.symbol} price=${r.price} src=${r.source} vol24h=${Math.round(r.volume24h)} venues=${venues.length}[${venues.map(v => v.venue).join(',')}] upd=${fa(r.updatedAt)}`);
  }
}
main().finally(() => p.$disconnect());
