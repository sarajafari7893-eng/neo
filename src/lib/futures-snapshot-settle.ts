// ── FlowRadar FWD-SETTLE (P0-b, FWD-SETTLE-20261025) ────────────────────────
// Revival of the dead forward-return settle loop. Forensics (2026-10-25):
//   · VolCauseEvent.fwd2h/6h: settlePendingVolCauses() (lib/volCause.ts) had
//     exactly ONE caller — GET /api/vol-cause — which is only fetched by the
//     dashboard VolCauseCard. When AiCoreSection swapped the sensor cards for
//     the (unconditional) SensorBusDormantStrip (~09-19), the polls stopped and
//     the loop died: 0 settled rows in the 10/10→now window.
//   · FuturesSnapshot.fwd15m/1h/4h: settleFuturesForwards() (futures-taxonomy)
//     settles from SIBLING snapshot rows only, ordered oldest-first with no
//     fallback price rung — the sparse-era head rows can never resolve, so the
//     300-row batch permanently clogs (head-of-line blocking) and nothing
//     newer ever settles.
// This module provides:
//   1. settlePendingFuturesSnapshots() — a resilient cadence settle for
//      FuturesSnapshot (batch 200, ts < now−4h, 120s throttle, per-row
//      try/catch, sibling → PricePoint → kline-ladder rungs, skip-floor guard
//      so a permanently unfetchable head can never clog the queue).
//   2. Shared price-resolution kit (KlineCache + resolveHorizonPrice) reused
//      by scripts/backfill-fwd-settle.ts for the one-off VolCauseEvent +
//      FuturesSnapshot backlog settle.
// Kline sources (honest ladder, graceful failure): fapi (same weight-gate the
// engine uses, ban-aware, never throws) → SPOT-MIRROR (api.binance.com /
// data-api.binance.vision — separate ban pool) → BYBIT v5 linear. If all
// egress rungs fail the row simply stays pending and the failure is counted.

import { db } from "@/lib/db";
import { fetchFuturesKlines, type Candle } from "@/lib/market-feed";
import { gateFetch } from "@/lib/fapi-gate";

// ── horizon geometry (ms) + settle tolerance windows (mirrors the windows
// futures-taxonomy's sibling settle already uses, so the two writers agree) ──
export const FWD_HORIZONS = { m15: 15 * 60_000, h1: 3_600_000, h4: 4 * 3_600_000 } as const;
export type FwdHorizon = keyof typeof FWD_HORIZONS;
// [minAhead, maxAhead] window for tick-based rungs (sibling snapshot / PricePoint)
export const HORIZON_WINDOW: Record<FwdHorizon, [number, number]> = {
  m15: [10 * 60_000, 25 * 60_000],
  h1: [55 * 60_000, 85 * 60_000],
  h4: [225 * 60_000, 300 * 60_000],
};

const INTERVAL_MS: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 4 * 3_600_000 };

const SPOT_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];
const BYBIT_URL = "https://api.bybit.com";
const EGRESS_TIMEOUT_MS = 15_000;
const PAGE_MAX = 1000; // spot/bybit page cap (fapi caps at 1500, we stay at 1000)
const PAGES_PER_ENSURE = 6; // bounded paging per ensure() call

function bybitInterval(interval: string): string | null {
  switch (interval) {
    case "15m": return "15";
    case "1h": return "60";
    case "4h": return "240";
    default: return null;
  }
}

async function jget<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(EGRESS_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function mapBinanceRaw(raw: (string | number)[][]): Candle[] {
  return raw.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

export function pct3(base: number, later: number): number {
  return Number((((later - base) / base) * 100).toFixed(3));
}

// ── kline ladder — ranged fetch, graceful failure, source-tagged ────────────
export async function fetchRangedKlines(
  symbol: string,
  interval: string,
  startMs: number,
  endMs: number,
): Promise<{ candles: Candle[]; source: string } | null> {
  // rung 1 — fapi via the process-wide weight gate (ban-aware, returns null instead of throwing)
  const fapi = await gateFetch<(string | number)[][]>(
    `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=${PAGE_MAX}`,
    { priority: "telemetry" },
  ).catch(() => null);
  if (fapi && fapi.length > 0) return { candles: mapBinanceRaw(fapi), source: "FAPI" };
  // rung 2 — SPOT-MIRROR (separate rate/ban pool from fapi)
  for (const host of SPOT_HOSTS) {
    const spot = await jget<(string | number)[][]>(
      `${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=${PAGE_MAX}`,
    );
    if (spot && spot.length > 0) return { candles: mapBinanceRaw(spot), source: "SPOT-MIRROR" };
  }
  // rung 3 — BYBIT v5 linear perp (list is newest-first → reverse to ASC)
  const bi = bybitInterval(interval);
  if (bi) {
    const j = await jget<{ result?: { list?: string[][] } }>(
      `${BYBIT_URL}/v5/market/kline?category=linear&symbol=${symbol}&interval=${bi}&start=${startMs}&end=${endMs}&limit=${PAGE_MAX}`,
    );
    const list = j?.result?.list;
    if (list && list.length > 0) {
      const candles: Candle[] = [...list]
        .map((k) => ({ openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }))
        .sort((a, b) => a.openTime - b.openTime);
      return { candles, source: "BYBIT" };
    }
  }
  return null;
}

// ── paged ranged cache — one object per settle run / backfill pass ──────────
// Ensures [start,end] coverage per (symbol,interval) by paging forward from the
// requested start; reused candles make backfills a handful of egress calls per
// symbol instead of one per row.
export class KlineCache {
  private spans = new Map<string, { from: number; to: number; candles: Candle[]; source: string }>();
  egressCalls = 0;
  sources = new Map<string, number>();

  private note(source: string) {
    this.sources.set(source, (this.sources.get(source) ?? 0) + 1);
  }

  async ensure(symbol: string, interval: string, startMs: number, endMs: number): Promise<void> {
    const key = `${symbol}|${interval}`;
    const span = this.spans.get(key);
    if (span && span.from <= startMs && span.to >= endMs) return; // already covered
    const wantFrom = span ? Math.max(span.to, startMs) : startMs; // extend forward only
    let cursor = wantFrom;
    let acc: Candle[] = span ? span.candles : [];
    let source = span?.source ?? "NONE";
    for (let p = 0; p < PAGES_PER_ENSURE && cursor < endMs; p++) {
      const page = await fetchRangedKlines(symbol, interval, cursor, endMs);
      this.egressCalls++;
      if (!page || page.candles.length === 0) break; // graceful — keep what we have
      source = page.source;
      acc = acc.concat(page.candles);
      const lastOpen = page.candles[page.candles.length - 1]!.openTime;
      const step = INTERVAL_MS[interval] ?? 3_600_000;
      if (lastOpen + step <= cursor) break; // no forward progress
      cursor = lastOpen + step;
      if (page.candles.length < PAGE_MAX) break;
    }
    // de-dupe + sort
    const seen = new Set<number>();
    acc = acc.filter((c) => (seen.has(c.openTime) ? false : (seen.add(c.openTime), true))).sort((a, b) => a.openTime - b.openTime);
    this.spans.set(key, { from: span ? Math.min(span.from, startMs) : startMs, to: Math.max(span?.to ?? 0, cursor), candles: acc, source });
  }

  // price AT tMs — same containment convention as volCause.priceAt (open ≤ t < open+period → that candle's close)
  priceAt(symbol: string, interval: string, tMs: number): { price: number; source: string } | null {
    const span = this.spans.get(`${symbol}|${interval}`);
    if (!span) return null;
    const step = INTERVAL_MS[interval] ?? 3_600_000;
    const c = span.candles.find((k) => k.openTime <= tMs && k.openTime + step > tMs);
    return c ? { price: c.close, source: span.source } : null;
  }

  covered(symbol: string, interval: string, tMs: number): boolean {
    const span = this.spans.get(`${symbol}|${interval}`);
    return !!span && span.from <= tMs && tMs <= span.to;
  }
}

// ── sibling rung — same-venue snapshot price (egress-free) ──────────────────
async function siblingPrice(symbol: string, tMs: number, horizon: FwdHorizon): Promise<number | null> {
  const [minAhead, maxAhead] = HORIZON_WINDOW[horizon];
  const row = await db.futuresSnapshot.findFirst({
    where: { symbol, ts: { gte: new Date(tMs + minAhead), lte: new Date(tMs + maxAhead) } },
    orderBy: { ts: "asc" },
    select: { price: true },
  });
  return row ? row.price : null;
}

// ── PricePoint rung — the app's own WS price archive (price-ws :3003) ───────
async function pricePointAt(symbol: string, tMs: number, horizon: FwdHorizon): Promise<number | null> {
  const [minAhead, maxAhead] = HORIZON_WINDOW[horizon];
  const row = await db.pricePoint.findFirst({
    where: { symbol, createdAt: { gte: new Date(tMs + minAhead), lte: new Date(tMs + maxAhead) } },
    orderBy: { createdAt: "asc" },
    select: { price: true },
  });
  return row ? row.price : null;
}

export interface HorizonResolution {
  pct: number | null;
  source: string; // SIBLING | PRICEPOINT | FAPI | SPOT-MIRROR | BYBIT | NONE
}

// Resolve ONE horizon: sibling snapshot → PricePoint → kline ladder.
export async function resolveHorizonPrice(
  basePrice: number,
  symbol: string,
  tMs: number,
  horizon: FwdHorizon,
  opts: { useSibling?: boolean; usePricePoint?: boolean; kit?: KlineCache } = {},
): Promise<HorizonResolution> {
  const out = (price: number | null, source: string): HorizonResolution =>
    price !== null && basePrice > 0 ? { pct: pct3(basePrice, price), source } : { pct: null, source: "NONE" };
  try {
    if (opts.useSibling) {
      const p = await siblingPrice(symbol, tMs, horizon).catch(() => null);
      if (p !== null) return out(p, "SIBLING");
    }
    if (opts.usePricePoint) {
      const p = await pricePointAt(symbol, tMs, horizon).catch(() => null);
      if (p !== null) return out(p, "PRICEPOINT");
    }
    const kit = opts.kit;
    if (kit) {
      // 1h candles for EVERY horizon — a 1h candle containing t+h closes within
      // (h, h+1h]; 4h candles would smear the 4h horizon by up to 4h.
      const interval = "1h";
      await kit.ensure(symbol, interval, tMs, tMs + FWD_HORIZONS[horizon] + INTERVAL_MS[interval]!);
      const hit = kit.priceAt(symbol, interval, tMs + FWD_HORIZONS[horizon]);
      if (hit) return out(hit.price, hit.source);
      return { pct: null, source: "NONE" };
    }
    // no cache provided (one-off callers) — reuse volCause's exact fetch helper
    const recent = await klinePriceRecent(symbol, tMs + FWD_HORIZONS[horizon], FWD_HORIZONS[horizon]);
    if (recent) return out(recent.price, recent.source);
    return { pct: null, source: "NONE" };
  } catch {
    return { pct: null, source: "NONE" };
  }
}

// ── cadence settle for FuturesSnapshot (P0-b) ───────────────────────────────
const SETTLE_THROTTLE_MS = 120_000;
const BATCH = 200;
let lastSettleAt = 0;
let settleRunning = false;
// Skip-floor guard: if an entire batch resolves nothing (all egress rungs down
// for those symbols), advance the floor past the batch so the queue can never
// head-of-line block again (the exact failure mode that killed
// settleFuturesForwards). Rows below the floor stay honestly unsettled.
let skipFloorTs = 0;

export interface FuturesSettleResult {
  settled: number;
  failed: number;
  scanned: number;
  sources: Record<string, number>;
  floorAdvanced: boolean;
}

export async function settlePendingFuturesSnapshots(): Promise<FuturesSettleResult> {
  const empty: FuturesSettleResult = { settled: 0, failed: 0, scanned: 0, sources: {}, floorAdvanced: false };
  if (settleRunning || Date.now() - lastSettleAt < SETTLE_THROTTLE_MS) return empty;
  settleRunning = true;
  lastSettleAt = Date.now();
  try {
    const now = Date.now();
    const where: Record<string, unknown> = {
      ts: { lt: new Date(now - 4 * 3_600_000), gt: new Date(skipFloorTs) },
      OR: [{ fwd15mPct: null }, { fwd1hPct: null }, { fwd4hPct: null }],
    };
    const pending = await db.futuresSnapshot.findMany({ where, orderBy: { ts: "asc" }, take: BATCH });
    if (pending.length === 0) return empty;
    const kit = new KlineCache();
    const sources: Record<string, number> = {};
    let settled = 0;
    let failed = 0;
    let maxTs = 0;
    for (const row of pending) {
      maxTs = Math.max(maxTs, row.ts.getTime());
      try {
        const data: { fwd15mPct?: number; fwd1hPct?: number; fwd4hPct?: number } = {};
        const want: FwdHorizon[] = [];
        if (row.fwd15mPct === null) want.push("m15");
        if (row.fwd1hPct === null) want.push("h1");
        if (row.fwd4hPct === null) want.push("h4");
        for (const h of want) {
          const r = await resolveHorizonPrice(row.price, row.symbol, row.ts.getTime(), h, {
            useSibling: true, usePricePoint: true, kit,
          });
          if (r.pct !== null) {
            sources[r.source] = (sources[r.source] ?? 0) + 1;
            if (h === "m15") data.fwd15mPct = r.pct;
            else if (h === "h1") data.fwd1hPct = r.pct;
            else data.fwd4hPct = r.pct;
          }
        }
        if (Object.keys(data).length > 0) {
          await db.futuresSnapshot.update({ where: { id: row.id }, data });
          settled++;
        } else {
          failed++;
        }
      } catch {
        failed++; // one bad row must never kill the batch
      }
    }
    let floorAdvanced = false;
    if (settled === 0 && failed > 0 && maxTs > 0) {
      skipFloorTs = maxTs; // unblock the queue — honest: those rows stay unsettled
      floorAdvanced = true;
    }
    return { settled, failed, scanned: pending.length, sources, floorAdvanced };
  } catch {
    return empty;
  } finally {
    settleRunning = false;
  }
}

// ── recent-window helper for fresh rows (reuses volCause's exact fetch) ─────
// Rows younger than the kline cache window settle directly off
// fetchFuturesKlines — the SAME helper lib/volCause.ts uses — so the cadence
// path stays byte-compatible with the historical settle convention.
export async function klinePriceRecent(symbol: string, tMs: number, spanMs: number): Promise<{ price: number; source: string } | null> {
  const limit = Math.min(200, Math.max(2, Math.ceil(spanMs / 3_600_000) + 2));
  try {
    const candles = await fetchFuturesKlines(symbol, "1h", limit);
    const c = candles.find((k) => k.openTime <= tMs && k.openTime + 3_600_000 > tMs);
    return c ? { price: c.close, source: "FAPI-LADDER" } : null;
  } catch {
    return null;
  }
}
