// ── FlowRadar Neo FLOW BRIDGE (server-only, v14.0 BINANCE-ONLY) ──
// Operator mandate (trace 1a185042c872b4f9 — «ردپای OKX/Bybit در کجا وجود
// دارد و با بایننس جایگزین شود»): the v12.2 cross-venue bridge is retired.
// Every ladder is now BINANCE-ONLY, riding the two independent Binance REST
// planes measured live from this egress:
//
//  ① fapi plane — gated (fapi-gate, weight budget, ban ledger), perp-native.
//  ② SPOT-MIRROR plane — the v13.3 spot-host ladder (data-api.binance.vision
//     → api-gcp → api1-4 → api.binance.com) with the shared per-host 418/429
//     gate: SEPARATE ban pool from fapi, SAME kline shape (field-9 taker
//     volume intact), zero fapi weight.
//
// LADDERS (best → last): klines fapi→SPOT-MIRROR · tape fapi→SPOT-MIRROR ·
// OI history fapi (perp-native — no spot equivalent, honest null on ban) ·
// depth fapi→SPOT-MIRROR · batched tickers fapi(composite)→SPOT-MIRROR.
// HONESTY LAWS unchanged: a plane that fails degrades to null — never to
// invented data; every result carries its SOURCE so cards/journals say which
// Binance plane the number came from. crowd/top-trader L/S ratios stay
// Binance-only and honestly null. FLAT-10 engine policy untouched.
//
// Note: 1000X-style perp symbols (1000PEPEUSDT…) have no spot pair — the
// SPOT-MIRROR rung 404s on them and the ladder ends honestly (fapi rung
// serves them whenever the gate is open).

import { gateFetch } from "./fapi-gate";
import { spotLadderJson } from "./spot-host-gate";

const TIMEOUT_MS = 6500;

export type FlowSource = "BINANCE" | "SPOT-MIRROR";

export interface KlineRow {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** field-9 taker-buy base volume — present on BOTH Binance planes. */
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
  /** notional OI in USD — null on spot-plane history (base-denominated only). */
  sumOpenInterestValue: number | null;
  timestamp: number;
}

export interface BridgeTicker {
  lastPrice: number;
  markPrice: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  openInterest: number | null;
  openInterestValue: number | null;
  /** 24h quote turnover in USD — powers the SPOT-MIRROR pool-stats rung (Task 53). */
  turnover24h: number | null;
  /** 24h price change as a FRACTION (0.0096 = +0.96%) — null when the plane omits it. */
  price24hPcnt: number | null;
  highPrice24h: number | null;
  lowPrice24h: number | null;
  prevPrice24h: number | null;
  bid1Price: number | null;
  ask1Price: number | null;
  /** v14.0 — which Binance plane priced this row (honesty tag). */
  source: FlowSource;
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

// ── klines rungs ────────────────────────────────────────────────────────

// ── v13.2 SPOT-HOST LADDER (operator mandate trace 1a1704d407f00dad —
// «از data-api.binance.vision استفاده کن؛ جریان زندهٔ لحظه‌ای باید با بایننس
// باشد»): measured live 2026-10-25 — data-api.binance.vision 32/32 HTTP 200
// p50 57ms while api.binance.com rides 418 ban-storms from this shared egress.
// v13.2.3 (trace 1a170bba02dff781): api1-4 added as mid rungs, api last.
// v14.0: this ladder is now the ONLY fallback plane (Binance-only mandate).
const SPOT_HOSTS = ["https://data-api.binance.vision", "https://api-gcp.binance.com", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com", "https://api.binance.com"]; // v13.3 ladder + api-gcp
// v13.2.1 — per-host 418/429 backoff via the shared spot-host gate: a banned
// rung is SKIPPED (not re-poked every tick) and traffic slides to the healthy
// host until retry-after expires (live evidence: vision 418 @467wt/min while
// jfetch swallowed the status and kept hammering).
async function spotLadderFetch<T>(path: string): Promise<T | null> {
  return spotLadderJson<T>(path, SPOT_HOSTS, TIMEOUT_MS);
}

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

/** SPOT-MIRROR rung — Binance public data mirror ladder (vision → api; same shape, field-9 intact). */
export async function spotMirrorKlines(symbol: string, interval: string, limit: number): Promise<KlineRow[] | null> {
  const spot = await spotLadderFetch<(string | number)[][]>(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!spot || spot.length === 0) return null;
  return binanceKlineRows(spot);
}

/** kline LADDER — fapi (gate) → SPOT-MIRROR. Binance-only (v14.0). */
export async function bridgeKlines(symbol: string, interval: string, limit: number): Promise<{ rows: KlineRow[]; source: FlowSource } | null> {
  const raw = await gateFetch<(string | number)[][]>(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, { priority: "telemetry", timeoutMs: TIMEOUT_MS }).catch(() => null);
  if (raw && raw.length > 0) return { rows: binanceKlineRows(raw), source: "BINANCE" };
  const spot = await spotMirrorKlines(symbol, interval, limit).catch(() => null);
  if (spot && spot.length > 0) return { rows: spot, source: "SPOT-MIRROR" };
  return null;
}

// ── tape rungs ──────────────────────────────────────────────────────────────

/** SPOT-MIRROR rung — /api/v3/trades via the vision-first ladder (Binance spot tape). */
export async function spotMirrorTape(symbol: string): Promise<TapeTrade[] | null> {
  const spot = await spotLadderFetch<Array<{ price: string; qty: string; quoteQty: string; isBuyerMaker: boolean; time: number }>>(`/api/v3/trades?symbol=${symbol}&limit=1000`);
  if (!spot || spot.length === 0) return null;
  return spot.map((t) => ({ price: Number(t.price), qty: Number(t.qty), quoteQty: Number(t.quoteQty) || Number(t.price) * Number(t.qty), isBuyerMaker: t.isBuyerMaker, time: t.time }));
}

/** tape LADDER — fapi aggTrades → SPOT-MIRROR trades. Binance-only (v14.0). */
export async function bridgeTape(symbol: string): Promise<{ trades: TapeTrade[]; source: FlowSource } | null> {
  const agg = await gateFetch<Array<{ p: string; q: string; T: number; m: boolean }>>(`/fapi/v1/aggTrades?symbol=${symbol}&limit=1000`, { priority: "telemetry", timeoutMs: TIMEOUT_MS }).catch(() => null);
  if (agg && agg.length > 0) {
    return {
      trades: agg.map((t) => ({ price: Number(t.p), qty: Number(t.q), quoteQty: Number(t.p) * Number(t.q), isBuyerMaker: t.m, time: t.T })),
      source: "BINANCE",
    };
  }
  const spot = await spotMirrorTape(symbol).catch(() => null);
  if (spot && spot.length > 0) return { trades: spot, source: "SPOT-MIRROR" };
  return null;
}

// ── OI history rungs (perp-native — no spot equivalent anywhere) ───────────

/** OI LADDER — fapi openInterestHist only (perp-native; honest null on ban — v14.0 removed the cross-venue rung). */
export async function bridgeOiHist(symbol: string, period: "5m" | "15m", limit: number): Promise<{ rows: OiRow[]; source: FlowSource } | null> {
  const f = await gateFetch<Array<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }>>(`/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`, { priority: "telemetry", timeoutMs: TIMEOUT_MS }).catch(() => null);
  if (f && f.length > 0) {
    return {
      rows: f.map((h) => ({ sumOpenInterest: Number(h.sumOpenInterest), sumOpenInterestValue: Number(h.sumOpenInterestValue), timestamp: h.timestamp })),
      source: "BINANCE",
    };
  }
  return null;
}

// ── depth rungs (order-book ladder — v12.3 TASK-52) ─────────────────────────

export interface DepthBook {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  source: FlowSource;
}

/** SPOT-MIRROR rung — /api/v3/depth via the vision-first ladder (Binance book but SPOT liquidity). */
export async function spotMirrorDepth(symbol: string, limit: number): Promise<DepthBook | null> {
  const steps = [5, 10, 20, 50, 100, 500];
  const lv = steps.find((s) => s >= limit) ?? 500;
  const raw = await spotLadderFetch<{ bids: Array<[string, string]>; asks: Array<[string, string]> }>(`/api/v3/depth?symbol=${symbol}&limit=${lv}`);
  if (!raw || raw.bids.length === 0 || raw.asks.length === 0) return null;
  return {
    bids: raw.bids.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
    asks: raw.asks.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
    source: "SPOT-MIRROR",
  };
}

/** depth LADDER — fapi (gate) → SPOT-MIRROR book. Binance-only (v14.0). */
export async function bridgeDepth(symbol: string, limit: number): Promise<DepthBook | null> {
  const raw = await gateFetch<{ bids: Array<[string, string]>; asks: Array<[string, string]> }>(`/fapi/v1/depth?symbol=${symbol}&limit=${limit}`, { priority: "telemetry", timeoutMs: TIMEOUT_MS }).catch(() => null);
  if (raw && raw.bids.length > 0 && raw.asks.length > 0) {
    return {
      bids: raw.bids.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
      asks: raw.asks.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
      source: "BINANCE",
    };
  }
  const spot = await spotMirrorDepth(symbol, limit).catch(() => null);
  if (spot) return spot;
  return null;
}

// ── batched tickers — funding + mark + 24h board for the WHOLE domain ──────
// v14.0 BINANCE-ONLY composite: ONE gated /fapi/v1/ticker/24hr (weight 40) +
// ONE gated /fapi/v1/premiumIndex batch (weight 10) merged per symbol. On a
// fapi ban the SPOT-MIRROR ticker batch prices the board (mark/funding/OI
// honestly null — spot plane carries no perp derivatives).

const TICKERS_TTL = 15_000;
let tickCache: { at: number; map: Map<string, BridgeTicker>; src: FlowSource } | null = null;
let tickInFlight: Promise<Map<string, BridgeTicker>> | null = null;

export async function futTickerMap(): Promise<Map<string, BridgeTicker>> {
  if (tickCache && Date.now() - tickCache.at < TICKERS_TTL) return tickCache.map;
  if (tickInFlight) return tickInFlight;
  tickInFlight = (async () => {
    const out = new Map<string, BridgeTicker>();
    const [board, prem] = await Promise.all([
      gateFetch<Array<Record<string, string>>>("/fapi/v1/ticker/24hr", { priority: "telemetry", weight: 40, timeoutMs: TIMEOUT_MS }).catch(() => null),
      gateFetch<Array<Record<string, string>>>("/fapi/v1/premiumIndex", { priority: "telemetry", weight: 10, timeoutMs: TIMEOUT_MS }).catch(() => null),
    ]);
    if (board && board.length > 0) {
      const premMap = new Map((prem ?? []).map((p) => [p.symbol, p]));
      for (const r of board) {
        const last = Number(r.lastPrice);
        if (!Number.isFinite(last) || last <= 0) continue;
        const pm = premMap.get(r.symbol);
        const mark = Number(pm?.markPrice) || null;
        const funding = Number(pm?.lastFundingRate);
        out.set(r.symbol, {
          lastPrice: last,
          markPrice: mark,
          fundingRate: Number.isFinite(funding) && pm ? funding : null,
          nextFundingTime: Number(pm?.nextFundingTime) || null,
          openInterest: null, // per-symbol only — enriched in futTickerRow
          openInterestValue: null,
          turnover24h: Number(r.quoteVolume) || null,
          price24hPcnt: r.priceChangePercent !== undefined && isFinite(Number(r.priceChangePercent)) ? Number(r.priceChangePercent) / 100 : null,
          highPrice24h: Number(r.highPrice) || null,
          lowPrice24h: Number(r.lowPrice) || null,
          prevPrice24h: Number(r.prevClosePrice) || null,
          bid1Price: Number(r.bidPrice) || null,
          ask1Price: Number(r.askPrice) || null,
          source: "BINANCE",
        });
      }
      tickCache = { at: Date.now(), map: out, src: "BINANCE" };
      return out;
    }
    // fapi banned — SPOT-MIRROR board (price-only rows, honest nulls on perp fields)
    const spot = await spotLadderFetch<Array<Record<string, string>>>("/api/v3/ticker/24hr");
    if (spot && spot.length > 0) {
      for (const r of spot) {
        const last = Number(r.lastPrice);
        if (!Number.isFinite(last) || last <= 0) continue;
        out.set(r.symbol, {
          lastPrice: last,
          markPrice: null, fundingRate: null, nextFundingTime: null,
          openInterest: null, openInterestValue: null,
          turnover24h: Number(r.quoteVolume) || null,
          price24hPcnt: r.priceChangePercent !== undefined && isFinite(Number(r.priceChangePercent)) ? Number(r.priceChangePercent) / 100 : null,
          highPrice24h: Number(r.highPrice) || null,
          lowPrice24h: Number(r.lowPrice) || null,
          prevPrice24h: Number(r.prevClosePrice) || null,
          bid1Price: Number(r.bidPrice) || null,
          ask1Price: Number(r.askPrice) || null,
          source: "SPOT-MIRROR",
        });
      }
    }
    tickCache = { at: Date.now(), map: out, src: "SPOT-MIRROR" };
    return out;
  })();
  try {
    return await tickInFlight;
  } finally {
    tickInFlight = null;
  }
}

export async function futTickerRow(symbol: string): Promise<BridgeTicker | null> {
  const map = await futTickerMap().catch(() => new Map<string, BridgeTicker>());
  const row = map.get(symbol);
  if (!row) return null;
  // v14.0 — OI enrichment: /fapi/v1/openInterest is per-symbol (weight 1);
  // fill it only for rows priced by the fapi plane and only when missing.
  if (row.source === "BINANCE" && row.openInterest === null) {
    const oi = await gateFetch<{ openInterest: string }>(`/fapi/v1/openInterest?symbol=${symbol}`, { priority: "telemetry", timeoutMs: 4000 }).catch(() => null);
    const v = Number(oi?.openInterest);
    if (Number.isFinite(v) && v > 0) {
      row.openInterest = v;
      if (row.markPrice) row.openInterestValue = v * row.markPrice;
    }
  }
  return row;
}

// ── v12.9 second-plane direction cross-check (NX-3046 doctrine, Binance-only
//    since v14.0) — the flow bundle rides ONE plane's tape; this rung hands
//    the flow scorer an INDEPENDENT Binance plane's 15m-window direction
//    (SPOT-MIRROR ladder vs the fapi primary) so cross-plane disagreement
//    clamps conviction at the SOURCE instead of at the gate. Returns the
//    last-4×5m-bar % move (same window as the primary bridgeKlines("5m",4)
//    leg) or null when the plane cannot price the symbol (fail-open).

/** SPOT-MIRROR rung — spot ladder klines 5m, same math. */
export async function spot5mMove(symbol: string): Promise<number | null> {
  const rows = await spotMirrorKlines(symbol, "5m", 4);
  if (!rows || rows.length < 4) return null;
  const open = rows[0]!.open;
  const close = rows[rows.length - 1]!.close;
  if (!(open > 0) || !(close > 0)) return null;
  return ((close - open) / open) * 100;
}

/** fapi-only rung — gated 5m klines (the second-plane cross-check when the primary rode SPOT-MIRROR). */
export async function fapi5mMove(symbol: string): Promise<number | null> {
  const raw = await gateFetch<(string | number)[][]>(`/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=4`, { priority: "telemetry", timeoutMs: TIMEOUT_MS }).catch(() => null);
  if (!raw || raw.length < 4) return null;
  const open = Number(raw[0]![1]);
  const close = Number(raw[raw.length - 1]![4]);
  if (!(open > 0) || !(close > 0)) return null;
  return ((close - open) / open) * 100;
}
