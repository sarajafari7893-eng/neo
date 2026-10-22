// Task 41 — re-entry storm archaeology: same-symbol consecutive SL chains across the whole book
import { db } from '../src/lib/db';

const P = (d: any) => new Date(d).toISOString().replace('T', ' ').slice(0, 16);

(async () => {
  const rows = await db.signal.findMany({
    where: { createdAt: { gte: new Date('2026-09-25T00:00:00.000Z') } },
    select: {
      serial: true, symbol: true, direction: true, strategy: true, status: true,
      pnlPercent: true, createdAt: true, closedAt: true, tags: true, qualityFlag: true,
      marginUsd: true, events: { where: { type: { in: ['SL', 'TP1', 'TP2', 'TP3'] } }, select: { type: true, createdAt: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // group by symbol
  const bySym = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = bySym.get(r.symbol) || [];
    arr.push(r);
    bySym.set(r.symbol, arr);
  }

  // storm = consecutive same-symbol signals where gap ≤ 45min AND previous was a net loser (SL-ish)
  const storms: any[] = [];
  for (const [sym, arr] of bySym) {
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1]!, b = arr[i]!;
      const gapMin = (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) / 60000;
      const aClosed = a.closedAt ? new Date(a.closedAt).getTime() : null;
      // previous signal was a stop-class loser
      const aStop = a.pnlPercent < -10 && (a.status === 'SL' || a.events.some((e) => e.type === 'SL'));
      if (gapMin <= 45 && aStop) {
        storms.push({
          sym, gap: Math.round(gapMin * 10) / 10,
          prev: `NX-${a.serial} ${a.direction} ${P(a.createdAt)} ${a.status} ${a.pnlPercent.toFixed(1)}%`,
          next: `NX-${b.serial} ${b.direction} ${P(b.createdAt)} ${b.status} ${b.pnlPercent.toFixed(1)}%`,
          rawcal: b.tags?.includes('RAW-CAL') || false,
          prevCloseToNextCreate: aClosed ? Math.round(((new Date(b.createdAt).getTime() - aClosed) / 60000) * 10) / 10 : null,
        });
      }
    }
  }

  console.log(`=== STORM EDGES (same-symbol, gap≤45m, prev was stop-loser) — since 09-25: ${storms.length} ===`);
  // aggregate per symbol
  const perSym: any = {};
  for (const s of storms) perSym[s.sym] = (perSym[s.sym] || 0) + 1;
  console.log('per-symbol:', JSON.stringify(Object.entries(perSym).sort((a: any, b: any) => b[1] - a[1]).slice(0, 15)));

  // chain grouping: consecutive edges on same symbol where edge k's "next" signal == edge k+1's "prev" signal (continuous relay)
  const storms2 = storms;
  const chains: any[] = [];
  const used = new Set<number>();
  for (let i = 0; i < storms2.length; i++) {
    if (used.has(i)) continue;
    const chain = [storms2[i]!];
    used.add(i);
    let tail = storms2[i]!.next;
    for (let j = i + 1; j < storms2.length; j++) {
      if (used.has(j)) continue;
      if (storms2[j]!.sym === chain[0]!.sym && storms2[j]!.prev === tail) {
        chain.push(storms2[j]!);
        used.add(j);
        tail = storms2[j]!.next;
      }
    }
    if (chain.length >= 2) chains.push({ sym: chain[0]!.sym, edges: chain });
  }

  console.log(`\n=== STORM CHAINS (≥3 signals in a chain) — ${chains.length} ===`);
  for (const c of chains) {
    const first = c.edges[0].prev, last = c.edges[c.edges.length - 1].next;
    console.log(`\n▪ ${c.sym} — ${c.edges.length + 1} signals chained:`);
    console.log(`  start: ${first}`);
    for (const e of c.edges) console.log(`    gap ${e.gap}m → ${e.next}${e.rawcal ? ' [RAW-CAL]' : ''} (closed→create: ${e.prevCloseToNextCreate ?? '—'}m)`);
  }

  // dollar damage of storm signals: all signals that are part of any chain
  const chainSignals = new Set<string>();
  for (const c of chains) {
    chainSignals.add(c.edges[0].prev.split(' ')[0]);
    for (const e of c.edges) chainSignals.add(e.next.split(' ')[0]);
  }
  const stormRows = rows.filter((r) => chainSignals.has(`NX-${r.serial}`));
  const sumPnl = stormRows.reduce((a, r) => a + r.pnlPercent, 0);
  const losers = stormRows.filter((r) => r.pnlPercent < 0);
  console.log(`\n=== STORM BOOK (signals in chains ≥3): n=${stormRows.length} · sumPnl=${sumPnl.toFixed(1)}% (≈$${(sumPnl / 10).toFixed(2)}) · losers=${losers.length} · worst=${Math.min(...stormRows.map((r) => r.pnlPercent)).toFixed(1)}%`);
  const rc = stormRows.filter((r) => r.tags?.includes('RAW-CAL')).length;
  console.log(`RAW-CAL share: ${rc}/${stormRows.length}`);

  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
