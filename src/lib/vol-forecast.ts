// ── FlowRadar Neo v8.1 VOLATILITY FORECAST (P2, server-only) ─────────────
// Operator mandate 2026-09-08: «طبق نظر مهندسی P1 و P2 رو کامل اجرا کن».
//
// Model — deterministic, measured only, closed bars only:
//   · EWMA(λ=0.94) on 15m log returns (RiskMetrics recursion) → ewmaBarPct
//     scaled by √4 to the 1h horizon → ewma1hPct
//   · HAR-lite realized blend over the 6h window → har6hPct
//   · ATR%(14) on 15m bars → atr15mPct (shared with the liq-heat reach band)
//   · regime = ewma1hPct vs the symbol's OWN trailing distribution (percentile
//     rank over the last 96 bars, 8-bar steps) — self-referential, honest:
//     LOW <p20 · NORMAL · ELEVATED <p80 · EXTREME ≥p80
//
// Geometry contract consumed by engine.ts deploy path (volGeometry):
//   LOW      → stop ×0.90, RR +0.1  (dead tape: tighter stop, closer targets)
//   NORMAL   → ×1.00, ±0            (unchanged — tag omitted)
//   ELEVATED → stop ×1.05, RR −0.1  (room without paying the far rung)
//   EXTREME  → stop ×1.15, RR −0.2  (eruption tape: wider stop, trimmed targets)
// Cohort tags VOL-REGIME-{LOW|ELEVATED|EXTREME} feed the A/B ledger.
//
// Memory bounds: k15 cache ≤64 symbols × 97 bars (TTL 120s, in-flight dedupe),
// forecast cache ≤64 rows. No unbounded state, no invented numbers.

import { db } from "@/lib/db";
import { gateFetch } from "./fapi-gate";

export type VolRegime = "LOW" | "NORMAL" | "ELEVATED" | "EXTREME";

export interface VolForecast {
  symbol: string;
  at: number;
  ewmaBarPct: number; // EWMA stdev, % per 15m bar (unlevered)
  ewma1hPct: number; // EWMA scaled √4 → % per 1h horizon
  har6hPct: number; // realized-vol blend over the 6h window, % per bar
  regime: VolRegime;
  percentile: number; // 0..100 rank of ewma1hPct in its own trailing distribution
  atr15mPct: number; // ATR(14)% on 15m bars
}

export interface VolGeometry {
  slMult: number; // stop-distance multiplier (bounded ×0.9..×1.15)
  rrAdj: number; // additive R:R adjustment (bounded ±0.2)
  tag: string | null; // cohort tag, null when NORMAL
  note: string | null; // human-readable analysis line, null when NORMAL
}

const CACHE_TTL = 90_000; // recompute at most ~1/min per symbol
const PEEK_TTL = 10 * 60_000; // hot-path read guard — stale rows never gate
const BOARD_KEY = "volforecast.board";
const BOARD_TTL = 30 * 60_000; // persisted board feeds the API on cold boot

// ── geometry table (doctrine in the header) ──
const GEOMETRY: Record<VolRegime, { slMult: number; rrAdj: number }> = {
  LOW: { slMult: 0.9, rrAdj: 0.1 },
  NORMAL: { slMult: 1.0, rrAdj: 0 },
  ELEVATED: { slMult: 1.05, rrAdj: -0.1 },
  EXTREME: { slMult: 1.15, rrAdj: -0.2 },
};

/** Null-safe geometry read — the deploy path calls this on every deployment. */
export function volGeometry(v: VolForecast | null): VolGeometry {
  if (!v) return { slMult: 1, rrAdj: 0, tag: null, note: null };
  if (v.regime === "NORMAL") return { slMult: 1, rrAdj: 0, tag: null, note: null };
  const g = GEOMETRY[v.regime];
  const tag = `VOL-REGIME-${v.regime}`;
  const note =
    v.regime === "LOW"
      ? `regime LOW (self-pct ${v.percentile}, EWMA 1h ${v.ewma1hPct.toFixed(2)}%) → stop ×0.9, targets +0.1R — dead tape, tighten`
      : v.regime === "ELEVATED"
        ? `regime ELEVATED (self-pct ${v.percentile}, EWMA 1h ${v.ewma1hPct.toFixed(2)}%) → stop ×1.05, targets −0.1R — hot tape, breathe but trim`
        : `regime EXTREME (self-pct ${v.percentile}, EWMA 1h ${v.ewma1hPct.toFixed(2)}%) → stop ×1.15, targets −0.2R — eruption tape, survive first`;
  return { slMult: g.slMult, rrAdj: g.rrAdj, tag, note };
}

// ── shared 15m kline cache (also consumed by risk-overlay) ──
interface K15 {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
const k15Cache = new Map<string, { at: number; candles: K15[] }>();
const k15InFlight = new Map<string, Promise<K15[] | null>>();

export async function getKlines15m(symbol: string): Promise<K15[] | null> {
  const hit = k15Cache.get(symbol);
  if (hit && Date.now() - hit.at < 120_000) return hit.candles;
  const existing = k15InFlight.get(symbol);
  if (existing) return existing;
  const p = (async (): Promise<K15[] | null> => {
    try {
      // v10.24 Task 34-a: klines through the central fapi-gate (telemetry lane
      // — sheddable; the deploy path's volGeometry(null) is fail-open NORMAL).
      const raw = await gateFetch<(string | number)[][]>(`/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=97`, { priority: "telemetry", timeoutMs: 6500 });
      if (!raw) return null;
      const candles = raw.map((k) => ({ openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) }));
      k15Cache.set(symbol, { at: Date.now(), candles });
      if (k15Cache.size > 64) {
        const oldest = [...k15Cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) k15Cache.delete(oldest[0]);
      }
      return candles;
    } catch {
      return null;
    } finally {
      k15InFlight.delete(symbol);
    }
  })();
  k15InFlight.set(symbol, p);
  return p;
}

// ── core math (closed bars only — the possibly-unclosed last bar is dropped) ──
function computeForecast(symbol: string, raw: K15[] | null): VolForecast | null {
  const candles = raw ? raw.slice(0, -1) : null;
  if (!candles || candles.length < 60) return null;

  const rets: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const p0 = candles[i - 1]!.close;
    const p1 = candles[i]!.close;
    if (p0 > 0 && p1 > 0) rets.push(Math.log(p1 / p0));
  }
  if (rets.length < 55) return null;

  // EWMA variance (λ=0.94), RiskMetrics recursion
  const lambda = 0.94;
  let ewmaVar = rets[0]! * rets[0]!;
  for (let i = 1; i < rets.length; i++) ewmaVar = lambda * ewmaVar + (1 - lambda) * rets[i]! * rets[i]!;
  const ewmaBarPct = Math.sqrt(ewmaVar) * 100;
  const ewma1hPct = ewmaBarPct * 2; // √4 bars per hour

  // HAR-lite: realized-vol blend over the 6h window (24 bars) vs 24h (96)
  const rv = (n: number): number | null => {
    const w = rets.slice(-n);
    if (w.length < Math.min(20, n)) return null;
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    return Math.sqrt(w.reduce((a, b) => a + (b - mean) * (b - mean), 0) / w.length) * 100;
  };
  const rv6h = rv(24);
  const rv1d = rv(96);
  const parts = [rv6h, rv1d].filter((v): v is number => v !== null);
  if (parts.length === 0) return null;
  const har6hPct = parts.length === 2 ? 0.6 * rv6h! + 0.4 * rv1d! : parts[0]!;

  // ATR%(14) true range on 15m bars
  let atrSum = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    atrSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const atr15mPct = (atrSum / 14 / candles[candles.length - 1]!.close) * 100;

  // trailing EWMA-1h distribution for the self-percentile rank (96 bars, 8-bar steps)
  const trail: number[] = [];
  for (let start = Math.max(0, rets.length - 96); start <= rets.length - 24; start += 8) {
    const w = rets.slice(start, start + 24);
    if (w.length < 20) continue;
    let v = w[0]! * w[0]!;
    for (let i = 1; i < w.length; i++) v = lambda * v + (1 - lambda) * w[i]! * w[i]!;
    trail.push(Math.sqrt(v) * 100 * 2);
  }
  const percentile = trail.length >= 6 ? Math.round((trail.filter((v) => v <= ewma1hPct).length / trail.length) * 100) : 50;
  const regime: VolRegime = percentile < 20 ? "LOW" : percentile < 55 ? "NORMAL" : percentile < 80 ? "ELEVATED" : "EXTREME";

  return {
    symbol,
    at: Date.now(),
    ewmaBarPct: Number(ewmaBarPct.toFixed(3)),
    ewma1hPct: Number(ewma1hPct.toFixed(3)),
    har6hPct: Number(har6hPct.toFixed(3)),
    regime,
    percentile,
    atr15mPct: Number(atr15mPct.toFixed(3)),
  };
}

// ── caches ──
const forecastCache = new Map<string, { at: number; v: VolForecast }>();
const inFlight = new Map<string, Promise<VolForecast | null>>();
let boardLoaded = false;

async function loadBoard(): Promise<void> {
  if (boardLoaded) return;
  boardLoaded = true;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: BOARD_KEY } });
    if (!row) return;
    const parsed = JSON.parse(row.value) as { at: number; rows: VolForecast[] };
    if (Date.now() - parsed.at > BOARD_TTL) return;
    for (const r of parsed.rows ?? []) forecastCache.set(r.symbol, { at: r.at, v: r });
  } catch {
    /* cold start — warms on demand */
  }
}

async function persistBoard(): Promise<void> {
  try {
    const rows = [...forecastCache.values()].map((e) => e.v).slice(0, 48);
    const value = JSON.stringify({ at: Date.now(), rows });
    await db.engineSetting.upsert({ where: { key: BOARD_KEY }, create: { key: BOARD_KEY, value }, update: { value } });
  } catch {
    /* best-effort */
  }
}

/** On-demand forecast — cached ~90s, in-flight deduped. Fire-and-forget warmable. */
export async function getVolForecast(symbol: string): Promise<VolForecast | null> {
  await loadBoard();
  const hit = forecastCache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.v;
  const existing = inFlight.get(symbol);
  if (existing) return existing;
  const p = (async (): Promise<VolForecast | null> => {
    try {
      const candles = await getKlines15m(symbol);
      const v = computeForecast(symbol, candles);
      if (v) {
        forecastCache.set(symbol, { at: Date.now(), v });
        await persistBoard();
      }
      return v;
    } finally {
      inFlight.delete(symbol);
    }
  })();
  inFlight.set(symbol, p);
  return p;
}

/** Sync hot-path read — null when missing/stale; stale rows NEVER gate. */
export function peekVolForecast(symbol: string): VolForecast | null {
  const hit = forecastCache.get(symbol);
  if (!hit) return null;
  if (Date.now() - hit.at > PEEK_TTL) return null;
  return hit.v;
}

const SEVERITY: Record<VolRegime, number> = { EXTREME: 0, ELEVATED: 1, NORMAL: 2, LOW: 3 };

/** Board for /api/vol-forecast — computes up to `take` missing symbols (bounded
    by the 120s kline cache), sorts by regime severity. */
export async function getVolBoard(symbols: string[], take = 12): Promise<{ at: string; coverage: number; rows: VolForecast[] }> {
  await loadBoard();
  let computed = 0;
  for (const s of symbols) {
    if (computed >= take) break;
    const hit = forecastCache.get(s);
    if (hit && Date.now() - hit.at < CACHE_TTL) continue;
    const v = await getVolForecast(s).catch(() => null);
    if (v) computed++;
  }
  const rows = [...forecastCache.values()].map((e) => e.v).sort((a, b) => SEVERITY[a.regime] - SEVERITY[b.regime] || Math.abs(b.percentile - 50) - Math.abs(a.percentile - 50));
  return { at: new Date().toISOString(), coverage: rows.length, rows: rows.slice(0, 24) };
}
