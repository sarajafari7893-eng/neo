// ── FlowRadar Neo live market feed (server-only) ──
// Binance REST client: USDT-M FUTURES tickers (primary) + spot overlay for
// spot-only listings + futures universe + klines.
// v10.16 P1 FUTURES PRICE UNIFICATION: perp signals must settle on perp
// prices — /fapi/v1 is now the PRIMARY ticker source; SPOT is only overlaid
// for universe symbols the futures response does not carry, and those rows
// stay source:"live". If BOTH fail the caller's sim fallback is unchanged.
// Resilience ladder: LIVE → STALE (≤5min grace) → SIMULATED drift.
// v10.24 Task 34-a FAPI GATE: every futures (fapi) REST call now goes through
// the process-wide weight gate (src/lib/fapi-gate.ts) — budget, global IP-ban
// awareness and single-flight. SPOT calls (api.binance.com) stay direct —
// they have their own separate IP budget.

import { gateFetch } from "./fapi-gate";
import { spotMirrorKlines, bybitKlines, bybitTickerMap } from "./flow-bridge"; // v12.3 TASK-52 klines · v12.4 TASK-53 pool mirror
import { isTradeableTicker } from "./price-armor"; // v12.0 Task 44-① zombie-ticker rejection at the feed layer

const BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];
const FAPI = "https://fapi.binance.com";
// dual-host failover for the futures REST plane (same pattern as BINANCE_HOSTS)
const FAPI_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com"];
const TIMEOUT_MS = 6500;

import type { Candle } from "./indicators";
import { noteSpotHostThrottle, spotHostsReady } from "./spot-host-gate";
export type { Candle };

export interface FeedStatus {
  source: "LIVE" | "STALE" | "SIMULATED";
  lastOkAt: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  host: string | null;
  fallbackVenue?: string | null; // DATA-REVIVAL 2026-10-21 — venue feeding when Binance planes are banned ("BYBIT" | "SPOT-MIRROR")
}

const feedStatus: FeedStatus = { source: "LIVE", lastOkAt: null, latencyMs: null, consecutiveFailures: 0, host: null, fallbackVenue: null };

// v12.5 — throttled telemetry for the bybit mirror rung (one line / 10min max)
let lastBybitMirrorEventAt = 0;

export function getFeedStatus(): FeedStatus {
  if (feedStatus.lastOkAt && feedStatus.source !== "SIMULATED") {
    const age = Date.now() - feedStatus.lastOkAt;
    if (age > 5 * 60_000) return { ...feedStatus, source: "SIMULATED" };
    if (age > 20_000 && feedStatus.source === "LIVE") return { ...feedStatus, source: "STALE" };
  }
  return { ...feedStatus };
}

/** v12.5 TASK-52-REVIVAL — mark the feed alive from a NON-Binance rung.
 * The FEED-FRESH deploy guard measures liveness of REAL perp data, not the
 * reachability of one venue: when both Binance REST planes are pool-banned
 * but the Bybit linear mirror is serving genuine ticks, that is LIVE data —
 * counting it as a failure-streak starved deployment for no honesty reason
 * (measured 2026-10-20: 10–28 consecutive failures while Bybit served prices
 * and deploys continued only through recovery gaps — supervisor SIMULATION
 * warnings were a venue-liveness artifact, not a stale-data event). */
export function markFeedOk(host: string): void {
  feedStatus.lastOkAt = Date.now();
  feedStatus.latencyMs = null; // cross-venue rung — latency not comparable
  feedStatus.host = host;
  feedStatus.consecutiveFailures = 0;
  // DATA-REVIVAL — honest sourcing: name the venue that actually fed the feed
  feedStatus.fallbackVenue = host.includes("bybit") ? "BYBIT" : host.includes("binance.vision") ? "SPOT-MIRROR" : feedStatus.fallbackVenue;
  if (feedStatus.source !== "LIVE") feedStatus.source = "LIVE";
}

async function fetchJson<T>(path: string, hosts: string[] = BINANCE_HOSTS): Promise<T> {
  let lastErr: unknown;
  const ready = spotHostsReady(hosts); // v13.2.1 — mid-ban hosts are skipped, traffic slides to the healthy rung
  if (ready.length === 0) throw new Error(`spot-host-gate: all hosts mid-ban for ${path}`);
  for (const host of ready) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(`${host}${path}`, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (res.status === 418 || res.status === 429) {
        noteSpotHostThrottle(host, res.status, res.headers);
        throw new Error(`${host}${path} → ${res.status} (gate armed)`);
      }
      if (!res.ok) throw new Error(`${host}${path} → ${res.status}`);
      const json = (await res.json()) as T;
      feedStatus.lastOkAt = Date.now();
      feedStatus.latencyMs = Date.now() - t0;
      feedStatus.consecutiveFailures = 0;
      feedStatus.host = host.replace("https://", "");
      feedStatus.fallbackVenue = null; // Binance plane healthy — no fallback active
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
  // v12.0 price-armor: a ticker with bid=0 && ask=0 is a zombie/halted listing
  // (measured live: XMRUSDT spot 118.70 with an empty book vs perp ~592)
  bidPrice?: string;
  askPrice?: string;
  /** v12.0 — which plane produced this row: "fapi" (the perp market itself)
   * or "spot" (overlay fallback). The price-armor cross-plane divergence guard
   * applies ONLY to spot rows — fapi prints are the market.
   * v12.5 TASK-52-REVIVAL: "bybit" = the Bybit v5 linear mirror rung — a
   * perp-native real price from another venue, treated exactly like fapi
   * (no cross-plane spot guard; it IS the perp market, not an overlay). */
  plane?: "fapi" | "spot" | "bybit";
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
  // v12.0 price-armor — zombie filter on BOTH planes: a halted/delisted
  // listing (empty book) must never masquerade as a live terminal price.
  const zombie = (t: Ticker24h) => !isTradeableTicker(t);
  try {
    const all = await fetchJsonFapi<Ticker24h[]>("/fapi/v1/ticker/24hr", { priority: "critical", weight: 40 }); // full-universe ticker — heavy, gated
    for (const t of all) if (want.has(t.symbol) && !zombie(t)) out.set(t.symbol, { ...t, plane: "fapi" });
  } catch {
    /* fall through to the spot overlay below */
  }
  const missing = symbols.filter((s) => !out.has(s));
  if (missing.length > 0) {
    try {
      const spot = await fetchJson<Ticker24h[]>("/api/v3/ticker/24hr");
      for (const t of spot) if (want.has(t.symbol) && !out.has(t.symbol) && !zombie(t)) out.set(t.symbol, { ...t, plane: "spot" });
    } catch {
      /* bybit mirror rung below */
    }
  }
  // v12.5 TASK-52-REVIVAL — BYBIT LINEAR MIRROR rung (perp-native, zero fapi
  // weight, separate venue/ban pool entirely). Serves the board when BOTH
  // Binance REST planes are blackholed (fapi pool ban + spot overlay) so the
  // domain keeps REAL prices instead of drifting to sim → the SIM-PRICE
  // deploy ban stopped starving detection during bans (audit 2026-10-20:
  // deploy cadence halved 91→34/day while 7/44 assets sat on sim drift).
  const stillMissing = symbols.filter((s) => !out.has(s));
  if (stillMissing.length > 0) {
    try {
      const byb = await bybitTickerMap();
      if (byb.size > 0) {
        let served = 0;
        for (const s of stillMissing) {
          const r = byb.get(s);
          if (!r || r.lastPrice <= 0) continue;
          const t: Ticker24h = {
            symbol: s,
            lastPrice: String(r.lastPrice),
            // Bybit reports 24h change as a FRACTION (price24hPcnt 0.0096 = +0.96%)
            priceChangePercent: r.price24hPcnt !== null ? String(r.price24hPcnt * 100) : "0",
            highPrice: String(r.highPrice24h ?? r.lastPrice),
            lowPrice: String(r.lowPrice24h ?? r.lastPrice),
            quoteVolume: String(r.turnover24h ?? 0),
            bidPrice: r.bid1Price !== null ? String(r.bid1Price) : undefined,
            askPrice: r.ask1Price !== null ? String(r.ask1Price) : undefined,
            plane: "bybit",
          };
          if (!zombie(t)) {
            out.set(s, t);
            served++;
          }
        }
        if (served > 0) {
          markFeedOk("bybit-v5-mirror");
          if (Date.now() - lastBybitMirrorEventAt > 600_000) {
            lastBybitMirrorEventAt = Date.now();
            console.log(`[market-feed] BYBIT-MIRROR serving ${served} ticker(s) — both Binance REST planes unavailable (Task-52 revival rung)`);
          }
        }
      }
    } catch {
      /* caller falls back to sim drift — unchanged */
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
 * v10.16 P1 FUTURES UNIFICATION — kline fetcher with a resilience ladder.
 * v12.3 TASK-52 SPOT-MIRROR PRIMARY (operator mandate «مهاجرت لاین REST به
 * SPOT-MIRROR تا fapi فقط بار ticker وزن-40 را بکشد»): the engine-wide TA
 * kline line (15m/160 per scanned symbol — the single heaviest kline lane)
 * now resolves against the SPOT mirror FIRST (api.binance.com lives in a
 * SEPARATE rate/ban pool — every kline call it absorbs is one the fapi gate
 * never spends and one that can never escalate an fapi ban). TA indicators
 * (EMA/RSI/MACD/ATR) are venue-agnostic at bps level; rung 2 is fapi (gate,
 * critical) for 1000X-style perp-only listings; rung 3 is BYBIT linear.
 * Response mapping identical to the legacy version — every consumer (engine
 * getKlines, shadow sweeps, regime) sees the same Candle shape.
 */
export async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  try {
    const spot = await fetchJson<(string | number)[][]>(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (spot.length) return mapKlines(spot);
  } catch {
    /* fapi rung below */
  }
  try {
    const perp = await gateFetch<(string | number)[][]>(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, { priority: "critical" });
    if (perp.length) return mapKlines(perp);
  } catch {
    /* bybit rung below */
  }
  const byb = await bybitKlines(symbol, interval, limit).catch(() => null);
  if (byb && byb.length > 0) {
    return byb.map((k) => ({ openTime: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
  }
  throw new Error(`fetchKlines: all rungs failed for ${symbol} ${interval}`);
}

/**
 * Futures-native klines (USDT-M) — same payload shape (gated, critical).
 * v12.3 TASK-52: fapi stays RUNG 1 here (backtest/volOnset/volCause are
 * futures-calibrated analytics — spot-first would silently re-baseline
 * them), but the ladder degrades to SPOT-MIRROR → BYBIT during fapi
 * starvation instead of hard-failing.
 */
export async function fetchFuturesKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  try {
    const raw = await gateFetch<(string | number)[][]>(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, { priority: "critical" });
    if (raw.length) return mapKlines(raw);
  } catch {
    /* spot rung below */
  }
  try {
    const spot = await fetchJson<(string | number)[][]>(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (spot.length) return mapKlines(spot);
  } catch {
    /* bybit rung below */
  }
  const byb = await bybitKlines(symbol, interval, limit).catch(() => null);
  if (byb && byb.length > 0) {
    return byb.map((k) => ({ openTime: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
  }
  throw new Error(`fetchFuturesKlines: all rungs failed for ${symbol} ${interval}`);
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
  const tickers = await fetchJsonFapi<Ticker24h[]>("/fapi/v1/ticker/24hr", { priority: "critical", weight: 40 });
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
  const info = await fetchJsonFapi<{ symbols: Array<{ symbol: string; contractType: string; status: string; quoteAsset: string }> }>("/fapi/v1/exchangeInfo", { priority: "critical", weight: 1 });
  return new Set(info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING" && s.quoteAsset === "USDT").map((s) => s.symbol));
}

// ── futures pool stats (v5.2 — scan-domain coverage, TASK-53 mirror rung) ──
export interface FuturesPoolStats {
  totalUsdtPerps: number; // every USDT-M perpetual trading right now
  liquidPool: number; // those with >$1M 24h quote volume (the scannable pool)
  measuredAt: string;
  /** honest venue label — which market counted this pool (Task 53 honesty laws) */
  source: "BINANCE-FAPI" | "BYBIT-MIRROR" | "PERSISTED";
}

let poolCache: { at: number; value: FuturesPoolStats } | null = null;
const POOL_TTL = 15 * 60_000;

// v5.2 TASK-53: persist the last good board so an app restart during an fapi
// ban doesn't zero the POOL readout (23:14Z boot with the ban live did exactly
// that — lastPoolSize seeded from nothing while the ban starved both rungs).
const POOL_FILE = ".data/pool-stats.json";
const POOL_PERSIST_MAX_AGE = 24 * 60 * 60_000;

function persistPool(value: FuturesPoolStats): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    fs.writeFileSync(POOL_FILE, JSON.stringify(value), "utf8");
  } catch {
    /* best-effort telemetry — never a gate */
  }
}

function persistedPool(): FuturesPoolStats | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    const raw = JSON.parse(fs.readFileSync(POOL_FILE, "utf8")) as FuturesPoolStats;
    if (!raw || typeof raw.totalUsdtPerps !== "number") return null;
    if (Date.now() - new Date(raw.measuredAt).getTime() > POOL_PERSIST_MAX_AGE) return null;
    return { ...raw, source: "PERSISTED" };
  } catch {
    return null;
  }
}

/** BYBIT-MIRROR rung — v5 linear tickers (ONE weight-cheap call, zero fapi weight). */
async function bybitPoolStats(): Promise<FuturesPoolStats | null> {
  const map = await bybitTickerMap().catch(() => null);
  if (!map || map.size === 0) return null;
  const usdtPerps = [...map.entries()].filter(([sym]) => sym.endsWith("USDT") && !LEVERAGED.test(sym));
  if (usdtPerps.length === 0) return null;
  return {
    totalUsdtPerps: usdtPerps.length,
    liquidPool: usdtPerps.filter(([sym, r]) => (r.turnover24h ?? 0) > 1_000_000 && !isStablePrice(r.lastPrice) && !STABLE_BASES.has(sym.replace("USDT", ""))).length,
    measuredAt: new Date().toISOString(),
    source: "BYBIT-MIRROR",
  };
}

/** How big is the whole futures market? Cached 15min — powers SCAN DOMAIN coverage.
 *  v5.2 LADDER: fapi (weight-40 board) → BYBIT-MIRROR (v5 linear tickers) →
 *  PERSISTED (≤24h old) → zeros. The ladder keeps POOL alive through fapi bans. */
export async function fetchFuturesPoolStats(): Promise<FuturesPoolStats> {
  if (poolCache && Date.now() - poolCache.at < POOL_TTL) return poolCache.value;
  try {
    const tickers = await fetchJsonFapi<Ticker24h[]>("/fapi/v1/ticker/24hr", { priority: "telemetry", weight: 40 }); // 15min-cached board stat — sheddable
    const usdtPerps = tickers.filter((t) => t.symbol.endsWith("USDT") && !LEVERAGED.test(t.symbol));
    const value: FuturesPoolStats = {
      totalUsdtPerps: usdtPerps.length,
      liquidPool: usdtPerps.filter((t) => Number(t.quoteVolume) > 1_000_000 && !isStablePrice(Number(t.lastPrice)) && !STABLE_BASES.has(t.symbol.replace("USDT", ""))).length,
      measuredAt: new Date().toISOString(),
      source: "BINANCE-FAPI",
    };
    poolCache = { at: Date.now(), value };
    persistPool(value);
    return value;
  } catch {
    // fapi banned/unreachable — mirror rung (Task 53): count the pool off Bybit
    const mirror = await bybitPoolStats().catch(() => null);
    if (mirror) {
      console.log(`[pool-stats] fapi unavailable — BYBIT-MIRROR serving pool board ${mirror.totalUsdtPerps}/${mirror.liquidPool} (Task-53)`); // honest venue telemetry
      poolCache = { at: Date.now(), value: mirror };
      persistPool(mirror);
      return mirror;
    }
    const saved = persistedPool();
    if (saved) {
      poolCache = { at: Date.now(), value: saved };
      return saved;
    }
    return poolCache?.value ?? { totalUsdtPerps: 0, liquidPool: 0, measuredAt: new Date().toISOString(), source: "BINANCE-FAPI" };
  }
}

export const FUTURES_FAPI = FAPI;

// ── v10.24 Task 34-a — gated futures fetch (fapi plane ONLY) ───────────────
// Same contract as fetchJson (resolve JSON or THROW) so every existing caller
// keeps its exact semantics; failures just become MORE common under weight
// pressure / IP bans — by design (callers are throw-tolerant with fallbacks).
// Walks FAPI_HOSTS through the gate: bans/weight are per-IP, so the alt host
// shares the same budget/ban state (a ban nulls the alt attempt instantly).
async function fetchJsonFapi<T>(path: string, opts?: { priority?: "critical" | "telemetry"; weight?: number }): Promise<T> {
  let lastErr: unknown;
  for (const host of FAPI_HOSTS) {
    const t0 = Date.now();
    const json = await gateFetch<T>(path, { ...opts, host });
    if (json !== null) {
      feedStatus.lastOkAt = Date.now();
      feedStatus.latencyMs = Date.now() - t0;
      feedStatus.consecutiveFailures = 0;
      feedStatus.host = host.replace("https://", "");
      feedStatus.fallbackVenue = null; // Binance plane healthy — no fallback active
      if (feedStatus.source !== "LIVE") feedStatus.source = "LIVE";
      return json;
    }
    feedStatus.consecutiveFailures++;
    lastErr = new Error(`fapi ${path} unavailable via ${host}`);
  }
  throw lastErr;
}
