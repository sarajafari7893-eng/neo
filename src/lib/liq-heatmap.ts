// ── FlowRadar Neo v8.1 LIQUIDATION HEATMAP (P1 liq-deepening, server-only) ──
// Operator mandate 2026-09-08: «طبق نظر مهندسی P1 و P2 رو کامل اجرا کن».
//
// HONESTY CONTRACT: no exchange publishes leveraged-position maps. This module
// computes the standard volume-mapped ESTIMATE used by Coinglass-class tools:
// recent traded volume is bucketed by price, each bucket is projected through
// the popular leverage tiers (liq price = entry × (1 ∓ 1/lev)), and the
// projected mass is scaled by the symbol's REAL open-interest notional from
// the oi-funding board. Every surface that renders it must keep the
// "ESTIMATE" label — the module refuses to emit numbers when its inputs
// (klines, OI) are missing rather than inventing them.
//
// Semantics (the doctrine that drives the engine hooks):
//   · clusters BELOW price  = long liquidations  — flush fuel: price falling
//     into them tends to ACCELERATE down (magnet for an open/new LONG).
//   · clusters ABOVE price  = short liquidations — squeeze fuel: rallies into
//     them tend to ACCELERATE up (magnet for an open/new SHORT).
//
// Memory law: per-symbol result cache TTL 180s, map bounded at 64 symbols
// (evict-oldest), klines reused from the flow scanner cache when fresh —
// zero extra kline fetches on the hot path.

import { FUTURES_FAPI } from "./market-feed";
import { peekOiFund } from "./oi-funding";

export interface LiqCluster {
  side: "LONGS_BELOW" | "SHORTS_ABOVE";
  price: number; // bucket mid
  distPct: number; // signed distance from current price (%)
  estUsdM: number; // estimated liquidation notional in $M
  sharePct: number; // % of the symbol's mapped liq mass in this bucket
}

export interface LiqHeat {
  symbol: string;
  at: number;
  price: number;
  oiUsdM: number | null; // real OI notional used for scaling (null → unscaled estimate)
  oiScaled: boolean;
  totalBelowUsdM: number; // long-liq mass below price
  totalAboveUsdM: number; // short-liq mass above price
  clusters: LiqCluster[]; // significant buckets (≥6% share), sorted by |distPct|
  nearestBelow: LiqCluster | null;
  nearestAbove: LiqCluster | null;
}

const LEV_TIERS: ReadonlyArray<{ lev: number; weight: number }> = [
  { lev: 10, weight: 0.40 },
  { lev: 25, weight: 0.35 },
  { lev: 50, weight: 0.25 },
];
const BAND_PCT = 8; // map ±8% around price
const BUCKETS = 24;
const CLUSTER_MIN_SHARE = 0.06; // a bucket needs ≥6% of mapped mass to be "significant"
const CACHE_TTL = 180_000;
const CACHE_CAP = 64;

const heatCache = new Map<string, { at: number; v: LiqHeat | null }>();
const heatInFlight = new Map<string, Promise<LiqHeat | null>>();

function evictOldest(): void {
  if (heatCache.size <= CACHE_CAP) return;
  const oldest = [...heatCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
  if (oldest) heatCache.delete(oldest[0]);
}

interface K { openTime: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchKlines15m(symbol: string): Promise<K[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6500);
  try {
    const res = await fetch(`${FUTURES_FAPI}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=96`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return null;
    const raw = (await res.json()) as (string | number)[][];
    return raw.map((k) => ({ openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Compute the estimated heatmap for one symbol. Returns null when inputs are missing. */
async function computeHeat(symbol: string, klines: K[] | null): Promise<LiqHeat | null> {
  if (!klines || klines.length < 24) return null;
  const candles = klines.slice(0, -1); // closed bars only
  const price = candles[candles.length - 1]!.close;
  if (!(price > 0)) return null;

  const oiRow = peekOiFund(symbol);
  const oiUsdM = oiRow?.oiUsd ?? null;

  // volume mass per price bucket across the ±8% band (vwap-ish weighting by recency)
  const lo = price * (1 - BAND_PCT / 100);
  const hi = price * (1 + BAND_PCT / 100);
  const step = (hi - lo) / BUCKETS;
  const mass = new Float64Array(BUCKETS);
  const recent = candles.slice(-64); // last 16h of 15m bars
  let bandVol = 0;
  for (let i = 0; i < recent.length; i++) {
    const c = recent[i]!;
    const mid = (c.high + c.low + c.close) / 3;
    if (mid < lo || mid > hi) continue;
    const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor((mid - lo) / step)));
    mass[idx] += c.volume * (0.5 + (i / recent.length) * 0.5); // linear recency weight
    bandVol += c.volume;
  }
  if (bandVol <= 0) return null;

  // project each bucket's mass through the leverage tiers, BOTH directions:
  //   bucket price treated as entry → long liq price = entry×(1−1/lev),
  //   short liq price = entry×(1+1/lev); the liq price lands in another bucket.
  const below = new Float64Array(BUCKETS); // long-liq mass per bucket
  const above = new Float64Array(BUCKETS); // short-liq mass per bucket
  const scale = oiUsdM !== null && oiUsdM > 0 ? oiUsdM / bandVol : 1; // $M per unit volume (unscaled → unitless proxy)
  for (let i = 0; i < BUCKETS; i++) {
    if (mass[i] <= 0) continue;
    const entry = lo + step * (i + 0.5);
    for (const { lev, weight } of LEV_TIERS) {
      const liqLong = entry * (1 - 1 / lev);
      const liqShort = entry * (1 + 1 / lev);
      const w = mass[i] * weight;
      const li = Math.floor((liqLong - lo) / step);
      if (li >= 0 && li < BUCKETS) below[li] += w;
      const si = Math.floor((liqShort - lo) / step);
      if (si >= 0 && si < BUCKETS) above[si] += w;
    }
  }

  // scale is $M per unit base volume (oiUsdM / bandVol) — v is in base units,
  // so v×scale is ALREADY $M. Bug fix 2026-09-08: the previous /1e6 here was a
  // double division (the 1e6 conversion already happened in `scale`) which
  // collapsed every cluster to $0.0M on the board.
  const toUsdM = (v: number): number => Number((v * scale).toFixed(2));
  const sumBelow = below.reduce((a, b) => a + b, 0);
  const sumAbove = above.reduce((a, b) => a + b, 0);
  const total = sumBelow + sumAbove;
  if (total <= 0) return null;

  const clusters: LiqCluster[] = [];
  const push = (i: number, v: number, side: LiqCluster["side"]): void => {
    const share = v / total;
    if (share < CLUSTER_MIN_SHARE) return;
    const p = lo + step * (i + 0.5);
    clusters.push({
      side,
      price: Number(p.toFixed(p > 100 ? 2 : 6)),
      distPct: Number((((p - price) / price) * 100).toFixed(2)),
      estUsdM: toUsdM(v),
      sharePct: Number((share * 100).toFixed(1)),
    });
  };
  for (let i = 0; i < BUCKETS; i++) {
    if (below[i] > 0) push(i, below[i], "LONGS_BELOW");
    if (above[i] > 0) push(i, above[i], "SHORTS_ABOVE");
  }
  clusters.sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));

  const nearestBelow = clusters.find((c) => c.side === "LONGS_BELOW") ?? null;
  const nearestAbove = clusters.find((c) => c.side === "SHORTS_ABOVE") ?? null;

  return {
    symbol,
    at: Date.now(),
    price: Number(price.toFixed(price > 100 ? 2 : 6)),
    oiUsdM,
    oiScaled: oiUsdM !== null && oiUsdM > 0,
    totalBelowUsdM: toUsdM(sumBelow),
    totalAboveUsdM: toUsdM(sumAbove),
    clusters: clusters.slice(0, 12),
    nearestBelow,
    nearestAbove,
  };
}

async function loadKlines(symbol: string): Promise<K[] | null> {
  // reuse the flow scanner's fresh 15m cache when available (no extra fetch)
  try {
    const m = await import("./flow-scanner");
    const cached = m.peekFlowKlines(symbol, "15m");
    if (cached && cached.length >= 24) return cached;
  } catch {
    /* fall through to own fetch */
  }
  return fetchKlines15m(symbol);
}

/** Bounded async get — TTL cache + in-flight dedupe + evict-oldest. */
export async function getLiqHeat(symbol: string): Promise<LiqHeat | null> {
  const hit = heatCache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.v;
  const existing = heatInFlight.get(symbol);
  if (existing) return existing;
  const p = (async (): Promise<LiqHeat | null> => {
    const klines = await loadKlines(symbol).catch(() => null);
    const v = await computeHeat(symbol, klines).catch(() => null);
    heatCache.set(symbol, { at: Date.now(), v });
    evictOldest();
    return v;
  })();
  heatInFlight.set(symbol, p);
  try {
    return await p;
  } finally {
    heatInFlight.delete(symbol);
  }
}

/** Sync hot-path read for the engine/triggers — 3min TTL, never gates when absent. */
export function peekLiqHeat(symbol: string): LiqHeat | null {
  const hit = heatCache.get(symbol);
  if (!hit || !hit.v || Date.now() - hit.at > CACHE_TTL) return null;
  return hit.v;
}

/** Board for /api/liq-heat — computes a bounded batch (top-N by OI from the oi board). */
export async function getLiqHeatBoard(limit = 10): Promise<{ at: string; coverage: number; rows: LiqHeat[] }> {
  const { getOiFundBoard } = await import("./oi-funding");
  const board = await getOiFundBoard();
  const symbols = board.rows.slice(0, limit).map((r) => r.symbol);
  const rows: LiqHeat[] = [];
  for (const s of symbols) {
    const h = await getLiqHeat(s).catch(() => null);
    if (h) rows.push(h);
  }
  return { at: new Date().toISOString(), coverage: rows.length, rows };
}
