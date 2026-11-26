// Task 42 — replay the AGTUSDT storm through the v11.8 RE-ARMED retest gate
// (latest-eruption core + forming-bar inclusion + pre-eruption-close leg math
// + both alignments) using the in-DB PricePoint tape (Binance fapi is IP-
// banned right now — the DB tape IS the engine's own fallback source).
import { db } from '../src/lib/db';
import { resampleTicks, latestOnsetCore, coreToTag } from '../src/lib/volOnset';

(async () => {
  const storm = [
    { serial: 2640, created: '2026-10-17T01:10:26Z', pnl: 7.32 },
    { serial: 2643, created: '2026-10-17T01:16:19Z', pnl: -61.2 },
    { serial: 2645, created: '2026-10-17T01:27:23Z', pnl: -61.19 },
    { serial: 2646, created: '2026-10-17T01:28:03Z', pnl: -61.19 },
    { serial: 2647, created: '2026-10-17T01:28:27Z', pnl: -61.2 },
    { serial: 2648, created: '2026-10-17T01:31:19Z', pnl: 7.27 },
    { serial: 2684, created: '2026-10-17T08:58:14Z', pnl: 5.42 },
  ];

  const rows = await db.signal.findMany({
    where: { symbol: 'AGTUSDT', serial: { in: storm.map((s) => s.serial) } },
    select: { serial: true, direction: true, entryPrice: true, createdAt: true },
  });
  const bySerial = new Map(rows.map((r) => [r.serial, r]));

  console.log('=== REPLAY with v11.8 retest gate (latest-eruption + forming-bar + CHASE&FADE) ===');
  let blockedLoss = 0, blockedWin = 0, allowedLoss = 0, allowedWin = 0;
  for (const s of storm) {
    const row = bySerial.get(s.serial);
    if (!row) { console.log(`NX-${s.serial}: row missing`); continue; }
    const T = new Date(s.created).getTime();
    const pts = await db.pricePoint.findMany({
      where: { symbol: 'AGTUSDT', createdAt: { gte: new Date(T - 50 * 3600_000), lt: new Date(T) } },
      orderBy: { createdAt: 'asc' }, select: { price: true, createdAt: true },
    });
    const bars = resampleTicks(pts.map((p) => ({ t: p.createdAt.getTime(), p: p.price })));
    const core = latestOnsetCore(bars, T);
    const price = row.entryPrice;
    const isLong = row.direction === 'LONG';
    let verdict = 'ALLOW (no fresh eruption in view)';
    if (core) {
      const tag = coreToTag(core);
      if (!tag.hot) {
        verdict = `ALLOW (latest eruption not hot — ${tag.detail.slice(0, 70)})`;
      } else {
        const erupUp = core.direction === 1;
        const aligned = (isLong && erupUp) || (!isLong && !erupUp);
        const kind = aligned ? 'CHASE' : 'FADE';
        const erupIdx = bars.findIndex((b) => b.openTime === core.eruptionAt);
        const erupRef = erupIdx > 0 ? bars[erupIdx - 1]!.close : bars[erupIdx]?.open;
        if (erupRef && erupRef > 0) {
          const post = bars.slice(Math.max(0, erupIdx));
          const extreme = erupUp ? Math.max(...post.map((b) => b.high)) : Math.min(...post.map((b) => b.low));
          const leg = Math.abs(extreme - erupRef);
          if (leg / erupRef >= 0.003) {
            const retr = leg > 0 ? (erupUp ? extreme - price : price - extreme) / leg : 1;
            verdict = retr < 0.3
              ? `BLOCK — ${kind} ${erupUp ? 'UP' : 'DOWN'} eruption ${core.minutesSince}m old, ${(retr * 100).toFixed(0)}% retraced (<30%) · disp ×${core.displacementX.toFixed(1)}`
              : `ALLOW (retest done — ${(retr * 100).toFixed(0)}% ≥30%)`;
          } else verdict = `ALLOW (leg ${(leg / erupRef * 100).toFixed(2)}% <0.3% noise floor)`;
        } else verdict = 'ALLOW (erupRef unavailable)';
      }
    }
    const blocked = verdict.startsWith('BLOCK');
    if (blocked) { if (s.pnl < 0) blockedLoss += s.pnl; else blockedWin += s.pnl; }
    else { if (s.pnl < 0) allowedLoss += s.pnl; else allowedWin += s.pnl; }
    console.log(`NX-${s.serial} ${s.created.slice(11, 19)}Z ${row.direction.padEnd(5)} entry=${price.toPrecision(6)} pnl=${String(s.pnl).padStart(7)}% → ${verdict}`);
  }
  console.log(`\nCOUNTERFACTUAL: blocked loss $${(blockedLoss / 10).toFixed(2)} · blocked win $${(blockedWin / 10).toFixed(2)} (forgone) · allowed loss $${(allowedLoss / 10).toFixed(2)} · allowed win $${(allowedWin / 10).toFixed(2)}`);
  console.log(`NET effect of the re-armed gate on this storm: $${((blockedLoss + blockedWin) / 10).toFixed(2)} swing (losses avoided + wins forgone)`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
