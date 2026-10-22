// ── FlowRadar Neo FLOW BRIDGE (server-only, v12.2 TASK-52) ──
// Operator mandate (trace 1a15557783520919) «کامل و مهندسی اجرا کن» on the
// Task-51 audit proposals. Two-part cure for the Binance single-point-of-
// failure in the flow plane:
//
//  ① BYBIT FLOW BRIDGE — during fapi bans/pool silence the flow scanners used
//     to degrade to honest blindness (Task-47: blindness rode 516 ban-drops/
//     48h). Bybit v5 public market endpoints give a semantically-close perp
//     tape with ZERO fapi weight: linear klines, recent-trade (taker side),
//     open-interest history, and ONE batched tickers call carrying funding +
//     mark + OI notional for the whole domain.
//  ② SPOT-MIRROR rung — api.binance.com lives in a SEPARATE rate-limit/ban
//     pool from fapi.binance.com with the SAME kline shape (field-9 taker
//     volume) — the faithful middle rung for klines. For the tape it ranks
//     BELOW Bybit linear (spot flow ≠ perp flow).
//
// LADDERS (best → last): klines fapi→SPOT-MIRROR→BYBIT · tape fapi→BYBIT→
// SPOT-MIRROR · OI/funding fapi→BYBIT (perp-native, no spot equivalent).
// HONESTY LAWS unchanged: a venue that fails degrades to null — never to
// invented data; every result carries its SOURCE so cards/journals say which
// market the number came from. crowd/top-trader L/S ratios have NO public
// equivalent on any other venue — they stay Binance-only and honestly null.
//
// Note: 1000X-style perp symbols (1000PEPEUSDT…) have no spot pair — the
// SPOT-MIRROR rung 404s on them and the ladder falls through to Bybit, which
// uses the same 1000X naming on linear.

import { gateFetch } from "./fapi-gate";

const TIMEOUT_MS = 6500;

export type FlowSource = "BINANCE" | "SPOT-MIRROR" | "BYBIT";

export interface KlineRow {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** field-9 taker-buy base volume — null ⇒ venue does not report it (BYBIT v5 kline). */
  takerBuyBase: number | null;
}

export interface TapeTrade {
  price: number;
  qty: number;
  quoteQty: number;
  /** true ⇒ the buyer was the maker ⇒ the aggressor SOLD (Binance m-flag semantics). */
  isBuyerMaker: boolean;
  time: number;
}

export interface OiRow {
  sumOpenInterest: number;
  /** notional OI in USD — null on BYBIT history (base-denominated only). */
  sumOpenInterestValue: number | null;
  timestamp: number;
}

export interface BybitTicker {
  lastPrice: number;
  markPrice: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  openInterest: number | null;
  openInterestValue: number | null;
  /** 24h quote turnover in USD — powers the BYBIT-MIRROR pool-stats rung (Task 53). */
  turnover24h: number | null;
  // v12.5 TASK-52-REVIVAL — ticker-mirror fields (feed board rung during full
  // Binance REST blackouts): 24h change + range + two-sided book (zombie check).
  /** 24h price change as a FRACTION (0.0096 = +0.96%) — null when venue omits it. */
  price24hPcnt: number | null;
  highPrice24h: number | null;
  lowPrice24h: number | null;
  prevPrice24h: number | null;
  bid1Price: number | null;
  ask1Price: number | null;
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── bybit 429 backoff (multi-exchange HL pattern) — our own storm guard ──
let bybitCooldownUntil = 0;
let bybitCooldownJournaled = false;

function noteBybit429(context: string): void {
  if (Date.now() >= bybitCooldownUntil) bybitCooldownJournaled = false;
  bybitCooldownUntil = Date.now() + 60_000;
  if (!bybitCooldownJournaled) {
    bybitCooldownJournaled = true;
    console.log(`[flow-bridge] BYBIT 429 on ${context} — bridge leg paused 60s (backoff, Task-52)`);
  }
}

const bybitOpen = (): boolean => Date.now() >= bybitCooldownUntil;

async function bybitJfetch<T>(url: string): Promise<T | null> {
  if (!bybitOpen()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (res.status === 429) {
      noteBybit429(url);
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── klines rungs ────────────────────────────────────────────────────────────

function binanceKlineRows(raw: (string | number)[][]): KlineRow[] {
  return raw.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    takerBuyBase: Number(k[9]),
  }));
}

/** SPOT-MIRROR rung — api.binance.com (separate rate/ban pool, same shape, field-9 intact). */
export async function spotMirrorKlines(symbol: string, interval: string, limit: number): Promise<KlineRow[] | null> {
  const spot = await jfetch<(string | number)[][]>(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!spot || spot.length === 0) return null;
  return binanceKlineRows(spot);
}

function bybitInterval(interval: string): string | null {
  switch (interval) {
    case "1m": return "1";
    case "5m": return "5";
    case "15m": return "15";
    case "1h": return "60";
    case "4h": return "240";
    default: return null;
  }
}

/** BYBIT rung — v5 linear perp kline. NO field-9 taker volume ⇒ takerBuyBase null. */
export async function bybitKlines(symbol: string, interval: string, limit: number): Promise<KlineRow[] | null> {
  const bi = bybitInterval(interval);
  if (!bi) return null;
  const j = await bybitJfetch<{ result?: { list?: string[][] } }>(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bi}&limit=${Math.min(limit, 1000)}`);
  const list = j?.result?.list;
  if (!list || list.length === 0) return null;
  // v5 list is DESC (newest first) → reverse to the Binance ASC order
  return [...list].reverse().map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    takerBuyBase: null,
  }));
}

/** kline LADDER — fapi (gate) → SPOT-MIRROR → BYBIT linear. */
export async function bridgeKlines(symbol: string, interval: string, limit: number): Promise<{ rows: KlineRow[]; source: FlowSource } | null> {
  const raw = await gateFetch<(string | number)[][]>(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, { priority: "telemetry", timeoutMs: TIMEOUT_MS }).catch(() => null);
  if (raw && raw.length > 0) return { rows: binanceKlineRows(raw), source: "BINANCE" };
  const spot = await spotMirrorKlines(symbol, interval, limit).catch(() => null);
  if (spot && spot.length > 0) return { rows: spot, source: "SPOT-MIRROR" };
  const byb = await bybitKlines(symbol, interval, limit).catch(() => null);
  if (byb && byb.length > 0) return { rows: byb, source: "BYBIT" };
  return null;
}

// ── tape rungs ──────────────────────────────────────────────────────────────

function tapeFromBybit(list: Array<{ price: string; size: string; side: string; time: string }>): TapeTrade[] {
  // v5 recent-trade side is the TAKER side: "Sell" ⇒ buyer was maker (Binance m=true)
  return list.map((t) => ({
    price: Number(t.price),
    qty: Number(t.size),
    quoteQty: Number(t.price) * Number(t.size),
    isBuyerMaker: t.side === "Sell",
    time: Number(t.time),
  }));
}

/** BYBIT rung — linear recent-trade (perp tape on another venue). */
export async function bybitTape(symbol: string): Promise<TapeTrade[] | null> {
  const j = await bybitJfetch<{ result?: { list?: Array<{ price: string; size: string; side: string; time: string }> } }>(`https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${symbol}&limit=1000`);
  const list = j?.result?.list;
  if (!list || list.length === 0) return null;
  return tapeFromBybit(list);
}

/** SPOT-MIRROR rung — /api/v3/trades (LAST resort for tape: spot flow ≠ perp flow). */
export async function spotMirrorTape(symbol: string): Promise<TapeTrade[] | null> {
  const spot = await jfetch<Array<{ price: string; qty: string; quoteQty: string; isBuyerMaker: boolean; time: number }>>(`https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=1000`);
  if (!spot || spot.length === 0) return null;
  return spot.map((t) => ({ price: Number(t.price), qty: Number(t.qty), quoteQty: Number(t.quoteQty) || Number(t.price) * Number(t.qty), isBuyerMaker: t.isBuyerMaker, time: t.time }));
}

/** tape LADDER — fapi aggTrades → BYBIT linear recent-trade → SPOT-MIRROR trades. */
export async function bridgeTape(symbol: string): Promise<{ trades: TapeTrade[]; source: FlowSource } | null> {
  const agg = await gateFetch<Array<{ p: string; q: string; T: number; m: boolean }>>(`/fapi/v1/aggTrades?symbol=${symbol}&limit=1000`, { priority: "telemetry", timeoutMs: TIMEOUT_MS }).catch(() => null);
  if (agg && agg.length > 0) {
    return {
      trades: agg.map((t) => ({ price: Number(t.p), qty: Number(t.q), quoteQty: Number(t.p) * Number(t.q), isBuyerMaker: t.m, time: t.T })),
      source: "BINANCE",
    };
  }
  const byb = await bybitTape(symbol).catch(() => null);
  if (byb && byb.length > 0) return { trades: byb, source: "BYBIT" };
  const spot = await spotMirrorTape(symbol).catch(() => null);
  if (spot && spot.length > 0) return { trades: spot, source: "SPOT-MIRROR" };
  return null;
}

// ── OI history rungs (perp-native — no spot equivalent anywhere) ───────────

/** BYBIT rung — v5 open-interest history, base-denominated (notional null). */
export async function bybitOiHist(symbol: string, period: "5m" | "15m", limit: number): Promise<OiRow[] | null> {
  const iv = period === "5m" ? "5min" : "15min";
  const j = await bybitJfetch<{ result?: { list?: Array<{ openInterest: string; timestamp: string }> } }>(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${iv}&limit=${limit}`);
  const list = j?.result?.list;
  if (!list || list.length === 0) return null;
  // v5 list is DESC → reverse to the Binance openInterestHist ASC order
  return [...list].reverse().map((r) => ({ sumOpenInterest: Number(r.openInterest), sumOpenInterestValue: null, timestamp: Number(r.timestamp) }));
}

/** OI LADDER — fapi openInterestHist → BYBIT. */
export async function bridgeOiHist(symbol: string, period: "5m" | "15m", limit: number): Promise<{ rows: OiRow[]; source: FlowSource } | null> {
  const f = await gateFetch<Array<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }>>(`/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`, { priority: "telemetry", timeoutMs: TIMEOUT_MS }).catch(() => null);
  if (f && f.length > 0) {
    return {
      rows: f.map((h) => ({ sumOpenInterest: Number(h.sumOpenInterest), sumOpenInterestValue: Number(h.sumOpenInterestValue), timestamp: h.timestamp })),
      source: "BINANCE",
    };
  }
  const byb = await bybitOiHist(symbol, period, limit).catch(() => null);
  if (byb && byb.length > 0) return { rows: byb, source: "BYBIT" };
  return null;
}

// ── depth rungs (order-book ladder — v12.3 TASK-52) ─────────────────────────

export interface DepthBook {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  source: FlowSource;
}

/** BYBIT rung — v5 linear orderbook (perp-native book on another venue). */
export async function bybitDepth(symbol: string, limit: number): Promise<DepthBook | null> {
  // v5 valid linear limits: 1/25/50/100/200 (500 is spot-only) — snap down
  const steps = [1, 25, 50, 100, 200];
  const lv = steps.find((s) => s >= limit) ?? 200;
  const j = await bybitJfetch<{ result?: { b?: string[][]; a?: string[][] } }>(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=${lv}`);
  const b = j?.result?.b;
  const a = j?.result?.a;
  if (!b || !a || b.length === 0 || a.length === 0) return null;
  return {
    bids: b.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
    asks: a.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
    source: "BYBIT",
  };
}

/** SPOT-MIRROR rung — /api/v3/depth (separate rate/ban pool, Binance book but SPOT liquidity). */
export async function spotMirrorDepth(symbol: string, limit: number): Promise<DepthBook | null> {
  const steps = [5, 10, 20, 50, 100, 500];
  const lv = steps.find((s) => s >= limit) ?? 500;
  const raw = await jfetch<{ bids: Array<[string, string]>; asks: Array<[string, string]> }>(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${lv}`);
  if (!raw || raw.bids.length === 0 || raw.asks.length === 0) return null;
  return {
    bids: raw.bids.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
    asks: raw.asks.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
    source: "SPOT-MIRROR",
  };
}

/** depth LADDER — fapi (gate) → BYBIT linear book → SPOT-MIRROR book. */
export async function bridgeDepth(symbol: string, limit: number): Promise<DepthBook | null> {
  const raw = await gateFetch<{ bids: Array<[string, string]>; asks: Array<[string, string]> }>(`/fapi/v1/depth?symbol=${symbol}&limit=${limit}`, { priority: "telemetry", timeoutMs: TIMEOUT_MS }).catch(() => null);
  if (raw && raw.bids.length > 0 && raw.asks.length > 0) {
    return {
      bids: raw.bids.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
      asks: raw.asks.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
      source: "BINANCE",
    };
  }
  const byb = await bybitDepth(symbol, limit).catch(() => null);
  if (byb) return byb;
  const spot = await spotMirrorDepth(symbol, limit).catch(() => null);
  if (spot) return spot;
  return null;
}

// ── batched bybit tickers — funding + mark + OI notional for the WHOLE domain
//    in ONE weight-cheap call (the fapi premiumIndex-batch analogue) ─────────

const TICKERS_TTL = 15_000;
let tickCache: { at: number; map: Map<string, BybitTicker> } | null = null;
let tickInFlight: Promise<Map<string, BybitTicker>> | null = null;

export async function bybitTickerMap(): Promise<Map<string, BybitTicker>> {
  if (tickCache && Date.now() - tickCache.at < TICKERS_TTL) return tickCache.map;
  if (tickInFlight) return tickInFlight;
  tickInFlight = (async () => {
    const out = new Map<string, BybitTicker>();
    const j = await bybitJfetch<{ result?: { list?: Array<Record<string, string>> } }>("https://api.bybit.com/v5/market/tickers?category=linear");
    for (const r of j?.result?.list ?? []) {
      const last = Number(r.lastPrice);
      if (!Number.isFinite(last) || last <= 0) continue;
      out.set(r.symbol, {
        lastPrice: last,
        markPrice: Number(r.markPrice) || null,
        fundingRate: Number(r.fundingRate) || null,
        nextFundingTime: Number(r.nextFundingTime) || null,
        openInterest: Number(r.openInterest) || null,
        openInterestValue: Number(r.openInterestValue) || null,
        turnover24h: Number(r.turnover24h) || null,
        price24hPcnt: r.price24hPcnt !== undefined && isFinite(Number(r.price24hPcnt)) ? Number(r.price24hPcnt) : null,
        highPrice24h: Number(r.highPrice24h) || null,
        lowPrice24h: Number(r.lowPrice24h) || null,
        prevPrice24h: Number(r.prevPrice24h) || null,
        bid1Price: Number(r.bid1Price) || null,
        ask1Price: Number(r.ask1Price) || null,
      });
    }
    tickCache = { at: Date.now(), map: out };
    return out;
  })();
  try {
    return await tickInFlight;
  } finally {
    tickInFlight = null;
  }
}

export async function bybitTickerRow(symbol: string): Promise<BybitTicker | null> {
  return (await bybitTickerMap().catch(() => new Map<string, BybitTicker>())).get(symbol) ?? null;
}
