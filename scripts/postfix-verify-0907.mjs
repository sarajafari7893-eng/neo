// POST-FIX VERIFY (v6.5) — read-only. Correct schema: Signal.direction/pnlPercent/closedAt,
// events in SignalEvent (type BE_TRAIL), $pnl ≈ marginUsd * pnlPercent/100 (levered NET).
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const J = (v) => JSON.parse(v);
const WIN_STATUS = ['TP1', 'TP2', 'TP3'];

async function main() {
  const gateRow = await prisma.engineSetting.findUnique({ where: { key: 'gate' } });
  const g = gateRow ? J(gateRow.value) : {};
  const gateAt = gateRow?.updatedAt ?? new Date(0);
  console.log(`GATE: breakoutGuard=${g.breakoutGuard} shortSizeMult=${g.shortSizeMult} beTrailPct=${g.beTrailPct} (updatedAt ${gateAt.toISOString()})`);

  // BE_TRAIL events since the fix went live
  const beTrails = await prisma.signalEvent.findMany({
    where: { type: 'BE_TRAIL', createdAt: { gte: gateAt } },
    orderBy: { createdAt: 'desc' }, take: 6,
    select: { createdAt: true, symbol: true, message: true },
  });
  const beTotal = await prisma.signalEvent.count({ where: { type: 'BE_TRAIL', createdAt: { gte: gateAt } } });
  console.log(`BE_TRAIL events since v6.5 gate write: ${beTotal}`);
  for (const e of beTrails) console.log('  ', e.createdAt.toISOString().slice(5, 16), e.symbol, '|', e.message.slice(0, 100));

  // Post-fix settled cohort (closed after gate write)
  const settled = await prisma.signal.findMany({
    where: { closedAt: { gte: gateAt } },
    select: { symbol: true, direction: true, strategy: true, status: true, pnlPercent: true, marginUsd: true, confidence: true, closedAt: true, reachedTp: true, maxPnlPercent: true },
    orderBy: { closedAt: 'desc' }, take: 100,
  });
  const dollars = (s) => (s.marginUsd * (s.pnlPercent || 0)) / 100;
  const sumPnl = settled.reduce((a, s) => a + dollars(s), 0);
  const wins = settled.filter(s => WIN_STATUS.includes(s.status)).length;
  const sl = settled.filter(s => s.status === 'SL').length;
  const exp = settled.filter(s => s.status === 'EXPIRED').length;
  console.log(`\nPOST-FIX SETTLED: n=${settled.length} | TP-win=${wins} SL=${sl} EXPIRED=${exp} | sumPnl=$${sumPnl.toFixed(2)}`);
  for (const s of settled.slice(0, 15)) {
    console.log(`  ${s.closedAt.toISOString().slice(5, 16)} ${s.symbol.padEnd(12)} ${s.direction.padEnd(5)} ${String(s.strategy).padEnd(10)} ${s.status.padEnd(8)} pnl=${(s.pnlPercent || 0).toFixed(1)}% ($${dollars(s).toFixed(2)}) mfe=${(s.maxPnlPercent || 0).toFixed(1)}%`);
  }

  // Post-fix DEPLOYED (still active) — do they carry v6.5 disclosure?
  const activePost = await prisma.signal.findMany({
    where: { status: 'ACTIVE', createdAt: { gte: gateAt } },
    select: { symbol: true, direction: true, strategy: true, confidence: true, createdAt: true, analysis: true },
    orderBy: { createdAt: 'desc' }, take: 5,
  });
  const activeCount = await prisma.signal.count({ where: { status: 'ACTIVE' } });
  console.log(`\nACTIVE total=${activeCount} | deployed post-fix=${activePost.length >= 0 ? '' : ''}`);
  for (const s of activePost) {
    const disclosed = /siz|guard|breakeven|BE-trail|trail/i.test(s.analysis || '');
    console.log(`  ${s.createdAt.toISOString().slice(5, 16)} ${s.symbol} ${s.direction} ${s.strategy} conf=${s.confidence} analysisDisclosesSizing=${disclosed}`);
  }

  // Engine version marker in recent signal rows
  const latest = await prisma.signal.findFirst({ orderBy: { createdAt: 'desc' }, select: { engine: true, createdAt: true } });
  if (latest) console.log(`\nLATEST SIGNAL ENGINE TAG: ${latest.engine} (deployed ${latest.createdAt.toISOString()})`);

  const dr = await prisma.engineSetting.findUnique({ where: { key: 'dailyreport' } });
  if (dr) {
    try { const v = J(dr.value); const last = (v.last ?? []).slice(-1)[0]; if (last) console.log('LAST DAILY REPORT: ok=', last.ok, 'at=', last.at, 'equity=', last.equity); } catch {}
  }
}

main().catch(e => console.error('VERIFY ERROR:', e.message?.slice(0, 300))).finally(() => prisma.$disconnect());
