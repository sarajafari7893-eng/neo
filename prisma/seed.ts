/**
 * NEXUS//SIGNALS — Database Seeder
 * Creates market assets, historical signals (7 days), and event feed.
 * Run: bun prisma/seed.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

// deterministic-ish RNG
let seed = 1337;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const rr = (min: number, max: number) => min + rnd() * (max - min);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];

const ASSETS = [
  { symbol: "BTCUSDT", name: "Bitcoin", price: 97240, vol: 0.012 },
  { symbol: "ETHUSDT", name: "Ethereum", price: 3412, vol: 0.016 },
  { symbol: "SOLUSDT", name: "Solana", price: 189.4, vol: 0.024 },
  { symbol: "BNBUSDT", name: "BNB", price: 692.5, vol: 0.014 },
  { symbol: "XRPUSDT", name: "XRP", price: 2.41, vol: 0.028 },
  { symbol: "DOGEUSDT", name: "Dogecoin", price: 0.3184, vol: 0.032 },
  { symbol: "AVAXUSDT", name: "Avalanche", price: 36.72, vol: 0.026 },
  { symbol: "LINKUSDT", name: "Chainlink", price: 22.18, vol: 0.022 },
  { symbol: "TONUSDT", name: "Toncoin", price: 5.42, vol: 0.02 },
  { symbol: "ARBUSDT", name: "Arbitrum", price: 0.841, vol: 0.03 },
];

const STRATEGIES = ["AI-SCALP", "AI-SWING", "BREAKOUT", "MEAN-REVERT", "MOMENTUM"];
const TIMEFRAMES = ["5m", "15m", "1h", "4h"];
const TAG_POOL = [
  "liquidity-sweep", "fvg-fill", "order-block", "rsi-divergence", "vwap-reclaim",
  "range-break", "higher-low", "sentiment-shift", "volume-spike", "etf-flow",
  "whale-watch", "funding-reset", "trend-continuation", "support-hold",
];

function makeAnalysis(symbol: string, dir: string, strategy: string) {
  const narratives = [
    `${symbol} printed a clean ${dir === "LONG" ? "bullish" : "bearish"} ${strategy.toLowerCase()} structure on the ${pick(TIMEFRAMES)} chart. Order-flow shows ${dir === "LONG" ? "bid" : "ask"} absorption at range extremes with ${rr(1.5, 4).toFixed(1)}x delta imbalance. Funding normalized near ${rr(-0.02, 0.05).toFixed(3)}%, reducing squeeze risk. Invalidation sits below/above the protected ${dir === "LONG" ? "low" : "high"}; targets staged at prior liquidity pools.`,
    `AI detected a high-probability ${strategy} setup on ${symbol}. Liquidity engineering complete — ${dir === "LONG" ? "sell-side" : "buy-side"} liquidity swept ${rr(0.4, 2.1).toFixed(1)}% beyond range. CVD confirms ${dir === "LONG" ? "accumulation" : "distribution"} while OI rose ${rr(2, 9).toFixed(1)}%. Expect expansion toward the ${dir === "LONG" ? "upper" : "lower"} value-area edge. Tight invalidation behind structure.`,
    `${symbol} ${dir === "LONG" ? "reclaimed" : "rejected"} the daily VWAP band with expanding volume (${rr(120, 260).toFixed(0)}% rel. vol). Volatility contraction pattern broke in favor of ${dir === "LONG" ? "upside" : "downside"} continuation. Model ensemble (LSTM + transformer + orderbook CNN) votes ${rr(78, 96).toFixed(0)}% confidence. Scale-out plan embedded in targets.`,
  ];
  return pick(narratives);
}

function makeSpark(start: number, vol: number, n = 48) {
  const pts: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p = p * (1 + (rnd() - 0.48) * vol);
    pts.push(Number(p.toFixed(p > 100 ? 1 : 4)));
  }
  return pts;
}

async function main() {
  console.log("⚡ Seeding NEXUS//SIGNALS ...");
  await db.signalEvent.deleteMany();
  await db.signal.deleteMany();
  await db.pricePoint.deleteMany();
  await db.marketAsset.deleteMany();

  // ── Market assets ──
  for (const a of ASSETS) {
    const spark = makeSpark(a.price, a.vol);
    const change = ((spark[spark.length - 1] - spark[0]) / spark[0]) * 100;
    await db.marketAsset.create({
      data: {
        symbol: a.symbol,
        name: a.name,
        price: a.price,
        prevPrice: a.price,
        change24h: Number(change.toFixed(2)),
        high24h: Number((a.price * 1.03).toFixed(4)),
        low24h: Number((a.price * 0.96).toFixed(4)),
        volume24h: Math.round(rr(80_000_000, 4_200_000_000)),
        sparkline: JSON.stringify(spark),
      },
    });
  }
  console.log(`✔ ${ASSETS.length} market assets`);

  // ── Historical signals (7 days) ──
  const now = Date.now();
  const total = 34;
  for (let i = 0; i < total; i++) {
    const asset = pick(ASSETS);
    const direction = rnd() > 0.44 ? "LONG" : "SHORT";
    const entry = asset.price * (1 + (rnd() - 0.5) * 0.08);
    const isLong = direction === "LONG";
    const slDist = rr(0.012, 0.038); // 1.2% - 3.8%
    const stopLoss = isLong ? entry * (1 - slDist) : entry * (1 + slDist);
    const rMult = rr(1.4, 3.4);
    const tp1 = isLong ? entry + (entry - stopLoss) * 1.0 : entry - (stopLoss - entry) * 1.0;
    const tp2 = isLong ? entry + (entry - stopLoss) * 1.8 : entry - (stopLoss - entry) * 1.8;
    const tp3 = isLong ? entry + (entry - stopLoss) * rMult : entry - (stopLoss - entry) * rMult;
    const created = new Date(now - rr(0.5, 167) * 3600_000); // last 7 days
    const ttl = pick([45, 60, 90, 120, 180, 240]);
    const expiresAt = new Date(created.getTime() + ttl * 60_000);
    const lev = pick([5, 10, 10, 20, 25, 50]);

    // resolve outcome — pnl% = price-move × leverage × 100
    const roll = rnd();
    let status = "ACTIVE";
    let pnl = 0;
    let closedAt: Date | null = null;
    if (created.getTime() < now - ttl * 60_000) {
      if (roll < 0.41) { status = "TP3"; pnl = rMult * slDist * lev * 100; }
      else if (roll < 0.55) { status = "TP2"; pnl = 1.8 * slDist * lev * 100; }
      else if (roll < 0.64) { status = "TP1"; pnl = 1.0 * slDist * lev * 100; }
      else if (roll < 0.78) { status = "SL"; pnl = -slDist * lev * 100 * rr(0.9, 1.05); }
      else { status = "EXPIRED"; pnl = rr(-14, 18); }
      closedAt = expiresAt;
    }

    const sig = await db.signal.create({
      data: {
        symbol: asset.symbol,
        direction,
        entryPrice: Number(entry.toFixed(entry > 100 ? 1 : 4)),
        entryZoneLow: Number((entry * 0.998).toFixed(entry > 100 ? 1 : 4)),
        entryZoneHigh: Number((entry * 1.002).toFixed(entry > 100 ? 1 : 4)),
        tp1: Number(tp1.toFixed(entry > 100 ? 1 : 4)),
        tp2: Number(tp2.toFixed(entry > 100 ? 1 : 4)),
        tp3: Number(tp3.toFixed(entry > 100 ? 1 : 4)),
        stopLoss: Number(stopLoss.toFixed(entry > 100 ? 1 : 4)),
        leverage: lev,
        marginUsd: pick([100, 150, 200, 250, 500, 1000]),
        confidence: Math.round(rr(62, 97)),
        riskReward: Number(rMult.toFixed(2)),
        timeframe: pick(TIMEFRAMES),
        strategy: pick(STRATEGIES),
        status,
        pnlPercent: Number(pnl.toFixed(2)),
        maxPnlPercent: Number(Math.max(pnl, pnl + rr(0, 25)).toFixed(2)),
        analysis: makeAnalysis(asset.symbol, direction, "AI-SWING"),
        tags: Array.from(new Set([pick(TAG_POOL), pick(TAG_POOL)])).join(","),
        ttlMinutes: ttl,
        expiresAt,
        createdAt: created,
        closedAt,
      },
    });

    await db.signalEvent.create({
      data: { signalId: sig.id, symbol: sig.symbol, type: "CREATED", level: "ai", message: `${direction} signal deployed on ${sig.symbol} @ ${sig.entryPrice} — ${sig.strategy} ${sig.timeframe}`, createdAt: created },
    });
    if (status !== "ACTIVE") {
      const lvl = status.startsWith("TP") ? "success" : status === "SL" ? "error" : "warn";
      await db.signalEvent.create({
        data: { signalId: sig.id, symbol: sig.symbol, type: status, level: lvl, message: status === "SL" ? `${sig.symbol} stopped out @ ${sig.stopLoss}` : status === "EXPIRED" ? `${sig.symbol} TTL elapsed — auto-closed at ${pnl.toFixed(1)}%` : `${sig.symbol} ${status} target secured (${pnl > 0 ? "+" : ""}${pnl.toFixed(1)}%)`, createdAt: closedAt! },
      });
    }
  }

  // ── Active signals (not expired) ──
  for (let i = 0; i < 6; i++) {
    const asset = pick(ASSETS);
    const direction = rnd() > 0.5 ? "LONG" : "SHORT";
    const isLong = direction === "LONG";
    const entry = asset.price * (1 + (rnd() - 0.5) * 0.01);
    const slDist = rr(0.014, 0.032);
    const stopLoss = isLong ? entry * (1 - slDist) : entry * (1 + slDist);
    const rMult = rr(1.6, 3.2);
    const ttl = pick([90, 120, 180, 240]);
    const created = new Date(now - rr(5, ttl - 30) * 60_000);
    const lev = pick([10, 20, 25, 50]);
    const prog = rnd();
    let status = "ACTIVE";
    let pnl = rr(-10, 16) * (prog > 0.5 ? 1 : 0.4);
    if (prog > 0.78) { status = "TP2"; pnl = 1.8 * slDist * lev * 100 * rr(0.9, 1); }
    else if (prog > 0.55) { status = "TP1"; pnl = 1.0 * slDist * lev * 100 * rr(0.9, 1); }

    const sig = await db.signal.create({
      data: {
        symbol: asset.symbol,
        direction,
        entryPrice: Number(entry.toFixed(entry > 100 ? 1 : 4)),
        entryZoneLow: Number((entry * 0.998).toFixed(entry > 100 ? 1 : 4)),
        entryZoneHigh: Number((entry * 1.002).toFixed(entry > 100 ? 1 : 4)),
        tp1: Number((isLong ? entry + (entry - stopLoss) : entry - (stopLoss - entry)).toFixed(entry > 100 ? 1 : 4)),
        tp2: Number((isLong ? entry + (entry - stopLoss) * 1.8 : entry - (stopLoss - entry) * 1.8).toFixed(entry > 100 ? 1 : 4)),
        tp3: Number((isLong ? entry + (entry - stopLoss) * rMult : entry - (stopLoss - entry) * rMult).toFixed(entry > 100 ? 1 : 4)),
        stopLoss: Number(stopLoss.toFixed(entry > 100 ? 1 : 4)),
        leverage: lev,
        marginUsd: pick([150, 200, 250, 500, 1000]),
        confidence: Math.round(rr(70, 96)),
        riskReward: Number(rMult.toFixed(2)),
        timeframe: pick(TIMEFRAMES),
        strategy: pick(STRATEGIES),
        status,
        pnlPercent: Number(pnl.toFixed(2)),
        maxPnlPercent: Number((pnl + rr(0, 12)).toFixed(2)),
        analysis: makeAnalysis(asset.symbol, direction, "AI-SWING"),
        tags: Array.from(new Set([pick(TAG_POOL), pick(TAG_POOL)])).join(","),
        ttlMinutes: ttl,
        expiresAt: new Date(created.getTime() + ttl * 60_000),
        createdAt: created,
      },
    });
    await db.signalEvent.create({
      data: { signalId: sig.id, symbol: sig.symbol, type: "CREATED", level: "ai", message: `${direction} signal deployed on ${sig.symbol} @ ${sig.entryPrice} — ${sig.strategy} ${sig.timeframe}`, createdAt: created },
    });
    if (status !== "ACTIVE") {
      await db.signalEvent.create({
        data: { signalId: sig.id, symbol: sig.symbol, type: status, level: "success", message: `${sig.symbol} ${status} target secured`, createdAt: new Date(now - rr(1, 40) * 60_000) },
      });
    }
  }

  // ── Price points (1h candles for 48h) ──
  for (const a of ASSETS) {
    let p = a.price * 0.97;
    for (let i = 48; i > 0; i--) {
      p = p * (1 + (rnd() - 0.47) * a.vol);
      await db.pricePoint.create({
        data: { symbol: a.symbol, price: Number(p.toFixed(6)), createdAt: new Date(now - i * 3600_000) },
      });
    }
  }

  const counts = {
    signals: await db.signal.count(),
    events: await db.signalEvent.count(),
    assets: await db.marketAsset.count(),
    points: await db.pricePoint.count(),
  };
  console.log("✔ Seed complete:", counts);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
