// Unit sanity for v6.1.1 evaluateTtlExtension — all inputs synthetic, DB untouched (momentum falls back to 0 on empty tape).
import { evaluateTtlExtension } from "@/lib/ttl-gate";
import { PrismaClient } from "@prisma/client";
import type { Signal } from "@prisma/client";
import type { GateSettings } from "@/lib/gate-settings";

const db = new PrismaClient();
// seed a declining 20m tape for TESTUSDT so the negative-momentum path is exercised for real
// (oldest at −19min so it survives the 20m window cut; oldest 101.6 > mark 101.0 → slope −0.59%)
await db.pricePoint.deleteMany({ where: { symbol: "TESTUSDT" } });
await db.pricePoint.createMany({
  data: [
    { symbol: "TESTUSDT", price: 101.6, createdAt: new Date(Date.now() - 19 * 60_000) },
    { symbol: "TESTUSDT", price: 101.3, createdAt: new Date(Date.now() - 10 * 60_000) },
    { symbol: "TESTUSDT", price: 101.0, createdAt: new Date(Date.now() - 60_000) },
  ],
});

const gate: GateSettings = { minScore: 25, flowShortlist: 5, flowVetoScore: 4, universeSize: 40, ttlExtendMax: 2, ttlExtendMinutes: 60, ttlNearTpPct: 1.5, slAtrMult: 1.5, rrScale: 1.0, regimeGuard: 1, maxActive: 5, riskPerTrade: 1.0, beTrailPct: 10, shortSizeMult: 0.5, breakoutGuard: 0, onsetRetestGuard: 0, chaseThrAdj: 0, leveredRiskCap: 100 };
const now = new Date();
function mk(partial: Partial<Signal>): Signal {
  return {
    id: "t", symbol: "TESTUSDT", direction: "LONG", status: "ACTIVE", serial: 1, confidence: 80, strategy: "EMA STACK", timeframe: "15m",
    entryPrice: 100, stopLoss: 97, tp1: 103, tp2: 106, tp3: 109, riskReward: 2, leverage: 10, marginUsd: 5, ttlMinutes: 120,
    createdAt: new Date(now.getTime() - 60 * 60_000), expiresAt: now, pnlPercent: 0, maxPnlPercent: 0, reachedTp: 0, ttlExtensions: 0,
    ...partial,
  } as Signal;
}

const cases: Array<[string, Signal, number, boolean]> = [
  // [name, signal, movePct%, expectGrant]
  // CHIPUSDT geometry: entry 100, mark +2.96 → TP sits 2.10% above the MARK (105.12) — the case that was denied before
  ["CHIP-case: profit +2.96, TP 2.10 away from mark (progress 58%) → NOW GRANTS", mk({ tp1: 105.12 }), 2.96, true],
  ["near-TP band: TP 0.9% away, flat move → grant", mk({ tp1: 100.9 }), 0.0, true],
  ["progress rule: +3.0 move, TP 2.9 away from mark (51%) → grant", mk({ tp1: 102.99 }), 3.0, true],
  ["progress short: +1.0 move, TP 2.5% away from mark (29%) + DECLINING tape → deny", mk({ tp1: 103.53 }), 1.0, false],
  ["drawdown guard: -2% move vs 3% SL dist (67% of risk) → deny", mk({ stopLoss: 97 }), -2.0, false],
  ["budget spent → deny", mk({ ttlExtensions: 2 }), 2.96, false],
  ["lifetime cap (3×TTL) → deny", mk({ createdAt: new Date(now.getTime() - 400 * 60_000), ttlMinutes: 120 }), 2.96, false],
  ["small profit + neutral tape (sparse, 0 slope = pass) → grant", mk({ symbol: "TEST2USDT", tp1: 105 }), 1.5, true],
];

let pass = 0;
for (const [name, s, move, expect] of cases) {
  const price = s.entryPrice * (1 + move / 100);
  const d = await evaluateTtlExtension(s, price, move, gate, now);
  const ok = d.grant === expect;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"} · ${name}\n      → grant=${d.grant} nearTp=${d.nearTp} · ${d.reason}`);
}
console.log(`\n${pass}/${cases.length} paths pass`);
await db.pricePoint.deleteMany({ where: { symbol: "TESTUSDT" } });
await db.$disconnect();
