// audit-flow-cohorts.ts — blind(=FLOW-NO-DATA) vs sighted cohort ledger split (Task-48 ② follow-up).
// Usage: bun scripts/audit-flow-cohorts.ts   (readonly; uses exact COVERAGE_KEYS from src/lib/flow.ts)
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const KEYS = ['oiDelta10m','oiDelta1h','oiValueUsd','cvdNetPctOfVol','takerRatio','takerMean','crowdLongShort','topLongShort','funding8h','cvdUsd60s'];
function classify(fj: string | null): 'blind' | 'sighted' | 'no-json' {
  if (!fj) return 'no-json';
  try {
    const o = JSON.parse(fj) as Record<string, unknown>;
    const m = (o.metrics && typeof o.metrics === 'object' ? o.metrics : o) as Record<string, unknown>;
    if (typeof o.coverage === 'number') return o.coverage === 0 ? 'blind' : 'sighted';
    const nonNull = KEYS.filter(k => m[k] !== null && m[k] !== undefined);
    return nonNull.length === 0 ? 'blind' : 'sighted';
  } catch { return 'no-json'; }
}
async function main() {
  const since = new Date(Date.now() - 10 * 864e5);
  const rows = await db.signal.findMany({ where: { createdAt: { gte: since }, status: { notIn: ['ACTIVE'] } }, select: { flowJson: true, pnlPercent: true, marginUsd: true } });
  const agg: Record<string, { n: number; wins: number; netUsd: number }> = { blind: {n:0,wins:0,netUsd:0}, sighted: {n:0,wins:0,netUsd:0}, 'no-json': {n:0,wins:0,netUsd:0} };
  for (const r of rows) {
    const c = classify(r.flowJson);
    const usd = (r.marginUsd ?? 5) * (r.pnlPercent ?? 0) / 100;
    agg[c].n++; if ((r.pnlPercent ?? 0) > 0) agg[c].wins++; agg[c].netUsd += usd;
  }
  for (const k of Object.keys(agg)) { const a = agg[k]; console.log(`${k.toUpperCase().padEnd(8)} n=${String(a.n).padStart(4)} WR=${a.n ? (100*a.wins/a.n).toFixed(1) : '-'}% net=$${a.netUsd.toFixed(2)}`); }
  process.exit(0);
}
main().catch(e => { console.error('ERR', String(e).slice(0,200)); process.exit(1); });
