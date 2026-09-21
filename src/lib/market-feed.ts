// ── FlowRadar Neo live market feed (server-only) ──
// Binance REST client: USDT-M FUTURES tickers (primary) + spot overlay for
// spot-only listings + futures universe + klines.
// v10.16 P1 FUTURES PRICE UNIFICATION: perp signals must settle on perp
// prices — /fapi/v1 is now the PRIMARY ticker source; SPOT is only overlaid
// for universe symbols the futures response does not carry, and those rows
// stay source:"live". If BOTH fail the caller's sim fallback is unchanged.
// Resilience ladder: LIVE → STALE (≤5min grace) → SIMULATED drift.

const BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];
const FAPI = "https://fapi.binance.com";
// dual-host failover for the futures REST plane (same pattern as BINANCE_HOSTS)
const FAPI_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com"];
const TIMEOUT_MS = 6500;

import type { Candle } from "./indicators";
export type { Candle };

export interface FeedStatus {
  source: "LIVE" | "STALE" | "SIMULATED";
  lastOkAt: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  host: string | null;
}

const feedStatus: FeedStatus = { source: "LIVE", lastOkAt: null, latencyMs: null, consecutiveFailures: 0, host: null };

export function getFeedStatus(): FeedStatus {
  if (feedStatus.lastOkAt && feedStatus.source !== "SIMULATED") {
    const age = Date.now() - feedStatus.lastOkAt;
    if (age > 5 * 60_000) return { ...feedStatus, source: "SIMULATED" };
    if (age > 20_000 && feedStatus.source === "LIVE") return { ...feedStatus, source: "STALE" };
  }
  return { ...feedStatus };
}

async function fetchJson<T>(path: string, hosts: string[] = BINANCE_HOSTS): Promise<T> {
  let lastErr: unknown;
  for (const host of hosts) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(`${host}${path}`, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`${host}${path} → ${res.status}`);
      const json = (await res.json()) as T;
      feedStatus.lastOkAt = Date.now();
      feedStatus.latencyMs = Date.now() - t0;
      feedStatus.consecutiveFailures = 0;
      feedStatus.host = host.replace("https://", "");
      if (feedStatus.source !== "LIVE") feedStatus.source = "LIVE";
      return json;
    } catch (err) {
      lastErr = err;
      feedStatus.consecutiveFailures++;
    }
  }
  throw lastErr;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
}

// v10.16 P1 FUTURES PRICE UNIFICATION — PRIMARY = Binance USDT-M futures
// /fapi/v1/ticker/24hr (perp basis for perp trading), with the file's standard
// dual-host failover. SPOT /api/v3/ticker/24hr is overlaid ONLY for requested
// symbols missing from the futures response (spot-only listings); those rows
// remain live-sourced. If BOTH planes fail the map comes back empty and the
// caller's existing sim fallback is unchanged.
export async function fetchTickers(symbols: string[]): Promise<Map<string, Ticker24h>> {
  const out = new Map<string, Ticker24h>();
  const want = new Set(symbols);
  try {
    const all = await fetchJson<Ticker24h[]>("/fapi/v1/ticker/24hr", FAPI_HOSTS);
    for (const t of all) if (want.has(t.symbol)) out.set(t.symbol, t);
  } catch {
    /* fall through to the spot overlay below */
  }
  const missing = symbols.filter((s) => !out.has(s));
  if (missing.length > 0) {
    try {
      const spot = await fetchJson<Ticker24h[]>("/api/v3/ticker/24hr");
      for (const t of spot) if (want.has(t.symbol) && !out.has(t.symbol)) out.set(t.symbol, t);
    } catch {
      /* caller falls back to sim drift */
    }
  }
  return out;
}

// identical response mapping for both kline planes (v10.16 — single mapper)
function mapKlines(raw: (string | number)[][]): Candle[] {
  return raw.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

/**
 * v10.16 P1 FUTURES UNIFICATION — the engine-wide kline fetcher now resolves
 * against USDT-M FUTURES klines (/fapi/v1/klines) FIRST (perp indicators for
 * perp signals) and falls back to SPOT per-symbol only on error/empty
 * (spot-only listings). Response mapping identical to the legacy spot-only
 * version, so every consumer (engine getKlines, shadow sweeps, regime) sees
 * the same Candle shape.
 */
export async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  try {
    const perp = await fetchJson<(string | number)[][]>(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, FAPI_HOSTS);
    if (perp.length) return mapKlines(perp);
  } catch {
    /* spot fallback below */
  }
  const raw = await fetchJson<(string | number)[][]>(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return mapKlines(raw);
}

/** Futures klines (USDT-M) — same payload shape. */
export async function fetchFuturesKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const raw = await fetchJson<(string | number)[][]>(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, FAPI_HOSTS);
  return mapKlines(raw);
}

// ── futures-only universe (R15) ───────────────────────────────
const STABLE_BASES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "USDE", "USDS", "USR", "USDX", "USDTB", "USD1", "USTC", "U", "RLUSD", "PAXG"]);
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

function isStablePrice(p: number): boolean {
  return p > 0.985 && p < 1.015;
}

export interface UniverseRow {
  symbol: string;
  quoteVolume: number;
  lastPrice: number;
}

/** Rank ALL Binance USDT-M futures (PERPETUAL, TRADING) by real 24h quote volume. */
export async function fetchFuturesUniverse(n: number): Promise<UniverseRow[]> {
  const tickers = await fetchJson<Ticker24h[]>("/fapi/v1/ticker/24hr", [FAPI]);
  return tickers
    .filter((t) => t.symbol.endsWith("USDT"))
    .filter((t) => !LEVERAGED.test(t.symbol))
    .map((t) => ({ symbol: t.symbol, quoteVolume: Number(t.quoteVolume), lastPrice: Number(t.lastPrice) }))
    .filter((r) => r.quoteVolume > 1_000_000 && !isStablePrice(r.lastPrice) && !STABLE_BASES.has(r.symbol.replace("USDT", "")))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, n);
}

/** Validate a symbol is a live USDT-M perpetual right now. */
export async function fetchFuturesSymbols(): Promise<Set<string>> {
  const info = await fetchJson<{ symbols: Array<{ symbol: string; contractType: string; status: string; quoteAsset: string }> }>("/fapi/v1/exchangeInfo", [FAPI]);
  return new Set(info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING" && s.quoteAsset === "USDT").map((s) => s.symbol));
}

// ── futures pool stats (v5.1 — scan-domain coverage) ─────────
export interface FuturesPoolStats {
  totalUsdtPerps: number; // every USDT-M perpetual trading right now
  liquidPool: number; // those with >$1M 24h quote volume (the scannable pool)
  measuredAt: string;
}

let poolCache: { at: number; value: FuturesPoolStats } | null = null;
const POOL_TTL = 15 * 60_000;

/** How big is the whole futures market? Cached 15min — powers SCAN DOMAIN coverage. */
export async function fetchFuturesPoolStats(): Promise<FuturesPoolStats> {
  if (poolCache && Date.now() - poolCache.at < POOL_TTL) return poolCache.value;
  try {
    const tickers = await fetchJson<Ticker24h[]>("/fapi/v1/ticker/24hr", [FAPI]);
    const usdtPerps = tickers.filter((t) => t.symbol.endsWith("USDT") && !LEVERAGED.test(t.symbol));
    const value: FuturesPoolStats = {
      totalUsdtPerps: usdtPerps.length,
      liquidPool: usdtPerps.filter((t) => Number(t.quoteVolume) > 1_000_000 && !isStablePrice(Number(t.lastPrice)) && !STABLE_BASES.has(t.symbol.replace("USDT", ""))).length,
      measuredAt: new Date().toISOString(),
    };
    poolCache = { at: Date.now(), value };
    return value;
  } catch {
    return poolCache?.value ?? { totalUsdtPerps: 0, liquidPool: 0, measuredAt: new Date().toISOString() };
  }
}

export const FUTURES_FAPI = FAPI;
