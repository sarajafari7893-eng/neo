// Task 41 — AGTUSDT re-entry storm audit (operator mandate 2026-10-17)
import { db } from '../src/lib/db';

const P = (d: any) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

(async () => {
  // Tehran "today" 2026-10-17 00:00 (+03:30) = 2026-10-16T20:30Z
  const t0 = new Date('2026-10-16T20:30:00.000Z');

  const rows = await db.signal.findMany({
    where: { symbol: 'AGTUSDT', createdAt: { gte: new Date('2026-10-12T00:00:00.000Z') } },
    include: { events: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`TOTAL AGTUSDT rows since 10-12: ${rows.length}`);

  // ── section 1: today's rows in detail
  const today = rows.filter((r) => new Date(r.createdAt) >= t0);
  console.log(`\n=== AGTUSDT TODAY (Tehran 10-17, since ${t0.toISOString()}) : ${today.length} signals ===`);
  let prev: any = null;
  for (const s of today) {
    const gap = prev ? (new Date(s.createdAt).getTime() - new Date(prev.createdAt).getTime()) / 60000 : null;
    const evs = s.events.map((e) => `${new Date(e.createdAt).toISOString().slice(11, 19)} ${e.type}${e.type === 'SL' ? '' : ''}`).join(' | ');
    const tags = s.tags || '';
    console.log(
      `NX-${s.serial} ${P(s.createdAt)} ${s.direction.padEnd(5)} ${s.strategy.padEnd(12)} tf=${s.timeframe} conf=${s.confidence} ` +
      `entry=${s.entryPrice.toPrecision(8)} sl=${s.stopLoss.toPrecision(8)} rr=${s.riskReward} lev=${s.leverage}x ` +
      `status=${s.status} pnl=${s.pnlPercent.toFixed(2)}% max=${s.maxPnlPercent.toFixed(1)}% fee=$${s.feeUsd.toFixed(2)} ` +
      `gapFromPrev=${gap === null ? '—' : gap.toFixed(1) + 'm'} closed=${s.closedAt ? P(s.closedAt) : 'open'}`
    );
    console.log(`    events: ${evs || '(none)'}`);
    console.log(`    tags: ${tags.slice(0, 220)}`);
    prev = s;
  }

  // ── section 2: summary stats today
  if (today.length > 1) {
    const gaps = today.slice(1).map((s, i) => (new Date(s.createdAt).getTime() - new Date(today[i].createdAt).getTime()) / 60000);
    const stops = today.filter((s) => s.status === 'SL' || s.tags.includes('SL') || s.events.some((e) => e.type === 'SL'));
    const losers = today.filter((s) => s.pnlPercent < 0);
    console.log(`\n--- today summary ---`);
    console.log(`count=${today.length} · gap min=${Math.min(...gaps).toFixed(1)}m max=${Math.max(...gaps).toFixed(1)}m mean=${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)}m median=${gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)].toFixed(1)}m`);
    console.log(`SL-event rows=${stops.length} · net-losers=${losers.length} · sumPnl=${today.reduce((a, s) => a + s.pnlPercent, 0).toFixed(1)}% · sumFee=$${today.reduce((a, s) => a + s.feeUsd, 0).toFixed(2)}`);
    console.log(`directions: L=${today.filter((s) => s.direction === 'LONG').length} S=${today.filter((s) => s.direction === 'SHORT').length}`);
    console.log(`strategies: ${JSON.stringify(today.reduce((m: any, s) => { m[s.strategy] = (m[s.strategy] || 0) + 1; return m; }, {}))}`);
    console.log(`RAW-CAL tagged: ${today.filter((s) => s.tags.includes('RAW-CAL')).length}`);
    console.log(`qualityFlag non-null: ${today.filter((s) => s.qualityFlag).length}`);
  }

  // ── section 3: all-time AGTUSDT history since 10-12 compact
  console.log(`\n=== ALL AGTUSDT since 10-12 (compact) ===`);
  let pv: any = null;
  for (const s of rows) {
    const gap = pv ? ((new Date(s.createdAt).getTime() - new Date(pv.createdAt).getTime()) / 60000).toFixed(0) : '—';
    console.log(
      `NX-${String(s.serial).padStart(5)} ${P(s.createdAt)} UTC gap=${String(gap).padStart(6)}m ${s.direction.padEnd(5)} ${s.strategy.padEnd(12)} st=${s.status.padEnd(7)} pnl=${s.pnlPercent.toFixed(1).padStart(7)}% ${s.tags.includes('RAW-CAL') ? '[RAW-CAL]' : ''}`
    );
    pv = s;
  }

  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
