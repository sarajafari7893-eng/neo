// ── NEXUS//SIGNALS — one-shot simulated-data purge ──
// Wipes ALL seeded/simulated rows so the platform runs LIVE-ONLY:
//   • Signal + SignalEvent  → stats, win rate, equity, analytics reset to 0
//   • PricePoint            → history rebuilt from real Binance candles
//   • MarketAsset           → recreated from live Binance tickers by the
//                             engine's ensureAssets() on the next tick
// Run: bun scripts/purge-sim-data.ts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const [events, signals, points, assets] = await Promise.all([
    db.signalEvent.count(),
    db.signal.count(),
    db.pricePoint.count(),
    db.marketAsset.count(),
  ]);
  console.log("BEFORE:", { events, signals, points, assets });

  // order matters: events reference signals (SetNull FK, but clean anyway)
  const r1 = await db.signalEvent.deleteMany({});
  const r2 = await db.signal.deleteMany({});
  const r3 = await db.pricePoint.deleteMany({});
  const r4 = await db.marketAsset.deleteMany({});
  console.log(`DELETED: events=${r1.count} signals=${r2.count} pricePoints=${r3.count} marketAssets=${r4.count}`);

  const [e2, s2, p2, a2] = await Promise.all([
    db.signalEvent.count(),
    db.signal.count(),
    db.pricePoint.count(),
    db.marketAsset.count(),
  ]);
  console.log("AFTER:", { events: e2, signals: s2, points: p2, assets: a2 });
  console.log("DONE — engine will restore market assets from live Binance tickers on next tick.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
