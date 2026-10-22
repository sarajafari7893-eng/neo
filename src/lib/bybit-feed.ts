// ── NEXUS//SIGNALS — Bybit v5 public REST feed (server-only) ────────────────
// DATA-QUALITY REVIVAL 2026-10-21 (operator: «کیفیت داده ها پایین است… ردیابی
// جریانات با دقت و سرعت بالا»): Binance fapi+spot are IP-banned (418) again,
// which silently starved the flow board (FlowScan frozen 25d), funding/OI
// context and the 24h ticker leg. This module gives every consumer a LIVE,
// honestly-venue-tagged alternate plane — Bybit v5 linear perps, public
// endpoints, one cheap batched request per resource.
//
// HONESTY DOCTRINE (October carry-over): fallback data is NEVER relabeled as
// Binance. Consumers tag rows with the real source venue; CVD/taker-buy
// splits that Bybit does not provide stay null (measured gap, not invented).
// ─────────────────────────────────────────────────────────────────────────────
const BYBIT = "https://api.bybit.com";
const TIMEOUT_MS = 6500;

export type BybitVenue = "BYBIT";

interface BybitHealth {
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  latencyMs: number | null;
  klinesOk: number;
  tickersOk: number;
  metricsOk: number;
}
const health = (() => {
  // globalThis dedupe — Turbopack per-bundle instantiation would otherwise
  // fork the counters between the engine bundle and per-route bundles.
  const g = globalThis as { __nexusBybitHealth?: BybitHealth };
  g.__nexusBybitHealth ??= { lastOkAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0, latencyMs: null, klinesOk: 0, tickersOk: 0, metricsOk: 0 };
  return g.__nexusBybitHealth;
})();
export function bybitHealth(): Readonly<BybitHealth> {
  return health;
}

async function bybitFetch<T>(path: string): Promise<T | null> {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${BYBIT}${path}`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    const json = (await res.json()) as { retCode?: number; retMsg?: string };
    if (typeof json.retCode === "number" && json.retCode !== 0) throw new Error(`${path} → retCode ${json.retCode} ${json.retMsg ?? ""}`);
    health.lastOkAt = Date.now();
    health.latencyMs = Date.now() - t0;
    health.consecutiveFailures = 0;
    return json as T;
  } catch (e) {
    health.lastErrorAt = Date.now();
    health.lastError = e instanceof Error ? e.message : String(e);
    health.consecutiveFailures++;
    return null;
  }
}

export interface FlowCandleLike {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuy: number | null; // Bybit klines carry no taker-buy split — honest null (CVD gap)
}

const TF_TO_BYBIT: Record<string, string> = { "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D" };

/** USDT-M linear perp klines, oldest→newest, closed-bar semantics preserved upstream. */
export async function bybitKlines(symbol: string, interval: string, limit: number): Promise<FlowCandleLike[] | null> {
  const iv = TF_TO_BYBIT[interval];
  if (!iv) return null;
  const json = await bybitFetch<{ result?: { list?: string[][] } }>(`/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}&limit=${Math.min(1000, limit)}`);
  const list = json?.result?.list;
  if (!Array.isArray(list) || list.length === 0) return null;
  health.klinesOk++;
  return list
    .map((k) => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      takerBuy: null,
    }))
    .reverse(); // Bybit returns newest-first — normalize to Binance order
}

export interface BybitTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string; // percent, Binance-compatible ("1.23")
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
}

/** ONE request → the whole linear-perp universe (vs Binance weight-40 gated call). */
export async function bybitTickers(): Promise<Map<string, BybitTicker>> {
  const out = new Map<string, BybitTicker>();
  const json = await bybitFetch<{ result?: { list?: Array<{ symbol: string; lastPrice: string; price24hPcnt: string; highPrice24h: string; lowPrice24h: string; turnover24h: string }> } }>(`/v5/market/tickers?category=linear`);
  const list = json?.result?.list;
  if (!Array.isArray(list)) return out;
  health.tickersOk++;
  for (const t of list) {
    const pc = Number(t.price24hPcnt);
    out.set(t.symbol, {
      symbol: t.symbol,
      lastPrice: t.lastPrice,
      priceChangePercent: Number.isFinite(pc) ? (pc * 100).toFixed(4) : "0",
      highPrice: t.highPrice24h,
      lowPrice: t.lowPrice24h,
      quoteVolume: t.turnover24h,
    });
  }
  return out;
}

/** Funding rate (last settled), in Binance-compatible percent (0.01% = "0.01"). */
export async function bybitFunding8h(symbol: string): Promise<number | null> {
  const json = await bybitFetch<{ result?: { list?: Array<{ fundingRate: string }> } }>(`/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`);
  const r = json?.result?.list?.[0]?.fundingRate;
  if (r === undefined) return null;
  health.metricsOk++;
  const n = Number(r);
  return Number.isFinite(n) ? n * 100 : null;
}

/** 1h open-interest delta % (last closed hourly OI vs previous), Bybit linear. */
export async function bybitOiDelta1h(symbol: string): Promise<number | null> {
  const json = await bybitFetch<{ result?: { list?: Array<{ openInterest: string; timestamp: string }> } }>(`/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=2`);
  const list = json?.result?.list;
  if (!Array.isArray(list) || list.length < 2) return null;
  health.metricsOk++;
  const cur = Number(list[0]?.openInterest);
  const prev = Number(list[list.length - 1]?.openInterest);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return Number((((cur - prev) / prev) * 100).toFixed(3));
}
