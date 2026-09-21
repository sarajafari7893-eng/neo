// Inspect rolled-back DB via Prisma: settings, recent signals, data freshness
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const settings = await (p as any).engineSetting.findMany().catch(() => null);
  if (settings) {
    console.log(`EngineSetting rows: ${settings.length}`);
    for (const s of settings) {
      const key = s.key ?? s.id ?? '?';
      const val = String(s.value ?? '').slice(0, 120);
      console.log(`  SETTING ${key} = ${val}`);
    }
  } else {
    console.log('EngineSetting: model name mismatch, dumping delegate keys');
    console.log(Object.keys(p).filter((k) => !k.startsWith('_')).join(', '));
  }

  const signals = await (p as any).signal.findMany({
    orderBy: { createdAt: 'desc' }, take: 5,
  }).catch(async () => (p as any).signal.findMany({ orderBy: { id: 'desc' }, take: 5 }));

  console.log(`\nRecent signals (${signals.length}):`);
  for (const s of signals) {
    console.log(`  ${String(s.id).slice(0, 12)} ${s.symbol ?? ''} ${s.status ?? ''} opened=${s.openedAt ?? s.createdAt} pnl=${s.pnlUsd ?? s.pnl ?? '?'}`);
  }

  const counts = {
    signals: await (p as any).signal.count(),
    events: await (p as any).signalEvent.count().catch(() => 'n/a'),
    assets: await (p as any).marketAsset.count().catch(() => 'n/a'),
    prices: await (p as any).pricePoint.count().catch(() => 'n/a'),
  };
  console.log('\nCOUNTS:', JSON.stringify(counts));
}

main().finally(() => p.$disconnect());
