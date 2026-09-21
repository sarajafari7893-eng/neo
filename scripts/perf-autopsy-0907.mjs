// NEXUS-LIVE performance autopsy — why is signal tracking PnL negative?
// Light read-only Prisma raw queries. No build, no dev server interaction.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const r2 = (x) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 100) / 100 : n; };
const wr = (w, n) => (Number(n) > 0 ? Math.round((Number(w) * 10000) / Number(n)) / 100 : 0);

async function main() {
  const total = await prisma.signal.count();
  const closedRows = await prisma.$queryRawUnsafe(`
    SELECT status, COUNT(*) n, AVG(pnlPercent) aPct,
           SUM(feeUsd) fees, SUM(swapUsd) swap,
           SUM(reachedTp) tpSum, AVG(maxPnlPercent) avgMfe,
           SUM(pnlPercent/100*marginUsd) usd
    FROM Signal WHERE status != 'ACTIVE' GROUP BY status ORDER BY usd`);
  console.log('=== OUTCOME BUCKETS (closed/expired/stopped) ===');
  for (const b of closedRows) {
    console.log(`${b.status.padEnd(8)} n=${String(b.n).padStart(3)} avgPct=${r2(b.aPct).toString().padStart(8)} netUsd=${r2(b.usd).toString().padStart(9)} fees=${r2(b.fees)} swap=${r2(b.swap)} avgMFE=${r2(b.avgMfe)} tpHits=${b.tpSum}`);
  }

  const win = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n, AVG(pnlPercent) aPct, SUM(pnlPercent/100*marginUsd) usd, AVG(maxPnlPercent) mfe
    FROM Signal WHERE status!='ACTIVE' AND pnlPercent > 0`);
  const loss = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n, AVG(pnlPercent) aPct, SUM(pnlPercent/100*marginUsd) usd, AVG(maxPnlPercent) mfe
    FROM Signal WHERE status!='ACTIVE' AND pnlPercent < 0`);
  console.log('\n=== WIN/LOSS ASYMMETRY ===');
  console.log(`wins : n=${win[0].n} avg=${r2(win[0].aPct)}% usd=${r2(win[0].usd)} avgMFE=${r2(win[0].mfe)}%`);
  console.log(`loss : n=${loss[0].n} avg=${r2(loss[0].aPct)}% usd=${r2(loss[0].usd)} avgMFE=${r2(loss[0].mfe)}%`);

  const fees = await prisma.$queryRawUnsafe(`
    SELECT SUM(feeUsd) f, SUM(swapUsd) s, SUM(pnlPercent/100*marginUsd) net, SUM(marginUsd) m
    FROM Signal WHERE status!='ACTIVE'`);
  console.log(`fees total=$${r2(fees[0].f)} swap total=$${r2(fees[0].s)} netPnL=$${r2(fees[0].net)} marginDeployed=$${r2(fees[0].m)}`);

  console.log('\n=== BY STRATEGY ===');
  const byStrat = await prisma.$queryRawUnsafe(`
    SELECT strategy, COUNT(*) n,
      SUM(CASE WHEN pnlPercent>0 THEN 1 ELSE 0 END) w,
      SUM(pnlPercent/100*marginUsd) usd, AVG(pnlPercent) aPct
    FROM Signal WHERE status!='ACTIVE' GROUP BY strategy ORDER BY usd`);
  for (const s of byStrat) console.log(`${s.strategy.padEnd(13)} n=${String(s.n).padStart(3)} winRate=${wr(s.w, s.n)}% netUsd=${r2(s.usd).toString().padStart(9)} avgPct=${r2(s.aPct)}`);

  console.log('\n=== BY DIRECTION ===');
  const byDir = await prisma.$queryRawUnsafe(`
    SELECT direction, COUNT(*) n,
      SUM(CASE WHEN pnlPercent>0 THEN 1 ELSE 0 END) w,
      SUM(pnlPercent/100*marginUsd) usd
    FROM Signal WHERE status!='ACTIVE' GROUP BY direction`);
  for (const s of byDir) console.log(`${s.direction} n=${s.n} winRate=${wr(s.w, s.n)}% netUsd=${r2(s.usd)}`);

  console.log('\n=== TOP 10 BLEEDING SYMBOLS ===');
  const bySym = await prisma.$queryRawUnsafe(`
    SELECT symbol, COUNT(*) n, SUM(pnlPercent/100*marginUsd) usd,
      SUM(CASE WHEN pnlPercent>0 THEN 1 ELSE 0 END) w
    FROM Signal WHERE status!='ACTIVE' GROUP BY symbol ORDER BY usd LIMIT 10`);
  for (const s of bySym) console.log(`${s.symbol.padEnd(13)} n=${String(s.n).padStart(3)} wins=${s.w} netUsd=${r2(s.usd)}`);

  console.log('\n=== EXPIRED AFTERLIFE (were we right but TTL too short?) ===');
  const al = await prisma.$queryRawUnsafe(`
    SELECT afterlife, COUNT(*) n, AVG(maxPostPnlPercent) post, AVG(pnlPercent) exitPct
    FROM Signal WHERE status='EXPIRED' GROUP BY afterlife`);
  for (const a of al) console.log(`afterlife=${(a.afterlife || 'NULL').padEnd(9)} n=${String(a.n).padStart(3)} avgPostExpiryPct=${r2(a.post)} avgExitPct=${r2(a.exitPct)}`);

  console.log('\n=== MFE GIVE-BACK (hit TP1+ then died at SL/EXPIRED) ===');
  const g1 = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n FROM Signal WHERE status='SL' AND reachedTp>0`);
  const g2 = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n, AVG(pnlPercent) a, AVG(maxPnlPercent) mfe FROM Signal
    WHERE status='SL' AND maxPnlPercent >= 30`);
  const g3 = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n, AVG(pnlPercent) a FROM Signal
    WHERE status IN ('SL','EXPIRED') AND maxPnlPercent < 5`);
  console.log(`SL after reaching a TP: n=${g1[0].n}`);
  console.log(`SL with MFE>=30% (big give-back): n=${g2[0].n} avgExit=${r2(g2[0].a)}% avgMFE=${r2(g2[0].mfe)}%`);
  console.log(`SL/EXPIRED that never went anywhere (MFE<5%): n=${g3[0].n} avgExit=${r2(g3[0].a)}%`);

  console.log('\n=== R:R GEOMETRY (declared vs structure) ===');
  const geo = await prisma.$queryRawUnsafe(`
    SELECT AVG(ABS(tp1-entryPrice)/entryPrice*100*leverage) tp1Pct,
           AVG(ABS(entryPrice-stopLoss)/entryPrice*100*leverage) slPct,
           AVG(riskReward) rr, AVG(leverage) lev, AVG(confidence) conf
    FROM Signal`);
  console.log(`avg tp1 dist=${r2(geo[0].tp1Pct)}% (levered) | avg SL dist=${r2(geo[0].slPct)}% (levered) | declared RR=${r2(geo[0].rr)} | avg lev=${r2(geo[0].lev)}x | avg conf=${r2(geo[0].conf)}`);

  console.log('\n=== CONFIDENCE vs OUTCOME ===');
  const conf = await prisma.$queryRawUnsafe(`
    SELECT (confidence/10)*10 band, COUNT(*) n,
      SUM(CASE WHEN pnlPercent>0 THEN 1 ELSE 0 END) w,
      SUM(pnlPercent/100*marginUsd) usd
    FROM Signal WHERE status!='ACTIVE' GROUP BY band ORDER BY band`);
  for (const c of conf) { const b = Number(c.band); console.log(`conf ${String(b).padStart(2)}-${b + 9}: n=${String(c.n).padStart(3)} winRate=${wr(c.w, c.n)}% netUsd=${r2(c.usd)}`); }

  console.log('\n=== TTL / HOLD TIME ===');
  const ttl = await prisma.$queryRawUnsafe(`
    SELECT AVG(ttlMinutes) ttl, AVG(ttlExtensions) ext,
      AVG((julianday(closedAt)-julianday(createdAt))*1440) holdMin
    FROM Signal WHERE status!='ACTIVE' AND closedAt IS NOT NULL`);
  console.log(`avg TTL=${r2(ttl[0].ttl)}m extensions=${r2(ttl[0].ext)} actual hold=${r2(ttl[0].holdMin)}m`);

  console.log('\n=== EQUITY RECONSTRUCTION ===');
  const eq = await prisma.$queryRawUnsafe(`
    SELECT SUM(pnlPercent/100*marginUsd + feeUsd + swapUsd) totalDrag FROM Signal`);
  console.log(`all-time realized incl fees/swap: $${r2(eq[0].totalDrag)}`);
  const last7d = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n, SUM(pnlPercent/100*marginUsd) usd FROM Signal
    WHERE status!='ACTIVE' AND closedAt > datetime('now','-24 hours')`);
  console.log(`last 24h closed: n=${last7d[0].n} netUsd=${r2(last7d[0].usd)}`);

  console.log('\n=== BREAKOUT AUTOPSY (the -$31 strategy) ===');
  const bk = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n,
      SUM(CASE WHEN maxPnlPercent<5 THEN 1 ELSE 0 END) instantFail,
      AVG(maxPnlPercent) mfe, AVG((julianday(closedAt)-julianday(createdAt))*1440) holdMin,
      SUM(feeUsd) fees
    FROM Signal WHERE strategy='BREAKOUT' AND status!='ACTIVE'`);
  console.log(`BREAKOUT closed: n=${bk[0].n} instantFail(MFE<5%)=${bk[0].instantFail} avgMFE=${r2(bk[0].mfe)}% avgHold=${r2(bk[0].holdMin)}m fees=$${r2(bk[0].fees)}`);

  console.log('\n=== PRE-ENTRY CHASE? (price move 15m before signal, from PricePoints) ===');
  const sigs = await prisma.$queryRawUnsafe(`
    SELECT symbol, strategy, direction, entryPrice, createdAt, pnlPercent, marginUsd, status
    FROM Signal WHERE status!='ACTIVE' ORDER BY createdAt`);
  let rows = [];
  for (const s of sigs) {
    const t0 = new Date(s.createdAt).getTime();
    const prior = await prisma.$queryRawUnsafe(
      `SELECT price, createdAt FROM PricePoint WHERE symbol=? AND createdAt <= ? AND createdAt >= ? ORDER BY createdAt DESC LIMIT 1`,
      s.symbol, new Date(t0 - 14 * 60000), new Date(t0 - 16 * 60000));
    if (prior.length) {
      const pre = ((s.entryPrice - prior[0].price) / prior[0].price) * 100 * (s.direction === 'SHORT' ? -1 : 1);
      rows.push({ strat: s.strategy, pre, usd: (s.pnlPercent / 100) * s.marginUsd, win: s.pnlPercent > 0 });
    }
  }
  const bucketize = (lo, hi) => rows.filter((x) => x.pre >= lo && x.pre < hi);
  for (const [lo, hi] of [[-99, -1], [-1, 1], [1, 3], [3, 6], [6, 99]]) {
    const b = bucketize(lo, hi);
    if (!b.length) continue;
    const w = b.filter((x) => x.win).length;
    const usd = b.reduce((a, x) => a + x.usd, 0);
    console.log(`preEntryMove ${lo}..${hi}% (chase-adjusted): n=${b.length} winRate=${Math.round((w * 100) / b.length)}% netUsd=${r2(usd)}`);
  }

  console.log('\n=== CADENCE / DATE RANGE ===');
  const dr = await prisma.$queryRawUnsafe(`
    SELECT MIN(createdAt) mn, MAX(createdAt) mx, COUNT(*) n FROM Signal`);
  const days = Math.max(1, (new Date(Number(dr[0].mx)) - new Date(Number(dr[0].mn))) / 86400000);
  console.log(`signals ${new Date(Number(dr[0].mn)).toISOString()} → ${new Date(Number(dr[0].mx)).toISOString()} | n=${Number(dr[0].n)} | ${r2(Number(dr[0].n) / days)}/day over ${r2(days)}d`);

  console.log('\n=== HOLD TIME SANITY ===');
  const hold = await prisma.$queryRawUnsafe(`
    SELECT MIN((julianday(closedAt)-julianday(createdAt))*1440) mn,
           MAX((julianday(closedAt)-julianday(createdAt))*1440) mx,
           AVG((julianday(closedAt)-julianday(createdAt))*1440) av
    FROM Signal WHERE closedAt IS NOT NULL AND status!='ACTIVE'`);
  console.log(`hold minutes min=${r2(hold[0].mn)} avg=${r2(hold[0].av)} max=${r2(hold[0].mx)}`);
  const sample = await prisma.$queryRawUnsafe(`
    SELECT createdAt, closedAt, status FROM Signal WHERE closedAt IS NOT NULL ORDER BY createdAt DESC LIMIT 4`);
  for (const s of sample) {
    const c = new Date(Number(s.createdAt)), x = new Date(Number(s.closedAt));
    console.log(`sample ${s.status}: created=${c.toISOString()} closed=${x.toISOString()} holdMin=${r2((x - c) / 60000)}`);
  }

  console.log('\n=== SIM: TP1 partial booking (50% at TP1 + SL to breakeven) on SL trades that reached a TP ===');
  const slTp = await prisma.$queryRawUnsafe(`
    SELECT id, symbol, direction, entryPrice, tp1, stopLoss, leverage, pnlPercent, marginUsd, maxPnlPercent, reachedTp, status
    FROM Signal WHERE status='SL' AND reachedTp>0`);
  let simSum = 0, actSum = 0;
  for (const s of slTp) {
    const levAdj = 1; // pnlPercent already levered net
    const tp1Pct = ((s.tp1 - s.entryPrice) / s.entryPrice) * 100 * s.leverage * (s.direction === 'SHORT' ? -1 : 1);
    const sim = 0.5 * tp1Pct + 0.5 * 0; // half booked at TP1, half flat at breakeven stop
    simSum += (sim / 100) * s.marginUsd;
    actSum += (s.pnlPercent / 100) * s.marginUsd;
  }
  console.log(`n=${slTp.length} actual=$${r2(actSum)} → simulated=$${r2(simSum)} (delta ${r2(simSum - actSum)})`);

  console.log('\n=== WHAT-IF SCENARIOS ===');
  const rowsAll = await prisma.$queryRawUnsafe(`
    SELECT strategy, direction, confidence, pnlPercent, marginUsd FROM Signal WHERE status!='ACTIVE'`);
  const netOf = (f) => r2(rowsAll.filter(f).reduce((a, x) => a + (x.pnlPercent / 100) * x.marginUsd, 0));
  console.log(`actual net            : $${netOf(() => true)}`);
  console.log(`without BREAKOUT      : $${netOf((x) => x.strategy !== 'BREAKOUT')}`);
  console.log(`without SHORT         : $${netOf((x) => x.direction !== 'SHORT')}`);
  console.log(`no BREAKOUT, no SHORT : $${netOf((x) => x.strategy !== 'BREAKOUT' && x.direction !== 'SHORT')}`);
  console.log(`only conf 70-79       : $${netOf((x) => x.confidence >= 70 && x.confidence < 80)}`);
}

main().catch((e) => { console.error('AUTOPSY ERROR', e); process.exit(1); }).finally(() => prisma.$disconnect());
