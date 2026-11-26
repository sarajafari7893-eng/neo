// ── NEXUS//SIGNALS — Binance mirror client (server-only, v14.0) ─────────────
// v14.0 BINANCE-ONLY RE-ARCHITECTURE (operator mandate trace 1a185042c872b4f9
// — «ردپای OKX/Bybit در کجا وجود دارد و با بایننس جایگزین شود»): the former
// cross-venue feed module is rebuilt as the BINANCE MIRROR client. Every
// consumer gets a LIVE, honestly-plane-tagged Binance board:
//   • klines/tickers ride the spot-host ladder (data-api.binance.vision →
//     api-gcp → api1-4 → api.binance.com) — a SEPARATE ban pool from fapi,
//     spot klines keep the field-9 taker-buy split (CVD stays REAL).
//   • funding / OI history ride the gated fapi plane (perp-native).
// HONESTY DOCTRINE (October carry-over): fallback-plane data is tagged with
// its real Binance plane; a plane that fails degrades to null — never to
// invented data.
// ─────────────────────────────────────────────────────────────────────────────
import { gateFetch } from "./fapi-gate";
import { noteSpotHostThrottle, spotHostsReady } from "./spot-host-gate";

const TIMEOUT_MS = 6500;

// v13.3 SPOT-HOST LADDER (same family as flow-bridge/market-feed — shared gate)
const SPOT_HOSTS = ["https://data-api.binance.vision", "https://api-gcp.binance.com", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com", "https://api.binance.com"];

interface MirrorHealth {
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
  const g = globalThis as { __nexusMirrorHealth?: MirrorHealth };
  g.__nexusMirrorHealth ??= { lastOkAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0, latencyMs: null, klinesOk: 0, tickersOk: 0, metricsOk: 0 };
  return g.__nexusMirrorHealth;
})();
export function mirrorHealth(): Readonly<MirrorHealth> {
  return health;
}

async function ladderGet<T>(path: string): Promise<T | null> {
  const t0 = Date.now();
  const ready = spotHostsReady(SPOT_HOSTS);
  for (const host of ready) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(`${host}${path}`, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (res.status === 418 || res.status === 429) {
        noteSpotHostThrottle(host, res.status, res.headers);
        continue;
      }
      if (!res.ok) {
        health.lastErrorAt = Date.now();
        health.lastError = `${path} → ${res.status}`;
        health.consecutiveFailures++;
        continue;
      }
      const json = (await res.json()) as T;
      health.lastOkAt = Date.now();
      health.latencyMs = Date.now() - t0;
      health.consecutiveFailures = 0;
      return json;
    } catch (e) {
      health.lastErrorAt = Date.now();
      health.lastError = e instanceof Error ? e.message : String(e);
      health.consecutiveFailures++;
    }
  }
  return null;
}

export interface FlowCandleLike {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuy: number | null; // spot klines carry the REAL field-9 taker-buy split
}

/** Binance SPOT klines via the mirror ladder, oldest→newest. */
export async function mirrorKlines(symbol: string, interval: string, limit: number): Promise<FlowCandleLike[] | null> {
  const raw = await ladderGet<(string | number)[][]>(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(1000, limit)}`);
  if (!Array.isArray(raw) || raw.length === 0) return null;
  health.klinesOk++;
  return raw.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    takerBuy: Number(k[9]),
  }));
}

export interface MirrorTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string; // percent, Binance-native ("1.23")
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
}

/** ONE ladder call → the whole SPOT 24h board (zero fapi weight). */
export async function mirrorTickers(): Promise<Map<string, MirrorTicker>> {
  const out = new Map<string, MirrorTicker>();
  const rows = await ladderGet<Array<Record<string, string>>>("/api/v3/ticker/24hr");
  if (!Array.isArray(rows)) return out;
  health.tickersOk++;
  for (const t of rows) {
    if (!t?.symbol || !(Number(t.lastPrice) > 0)) continue;
    out.set(t.symbol, {
      symbol: t.symbol,
      lastPrice: t.lastPrice,
      priceChangePercent: t.priceChangePercent ?? "0",
      highPrice: t.highPrice ?? t.lastPrice,
      lowPrice: t.lowPrice ?? t.lastPrice,
      quoteVolume: t.quoteVolume ?? "0",
    });
  }
  return out;
}

/** Funding rate (last settled), in percent (0.01% = "0.01") — gated fapi. */
export async function mirrorFunding8h(symbol: string): Promise<number | null> {
  const rows = await gateFetch<Array<{ fundingRate: string }>>(`/fapi/v1/fundingRate?symbol=${symbol}&limit=1`, { priority: "telemetry", timeoutMs: 6000 }).catch(() => null);
  const r = rows?.[0]?.fundingRate;
  if (r === undefined) return null;
  health.metricsOk++;
  const n = Number(r);
  return Number.isFinite(n) ? n * 100 : null;
}

/** 1h open-interest delta % (last closed hourly OI vs previous) — gated fapi. */
export async function mirrorOiDelta1h(symbol: string): Promise<number | null> {
  const rows = await gateFetch<Array<{ sumOpenInterest: string; timestamp: number }>>(`/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=2`, { priority: "telemetry", timeoutMs: 6000 }).catch(() => null);
  if (!Array.isArray(rows) || rows.length < 2) return null;
  health.metricsOk++;
  const cur = Number(rows[0]?.sumOpenInterest);
  const prev = Number(rows[rows.length - 1]?.sumOpenInterest);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return Number((((cur - prev) / prev) * 100).toFixed(3));
}
