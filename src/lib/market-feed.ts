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
import { readFileSync } from "node:fs"; // v13.4 spot-print liveness probe
import { spotMirrorKlines } from "./flow-bridge"; // v12.3 TASK-52 klines · v14.0 Binance-only
import { isTradeableTicker } from "./price-armor"; // v12.0 Task 44-① zombie-ticker rejection at the feed layer

// v13.3 BINANCE-LADDER (trace 1a184429d4bd0d05, restored 1a1849f647778885) —
// full official spot-REST set per binance-spot-api-docs: vision (dedicated
// market-data pool) → api-gcp (official GCP mirror, 200 6/6 @59ms 2026-10-28)
// → api1-4 mirrors → api last. Per-host 418/429 backoff via spot-host-gate.
const BINANCE_HOSTS = ["https://data-api.binance.vision", "https://api-gcp.binance.com", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com", "https://api.binance.com"]; // v13.3 ladder + api-gcp
const FAPI = "https://fapi.binance.com";
// dual-host failover for the futures REST plane — fapi is the ONLY official
// USDT-M futures REST host: fapi1.binance.com probed 2026-10-25 = HTTP 302
// redirect (not an API host) → removed as a dead rung.
const FAPI_HOSTS = ["https://fapi.binance.com"];
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
  fallbackVenue?: string | null; // DATA-REVIVAL 2026-10-21 — Binance plane feeding when fapi is banned ("SPOT-MIRROR" | "FUTWS-RING")
}

const feedStatus: FeedStatus = { source: "LIVE", lastOkAt: null, latencyMs: null, consecutiveFailures: 0, host: null, fallbackVenue: null };

// v12.5 — throttled telemetry for the fallback rungs (one line / 10min max)
let lastFallbackEventAt = 0;

// ── v13.4 SPOT-PRINT-LIVENESS (trace 1a1849f647778885 — operator mandate:
// «سیستم کاملا از دیتای زنده و لحظه‌ای بایننس استفاده کند») ──────────────────
// price-ws (:3003) owns the hours-proven Binance spot !miniTicker@arr WS and
// pushes ~400 genuine live Binance spot prints into .data/spotws-quotes.json
// EVERY 3s — and since v13.4 it writes the file DIRECTLY (survives app
// restarts). getFeedStatus() recognizes that plane: fresh prints (≤90s,
// exchange timestamps) = LIVE with host labeled spot-ws-ring. 3s memo keeps
// the hot pulse path cheap; REST truth stays in charge when prints age out.
const SPOTWS_FILE = ".data/spotws-quotes.json";
const SPOTWS_FRESH_MS = 90_000;
let spotwsProbe: { at: number; fresh: boolean; printAt: number | null; rows: number } = { at: 0, fresh: false, printAt: null, rows: 0 };

// ── v13.5 FUTWS-LIVENESS (trace 1a184d8bbb826f0d) — .data/futws-quotes.json
// is written DIRECTLY by price-ws :3003 every 3s from the futures bookTicker
// ring (44 liquid perps, best bid/ask → mid). Fresh file (≤90s payload) = the
// Binance FUTURES plane is exchange-pushed live: source stays LIVE through
// app restarts, REST pool bans and boot windows, and fetchTickers overlays
// those mids as perp-native quotes (see fetchTickers rung 2). 3s memo keeps
// the hot pulse path cheap.
const FUTWS_FILE = ".data/futws-quotes.json";
const FUTWS_FRESH_MS = 90_000;
interface FutwsRow { s: string; b: number; a: number; m: number; t: number }
let futwsProbe: { at: number; fresh: boolean; printAt: number | null; rows: FutwsRow[] } = { at: 0, fresh: false, printAt: null, rows: [] };

function futwsLiveness(): { fresh: boolean; printAt: number | null; rows: FutwsRow[] } {
  const now = Date.now();
  if (now - futwsProbe.at < 3_000) return futwsProbe;
  futwsProbe = { at: now, fresh: false, printAt: null, rows: [] };
  try {
    const raw = readFileSync(FUTWS_FILE, "utf8");
    const j = JSON.parse(raw) as { at?: number; rows?: FutwsRow[] };
    const rows = Array.isArray(j.rows) ? j.rows : [];
    const payloadAt = Number(j.at) || 0;
    if (payloadAt > 0 && now - payloadAt < FUTWS_FRESH_MS + 10_000 && rows.length > 0) {
      futwsProbe = { at: now, fresh: true, printAt: payloadAt, rows };
    }
  } catch {
    /* file missing/unreadable → not fresh; REST truth stays in charge */
  }
  return futwsProbe;
}

/** v13.5 — honest futures-ring status for the dashboard Event Stream Health row. */
export function getFutwsStatus(): { fresh: boolean; rows: number; ageMs: number | null } {
  const p = futwsLiveness();
  return { fresh: p.fresh, rows: p.rows.length, ageMs: p.printAt ? Date.now() - p.printAt : null };
}

/** v13.5 — fresh per-symbol futures quotes (per-row ≤30s guard like the ring). */
export function futwsQuoteMap(): Map<string, { bid: number; ask: number; mid: number; t: number }> {
  const out = new Map<string, { bid: number; ask: number; mid: number; t: number }>();
  const p = futwsLiveness();
  if (!p.fresh) return out;
  const now = Date.now();
  for (const r of p.rows) {
    if (!r || !r.s || !(r.m > 0)) continue;
    if (now - (r.t ?? 0) > 30_000) continue;
    out.set(r.s, { bid: r.b, ask: r.a, mid: r.m, t: r.t });
  }
  return out;
}

function spotPrintLiveness(): { fresh: boolean; printAt: number | null; rows: number } {
  const now = Date.now();
  if (now - spotwsProbe.at < 3_000) return spotwsProbe;
  spotwsProbe = { at: now, fresh: false, printAt: null, rows: 0 };
  try {
    const raw = readFileSync(SPOTWS_FILE, "utf8");
    const j = JSON.parse(raw) as { at?: number; rows?: Array<{ t?: number }> };
    const rows = Array.isArray(j.rows) ? j.rows : [];
    const payloadAt = Number(j.at) || 0;
    if (payloadAt > 0 && now - payloadAt < SPOTWS_FRESH_MS + 10_000 && rows.length > 0) {
      spotwsProbe = { at: now, fresh: true, printAt: payloadAt, rows: rows.length };
    }
  } catch {
    /* file missing/unreadable → not fresh; REST truth stays in charge */
  }
  return spotwsProbe;
}

export function getFeedStatus(): FeedStatus {
  // v13.5 — futures bookTicker ring FIRST: a live Binance FUTURES plane beats
  // the spot mirror in the host label (operator mandate «دیتای زندهٔ بایننس
  // فیوچرز»); both files come from the same price-ws :3003 process.
  const futws = futwsLiveness();
  if (futws.fresh) {
    const FUT_HOST = "fut-ws-book + spot-ws-ring (price-ws :3003)";
    if (feedStatus.host !== FUT_HOST) {
      feedStatus.host = FUT_HOST;
      feedStatus.fallbackVenue = null; // native Binance futures plane — no fallback
      feedStatus.consecutiveFailures = 0;
    }
    feedStatus.source = "LIVE";
    if (!feedStatus.lastOkAt || Date.now() - feedStatus.lastOkAt > 20_000) feedStatus.lastOkAt = futws.printAt ?? Date.now();
    return { ...feedStatus };
  }
  const spotws = spotPrintLiveness();
  if (spotws.fresh) {
    // live Binance spot prints ≤90s old — the feed IS live regardless of the
    // REST poller's in-memory state (app restarts, pool bans, boot windows).
    // The host label PREFERS the Binance ring whenever it is fresh — the
    // operator's mandate is «دیتای زندهٔ بایننس»; a fallback REST rung must
    // not mask the Binance plane printing every 3s.
    if (feedStatus.host !== "spot-ws-ring (price-ws :3003)") {
      feedStatus.host = "spot-ws-ring (price-ws :3003)";
      feedStatus.fallbackVenue = "SPOT-MIRROR";
      feedStatus.consecutiveFailures = 0;
    }
    feedStatus.source = "LIVE";
    if (!feedStatus.lastOkAt || Date.now() - feedStatus.lastOkAt > 20_000) feedStatus.lastOkAt = spotws.printAt ?? Date.now();
    return { ...feedStatus };
  }
  if (feedStatus.lastOkAt && feedStatus.source !== "SIMULATED") {
    const age = Date.now() - feedStatus.lastOkAt;
    if (age > 5 * 60_000) return { ...feedStatus, source: "SIMULATED" };
    if (age > 20_000 && feedStatus.source === "LIVE") return { ...feedStatus, source: "STALE" };
  }
  return { ...feedStatus };
}

/** v12.5 TASK-52-REVIVAL — mark the feed alive from a NON-fapi Binance rung.
 * The FEED-FRESH deploy guard measures liveness of REAL perp data, not the
 * reachability of one plane: when the fapi pool is banned but the SPOT-MIRROR
 * ladder / the futures bookTicker ring is serving genuine Binance ticks, that
 * is LIVE data — counting it as a failure-streak starved deployment for no
 * honesty reason. v14.0: Binance-only rungs. */
export function markFeedOk(host: string): void {
  feedStatus.lastOkAt = Date.now();
  feedStatus.latencyMs = null; // non-fapi rung — latency not comparable
  feedStatus.host = host;
  feedStatus.consecutiveFailures = 0;
  // DATA-REVIVAL — honest sourcing: name the Binance plane that actually fed the feed
  feedStatus.fallbackVenue = host.includes("futws") ? "FUTWS-RING" : host.includes("binance.vision") ? "SPOT-MIRROR" : feedStatus.fallbackVenue;
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
   * v12.5 TASK-52-REVIVAL: "futws" = the futures bookTicker ring rung — a
   * perp-native real price from another venue, treated exactly like fapi
   * (no cross-plane spot guard; it IS the perp market, not an overlay).
   * v13.5: "futws" = the price-ws futures bookTicker ring — a LIVE Binance
   * perp mid (best bid/ask) pushed over WS, treated like fapi (perp-native). */
  plane?: "fapi" | "spot" | "futws";
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
  // v13.5 FUTWS OVERLAY rung — the live Binance futures bookTicker mid from
  // price-ws :3003. When the fapi board is throttled/banned but the WS ring
  // is printing (it is REST-weight-free), missing symbols get a PERP-NATIVE
  // live price instead of sliding to the spot overlay (basis) or the ring.
  if (missing.length > 0) {
    const fut = futwsQuoteMap();
    for (const s of missing) {
      const q = fut.get(s);
      if (!q) continue;
      const t: Ticker24h = {
        symbol: s,
        lastPrice: String(q.mid),
        priceChangePercent: "0", // bookTicker carries no 24h window — honest zero
        highPrice: String(q.mid),
        lowPrice: String(q.mid),
        quoteVolume: "0", // no 24h volume on the book plane — consumers rank elsewhere
        bidPrice: String(q.bid),
        askPrice: String(q.ask),
        plane: "futws",
      };
      if (!zombie(t)) out.set(s, t);
    }
  }
  const stillMissingAfterFutws = symbols.filter((s) => !out.has(s));
  if (stillMissingAfterFutws.length > 0) {
    try {
      const spot = await fetchJson<Ticker24h[]>("/api/v3/ticker/24hr");
      for (const t of spot) if (want.has(t.symbol) && !out.has(t.symbol) && !zombie(t)) out.set(t.symbol, { ...t, plane: "spot" });
    } catch {
      /* fallback rung below */
    }
  }
  // v14.0 BINANCE-ONLY — the v12.5 cross-venue mirror rung is retired. After
  // the futws ring + the spot overlay, futures-only tickers missing from both
  // stay honestly missing when fapi is banned (no invented data, no foreign
  // venue) — the caller falls back to sim drift exactly as documented.
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
 * critical) for 1000X-style perp-only listings. v14.0: Binance-only — both
 * planes failing throws honestly.
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
    /* honest failure below */
  }
  throw new Error(`fetchKlines: all Binance rungs failed for ${symbol} ${interval}`);
}

/**
 * Futures-native klines (USDT-M) — same payload shape (gated, critical).
 * v12.3 TASK-52: fapi stays RUNG 1 here (backtest/volOnset/volCause are
 * futures-calibrated analytics — spot-first would silently re-baseline
 * them), but the ladder degrades to SPOT-MIRROR during fapi starvation
 * instead of hard-failing (v14.0 Binance-only).
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
    /* honest failure below */
  }
  throw new Error(`fetchFuturesKlines: all Binance rungs failed for ${symbol} ${interval}`);
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
  /** honest plane label — which Binance market counted this pool (Task 53 honesty laws) */
  source: "BINANCE-FAPI" | "PERSISTED";
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

/** How big is the whole futures market? Cached 15min — powers SCAN DOMAIN coverage.
 *  v5.2 LADDER (v14.0 Binance-only): fapi (weight-40 board) → PERSISTED
 *  (≤24h old) → zeros. A spot board cannot count a PERP pool — the cross-venue
 *  mirror rung is retired; persistence keeps the readout alive through bans. */
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
    // fapi banned/unreachable — persisted board (Task 53, v14.0)
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
