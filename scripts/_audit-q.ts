import { db } from '../src/lib/db';
type R = { serial: number; symbol: string; direction: string; status: string; pnlPercent: number; strategy: string; confidence: number; createdAt: Date };
(async () => {
  const total = await db.signal.count();
  const byStatus = await db.signal.groupBy({ by: ['status'], _count: true });
  const settled: R[] = await db.signal.findMany({
    where: { status: { notIn: ['ACTIVE', 'OPEN'] } },
    select: { serial: true, symbol: true, direction: true, status: true, pnlPercent: true, strategy: true, confidence: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const wins = settled.filter((s) => s.pnlPercent > 0);
  const losses = settled.filter((s) => s.pnlPercent <= 0);
  const avg = (a: R[]) => (a.length ? a.reduce((x, s) => x + s.pnlPercent, 0) / a.length : 0);
  console.log('TOTAL', total, '| byStatus', JSON.stringify(byStatus.map((b) => ({ s: b.status, n: b._count }))));
  console.log('SETTLED', settled.length, 'WINS', wins.length, 'LOSSES', losses.length, 'WR%', ((100 * wins.length) / Math.max(1, settled.length)).toFixed(1));
  console.log('avgWin%', avg(wins).toFixed(2), 'avgLoss%', avg(losses).toFixed(2), 'expectancy%', avg(settled).toFixed(2));
  for (const st of ['TP1', 'TP2', 'TP3', 'SL', 'EXPIRED', 'CLOSED']) {
    const g = settled.filter((s) => s.status === st);
    if (g.length) console.log(`  ${st}: n=${g.length} wr=${((100 * g.filter((x) => x.pnlPercent > 0).length) / g.length).toFixed(0)}% avg=${avg(g).toFixed(2)}%`);
  }
  const byStrat = await db.signal.groupBy({ by: ['strategy'], _count: true, _avg: { pnlPercent: true } });
  console.log('BY_STRATEGY', JSON.stringify(byStrat.map((b) => ({ s: b.strategy, n: b._count, avg: (b._avg.pnlPercent ?? 0).toFixed(2) }))));
  const byDir = await db.signal.groupBy({ by: ['direction'], _count: true, _avg: { pnlPercent: true } });
  console.log('BY_DIR', JSON.stringify(byDir.map((b) => ({ s: b.direction, n: b._count, avg: (b._avg.pnlPercent ?? 0).toFixed(2) }))));
  const byConf = [[0, 60], [60, 70], [70, 80], [80, 101]].map(([lo, hi]) => {
    const g = settled.filter((s) => s.confidence >= lo && s.confidence < hi);
    return { conf: `${lo}-${hi}`, n: g.length, wr: ((100 * g.filter((x) => x.pnlPercent > 0).length) / Math.max(1, g.length)).toFixed(0), avg: avg(g).toFixed(2) };
  });
  console.log('BY_CONF', JSON.stringify(byConf));
  console.log('--- LAST 30 SETTLED ---');
  for (const s of settled.slice(-30)) console.log(`NX-${String(s.serial).padStart(3, '0')} ${s.symbol.padEnd(12)} ${s.direction.padEnd(5)} ${s.status.padEnd(7)} ${s.pnlPercent.toFixed(2).padStart(7)}% conf=${s.confidence} ${s.strategy} ${s.createdAt.toISOString().slice(5, 16)}`);
  const fee = await db.signal.aggregate({ _sum: { feeUsd: true, pnlPercent: true, maxPnlPercent: true } });
  console.log('AGG fees$', fee._sum.feeUsd?.toFixed(2), 'sumPnl%', fee._sum.pnlPercent?.toFixed(1), 'sumMaxPnl%', fee._sum.maxPnlPercent?.toFixed(1));
  process.exit(0);
})();
