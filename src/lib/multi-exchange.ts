// ── FlowRadar Neo multi-exchange consensus (server-only) ──
// Median price across Binance + OKX + Bybit + Hyperliquid (outlier-resistant).
// v10.16 P1 FUTURES PRICE UNIFICATION — every venue now quotes the SAME
// instrument class the engine trades (USDT-M linear perps), not a spot/perp
// mix: Binance = real futures batch (the null-price BINANCE quote is gone),
// OKX = instType SWAP, Bybit = category linear. A venue that errors degrades
// to "no quote for that venue" — never to sim; the terminal price stays live
// if ANY real venue responded.
// v10.24 Task 34-a: ONLY the Binance futures leg goes through the fapi-gate
// (weight 40 full-universe ticker, critical lane). OKX/Bybit/Hyperliquid are
// different hosts with different budgets — they keep their direct fetch.

import { getFeedStatus } from "./market-feed";
import { gateFetch } from "./fapi-gate";

const TIMEOUT_MS = 6500;

export interface VenueQuote {
  venue: string;
  price: number | null;
  latencyMs: number | null;
  ok: boolean;
}

export interface Consensus {
  symbol: string;
  median: number | null;
  quotes: VenueQuote[];
  maxDevBps: number;
  venuesOk: number;
  sweptAt: number;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

/** "ETHUSDT" → OKX SWAP instId "ETH-USDT-SWAP" (v10.16 perp unification). */
export function toOkxInstId(symbol: string): string {
  return `${symbol.replace(/USDT$/, "")}-USDT-SWAP`;
}

async function okxBatch(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // v10.16 (b) SWAP (linear perp) instruments — the SPOT endpoint mis-priced
  // perp settlement; instIds map BTCUSDT → BTC-USDT-SWAP.
  const res = await fetchWithTimeout("https://www.okx.com/api/v5/market/tickers?instType=SWAP");
  if (!res.ok) return out;
  const json = (await res.json()) as { data?: Array<{ instId: string; last: string }> };
  const want = new Set(symbols.map(toOkxInstId));
  for (const row of json.data ?? []) if (want.has(row.instId)) out.set(row.instId.replace("-USDT-SWAP", "USDT"), Number(row.last));
  return out;
}

async function bybitBatch(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // v10.16 (c) linear perps — the engine trades USDT-M perpetuals, so the
  // consensus must read category=linear, not the spot book.
  const res = await fetchWithTimeout("https://api.bybit.com/v5/market/tickers?category=linear");
  if (!res.ok) return out;
  const json = (await res.json()) as { result?: { list?: Array<{ symbol: string; lastPrice: string }> } };
  const want = new Set(symbols);
  for (const row of json.result?.list ?? []) if (want.has(row.symbol)) out.set(row.symbol, Number(row.lastPrice));
  return out;
}

async function hyperliquidAll(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const res = await fetchWithTimeout("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
  if (!res.ok) return out;
  const json = (await res.json()) as Record<string, string>;
  for (const [k, v] of Object.entries(json)) out.set(`${k}USDT`, Number(v));
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// v10.16 (a) REAL Binance futures quote — batch /fapi/v1/ticker/24hr once per
// sweep (15s cache so concurrent sweeps/venues share one call).
let binanceFutCache: { at: number; data: Map<string, number> } | null = null;

async function binanceFuturesBatch(symbols: string[]): Promise<Map<string, number>> {
  if (binanceFutCache && Date.now() - binanceFutCache.at < CACHE_TTL) {
    const out = new Map<string, number>();
    for (const s of symbols) {
      const p = binanceFutCache.data.get(s);
      if (p) out.set(s, p);
    }
    return out;
  }
  const out = new Map<string, number>();
  // v10.24 Task 34-a: full-universe /fapi/v1/ticker/24hr — weight 40, gated.
  const json = await gateFetch<Array<{ symbol: string; lastPrice: string }>>("/fapi/v1/ticker/24hr", { priority: "critical", weight: 40, timeoutMs: TIMEOUT_MS });
  if (!json) return out;
  const all = new Map<string, number>();
  for (const row of json) {
    const p = Number(row.lastPrice);
    if (Number.isFinite(p) && p > 0) all.set(row.symbol, p);
  }
  binanceFutCache = { at: Date.now(), data: all };
  for (const s of symbols) {
    const p = all.get(s);
    if (p) out.set(s, p);
  }
  return out;
}

// cached sweep (15s TTL, in-flight dedupe)
const CACHE_TTL = 15_000;
let cache: { at: number; data: Map<string, Consensus> } | null = null;
let inFlight: Promise<Map<string, Consensus>> | null = null;

// v10.16 (e) per-venue health — lastOkAt stamped on every successful batch
// contribution inside sweepConsensus; a venue is ok ONLY while its last
// success is ≤90s old (cache existence alone no longer counts).
const venueLastOkAt = new Map<string, number>();
const VENUE_OK_WINDOW_MS = 90_000;

export async function sweepConsensus(symbols: string[]): Promise<Map<string, Consensus>> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.data;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const [binance, okx, bybit, hl] = await Promise.allSettled([binanceFuturesBatch(symbols), okxBatch(symbols), bybitBatch(symbols), hyperliquidAll()]);
    const binanceMap = binance.status === "fulfilled" ? binance.value : new Map<string, number>();
    const okxMap = okx.status === "fulfilled" ? okx.value : new Map<string, number>();
    const bybitMap = bybit.status === "fulfilled" ? bybit.value : new Map<string, number>();
    const hlMap = hl.status === "fulfilled" ? hl.value : new Map<string, number>();
    const binanceStatus = getFeedStatus();

    const now = Date.now();
    if (binanceMap.size > 0) venueLastOkAt.set("BINANCE", now);
    if (okxMap.size > 0) venueLastOkAt.set("OKX", now);
    if (bybitMap.size > 0) venueLastOkAt.set("BYBIT", now);
    if (hlMap.size > 0) venueLastOkAt.set("HYPERLIQUID", now);

    const out = new Map<string, Consensus>();
    for (const sym of symbols) {
      const quotes: VenueQuote[] = [
        { venue: "BINANCE", price: binanceMap.get(sym) ?? null, latencyMs: binanceStatus.latencyMs, ok: binanceMap.has(sym) },
        { venue: "OKX", price: okxMap.get(sym) ?? null, latencyMs: null, ok: okxMap.has(sym) },
        { venue: "BYBIT", price: bybitMap.get(sym) ?? null, latencyMs: null, ok: bybitMap.has(sym) },
        { venue: "HYPERLIQUID", price: hlMap.get(sym) ?? null, latencyMs: null, ok: hlMap.has(sym) },
      ];
      const prices = quotes.map((q) => q.price).filter((p): p is number => typeof p === "number" && p > 0);
      const mdn = prices.length >= 2 ? median(prices) : (prices[0] ?? null);
      const maxDevBps = mdn && prices.length >= 2 ? Math.max(...prices.map((p) => (Math.abs(p - mdn) / mdn) * 10_000)) : 0;
      out.set(sym, { symbol: sym, median: mdn, quotes, maxDevBps: Number(maxDevBps.toFixed(2)), venuesOk: prices.length, sweptAt: now });
    }
    cache = { at: Date.now(), data: out };
    return out;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export function getConsensusHealth(): Array<{ venue: string; ok: boolean; latencyMs: number | null }> {
  // v10.16 (e) ok = a real per-venue quote contribution within the last 90s —
  // "a cache exists somewhere" no longer marks a silent venue healthy.
  const fresh = (venue: string) => Date.now() - (venueLastOkAt.get(venue) ?? 0) <= VENUE_OK_WINDOW_MS;
  return [
    { venue: "BINANCE", ok: fresh("BINANCE"), latencyMs: getFeedStatus().latencyMs },
    { venue: "OKX", ok: fresh("OKX"), latencyMs: null },
    { venue: "BYBIT", ok: fresh("BYBIT"), latencyMs: null },
    { venue: "HYPERLIQUID", ok: fresh("HYPERLIQUID"), latencyMs: null },
  ];
}
