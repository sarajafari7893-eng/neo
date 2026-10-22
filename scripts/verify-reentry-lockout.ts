// Task 41 — replay AGTUSDT storm timeline through the v11.7 re-entry lockout logic (dry-run)
import { db } from '../src/lib/db';

(async () => {
  const cfg = { lockoutMinutes: 60, escalateMinutes: 180, escalateAfterStops: 2, windowHours: 24 };
  const storm = [
    { serial: 2633, created: '2026-10-16T23:31:14Z', closed: '2026-10-17T00:35:29Z', pnl: 84.71, status: 'TP3' },
    { serial: 2640, created: '2026-10-17T01:10:26Z', closed: '2026-10-17T01:16:07Z', pnl: 7.32, status: 'SL' },
    { serial: 2643, created: '2026-10-17T01:16:19Z', closed: '2026-10-17T01:26:55Z', pnl: -61.2, status: 'SL' },
    { serial: 2645, created: '2026-10-17T01:27:23Z', closed: '2026-10-17T01:27:59Z', pnl: -61.19, status: 'SL' },
    { serial: 2646, created: '2026-10-17T01:28:03Z', closed: '2026-10-17T01:28:11Z', pnl: -61.19, status: 'SL' },
    { serial: 2647, created: '2026-10-17T01:28:27Z', closed: '2026-10-17T01:28:51Z', pnl: -61.2, status: 'SL' },
    { serial: 2648, created: '2026-10-17T01:31:19Z', closed: '2026-10-17T01:31:59Z', pnl: 7.27, status: 'SL' },
    { serial: 2684, created: '2026-10-17T08:58:14Z', closed: '2026-10-17T09:02:21Z', pnl: 5.42, status: 'SL' },
  ];

  console.log('=== REPLAY with v11.7 REENTRY-LOCKOUT (60m / escalate 180m @2 stops) ===');
  const simulatedStops: { closedAt: number; pnl: number }[] = [];
  let saved = 0;
  for (const s of storm) {
    const t = new Date(s.created).getTime();
    const win = simulatedStops.filter((x) => t - x.closedAt < cfg.windowHours * 3600_000);
    const last = win.sort((a, b) => b.closedAt - a.closedAt)[0] ?? null;
    const lockoutMin = win.length >= cfg.escalateAfterStops ? cfg.escalateMinutes : cfg.lockoutMinutes;
    let decision = 'DEPLOY';
    if (last) {
      const minsSince = (t - last.closedAt) / 60_000;
      if (minsSince < lockoutMin) decision = `BLOCK (last stop ${minsSince.toFixed(1)}m ago < ${lockoutMin}m, stops/24h=${win.length})`;
    }
    const dollar = s.pnl / 10;
    if (decision.startsWith('BLOCK')) { saved += dollar; decision += '  → avoids ' + dollar.toFixed(2) + '$'; }
    else if (s.status === 'SL' && s.pnl < 0) simulatedStops.push({ closedAt: new Date(s.closed).getTime(), pnl: s.pnl });
    console.log(`NX-${s.serial} created=${s.created.slice(11, 19)}Z ${s.status.padEnd(4)} pnl=${String(s.pnl).padStart(7)}% ($${dollar.toFixed(2)}) → ${decision}`);
  }
  console.log(`\nREAL storm damage: -$23.02 · SIMULATED storm damage: $${(-23.02 - saved).toFixed(2)} · NET SAVED ≈ $${Math.abs(saved).toFixed(2)} (3 stops avoided, 1 BE-bank win forgone)`);

  // live engine check: current lockout state for AGTUSDT (should be clear — last stop 09:02Z > 60m ago)
  const stops = await db.signal.findMany({
    where: { symbol: 'AGTUSDT', status: 'SL', pnlPercent: { lt: 0 }, closedAt: { gte: new Date(Date.now() - cfg.windowHours * 3600_000) } },
    select: { serial: true, closedAt: true, pnlPercent: true },
    orderBy: { closedAt: 'desc' },
  });
  console.log(`\nLIVE STATE now: ${stops.length} net-negative SL closes in last 24h → ${stops.length >= cfg.escalateAfterStops ? 'escalated 180m window' : stops.length === 1 ? '60m window' : 'no lockout'}`);
  for (const s of stops) console.log(`  NX-${s.serial} closed=${s.closedAt?.toISOString()} pnl=${s.pnlPercent.toFixed(1)}%`);
  const lastStop = stops[0];
  if (lastStop?.closedAt) {
    const mins = (Date.now() - new Date(lastStop.closedAt).getTime()) / 60000;
    console.log(`  minutes since last stop: ${mins.toFixed(0)}m → lockout ${mins < (stops.length >= cfg.escalateAfterStops ? cfg.escalateMinutes : cfg.lockoutMinutes) ? 'ACTIVE' : 'EXPIRED'} for new AGT deploys`);
  }

  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
