// ── v10.22 FUTURES TAXONOMY ENGINE (server-only) ────────────────────────────
// Operator mandate: «هدف از این کار جمع‌آوری داده و اطلاعات است تا با ذخیره و
// یادگیری بهترین فیلتر رو شناسایی کنیم» — the de-restriction of v10.22 exists
// to generate unbiased samples; this module is the instrument that harvests,
// STORES and LEARNS from them across the five futures-signal families:
//
//   A  Positioning      funding rate + crowd/top L/S ratios
//   B  Aggressor flow   real-tape CVD (trade-service :3011)
//   C  Forced flow      liquidations (liq-service :3010)
//   D  Structure        OI × Price four-quadrant (the operator's framework)
//   E  Cross-plane     funding/OI divergence across Binance planes (v14.0)
//
// Design doctrine:
//  · Boards get overwritten — learning needs HISTORY, so every sample is a
//    persisted FuturesSnapshot row (Prisma time-series, 30d + 100k cap).
//  · BACKFILL (one-shot, 1h grid ~14d) gives the quadrant study immediate
//    depth; stream-only families (CVD/liq/cross-exchange) stay honestly NULL
//    there. LIVE rows sample every ~5min with the full five-family read.
//  · Forward returns (15m/1h/4h, unlevered) settle lazily from the series
//    itself — no extra REST cost.
//  · The learner joins settled rows + the settled SIGNAL book into ranked
//    filter candidates; `bestFilter` is only claimed with n ≥ 20 and
//    median/mean sign agreement — otherwise it stays "COLLECTING" (honest).
//  · Nothing here touches the deploy path. Telemetry + learning only.

import { db } from "@/lib/db";
import { fapiBanRemainingMs, gateFetch } from "./fapi-gate";
import { getTape, getTapeHealth, syncTapeWatchlist } from "./trade-flow";
import { getLiquidationSnapshot, getLiquidationStatus } from "./liquidations";
import { spotLadderJson } from "./spot-host-gate";

export const FUTURES_ANCHORS = ["BTCUSDT", "ETHUSDT"] as const;

const SAMPLE_INTERVAL_MS = 5 * 60_000;
const SETTLE_INTERVAL_MS = 6 * 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const RETENTION_DAYS = 30;
const HARD_CAP = 100_000;
const EDGE_CACHE_TTL = 10 * 60_000;
const BACKFILL_HOURS = 336; // 14 days of 1h grid
const ATTRIBUTION_FENCE_MS = 10 * 60_000; // signal ↔ snapshot join fence
const SETTLED_TARGET = 720; // maturity bar for bestFilter claims

export type QuadrantId = "Q1_FRESH_LONG" | "Q2_SQUEEZE" | "Q3_FRESH_SHORT" | "Q4_CAPITULATION";

export const QUADRANT_META: Record<QuadrantId, { label: string; price: "UP" | "DOWN"; oi: "UP" | "DOWN"; meaning: string; signal: string }> = {
  Q1_FRESH_LONG: { label: "FRESH LONG", price: "UP", oi: "UP", meaning: "new long money — healthy uptrend", signal: "continuation" },
  Q2_SQUEEZE: { label: "SHORT SQUEEZE", price: "UP", oi: "DOWN", meaning: "shorts covering — no fresh money", signal: "fade the rally" },
  Q3_FRESH_SHORT: { label: "FRESH SHORT", price: "DOWN", oi: "UP", meaning: "new short money — healthy downtrend", signal: "continuation" },
  Q4_CAPITULATION: { label: "CAPITULATION", price: "DOWN", oi: "DOWN", meaning: "longs forced out — possible bottom", signal: "get ready" },
};

export function classifyQuadrant(priceDelta: number | null, oiDelta: number | null): QuadrantId | null {
  if (priceDelta === null || oiDelta === null || !Number.isFinite(priceDelta) || !Number.isFinite(oiDelta)) return null;
  const pUp = priceDelta >= 0;
  const oiUp = oiDelta >= 0;
  if (pUp && oiUp) return "Q1_FRESH_LONG";
  if (pUp && !oiUp) return "Q2_SQUEEZE";
  if (!pUp && oiUp) return "Q3_FRESH_SHORT";
  return "Q4_CAPITULATION";
}

// ── low-level fetchers (honest nulls — never invent) ───────────────────────────

// v10.24 Task 34-a IP-BAN AWARENESS MOVED TO THE CENTER: the old module-level
// binanceBlockUntil/noteBinanceStatus backoff is REPLACED by the process-wide
// fapi-gate (weight budget + global 418/429 "banned until" parsing + zero-
// network ban windows). binanceBackoffRemainingMs stays as a working export
// for existing callers — it now delegates to the gate's ban clock so ALL
// modules share ONE truth about the IP-ban state.
export function binanceBackoffRemainingMs(): number {
  return fapiBanRemainingMs();
}

async function fapi<T>(path: string, timeoutMs = 6500): Promise<T | null> {
  return gateFetch<T>(path, { priority: "telemetry", timeoutMs });
}

async function jsonUrl<T>(url: string, timeoutMs = 6500): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Task 34-4 SPOT-MIRROR FALLBACKS (2026-09-26) ───────────────────────────
// The fapi (USDT-M) REST pool carries stacked multi-hour 418 bans while the
// SPOT api (api.binance.com) is a SEPARATE host with its own rate budget and
// kept answering 200 throughout the ban storm (measured). During fapi ban
// windows the sampler now mirrors PRICE and KLINE closes from the spot API so
// quadrant rows keep flowing; futures-only families (OI, funding, LS ratios)
// stay honestly NULL — no invented data. Spot klines share the candle shape.
// v13.2 SPOT-HOST LADDER (operator mandate trace 1a1704d407f00dad): the Binance
// public data mirror (data-api.binance.vision) is the PRIMARY spot host —
// measured 32/32 HTTP 200 p50 57ms on 2026-10-25 while api.binance.com rides
// 418 ban-storms from this shared egress. api.binance.com stays as fallback.
// v13.2.3 (trace 1a170bba02dff781): api1-4 added (200 @356-408ms probed 2026-10-25).
const SPOT_HOSTS = ["https://data-api.binance.vision", "https://api-gcp.binance.com", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com", "https://api.binance.com"]; // v13.3 ladder + api-gcp (restored 1a1849f647778885)
// v13.2.1 — per-host 418/429 backoff via the shared spot-host gate.
async function spotPrice(symbol: string): Promise<number | null> {
  const j = await spotLadderJson<{ price?: string }>(`/api/v3/ticker/price?symbol=${symbol}`, SPOT_HOSTS);
  const p = j?.price ? Number(j.price) : NaN;
  return Number.isFinite(p) && p > 0 ? p : null;
}
async function spotKlines(symbol: string, interval: string, limit: number): Promise<Array<[number, string, string, string, string]> | null> {
  return spotLadderJson<Array<[number, string, string, string, string]>>(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, SPOT_HOSTS);
}

interface PremIndex { markPrice: string; lastFundingRate: string; nextFundingTime: number }
interface OiHistRow { sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }
interface LsRow { longShortRatio: string; timestamp: number }

// v14.0 BINANCE-ONLY CROSS-CHECK (replaces the retired cross-exchange leg) —
// settled funding (history endpoint) and the CURRENT OI (per-symbol endpoint)
// are measured against the primary premiumIndex / openInterestHist lanes:
// real Binance cross-plane divergence, zero foreign venues.
async function crossCheck(symbol: string): Promise<{ fundingSettled: number | null; oiChk: number | null }> {
  const [settledRows, oiCur] = await Promise.all([
    fapi<Array<{ fundingRate: string }>>(`/fapi/v1/fundingRate?symbol=${symbol}&limit=1`),
    fapi<{ openInterest: string }>(`/fapi/v1/openInterest?symbol=${symbol}`),
  ]);
  const s = Number(settledRows?.[0]?.fundingRate);
  const o = Number(oiCur?.openInterest);
  return {
    fundingSettled: Number.isFinite(s) && settledRows ? s * 100 : null,
    oiChk: Number.isFinite(o) && o > 0 ? o : null,
  };
}


// ── sampler ────────────────────────────────────────────────────────────────

export interface FuturesSampleOutcome { symbols: string[]; skipped: boolean }

let sampleInFlight = false;
let lastSampleAt = 0;

function pct(cur: number, ref: number): number | null {
  return ref > 0 ? Number((((cur - ref) / ref) * 100).toFixed(4)) : null;
}

/** One five-family sample across the anchors. Rides the engine tick (~5min). */
export async function maybeFuturesSample(force = false): Promise<FuturesSampleOutcome> {
  if (sampleInFlight) return { symbols: [], skipped: true };
  if (!force && Date.now() - lastSampleAt < SAMPLE_INTERVAL_MS) return { symbols: [], skipped: true };
  sampleInFlight = true;
  lastSampleAt = Date.now();
  try {
    await ensureBackfill(); // one-shot guarded — no-op after the first pass
    void syncTapeWatchlist([...FUTURES_ANCHORS]).catch(() => undefined);

    const now = Date.now();
    const ts = new Date(Math.floor(now / 60_000) * 60_000); // minute grid — dedupe-safe
    const written: string[] = [];

    for (const symbol of FUTURES_ANCHORS) {
      try {
        const [oiHistArr, prem, crowdArr, topArr, k5, prevRow, tape, liqSnap, cross] = await Promise.all([
          fapi<OiHistRow[]>(`/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=13`),
          fapi<PremIndex>(`/fapi/v1/premiumIndex?symbol=${symbol}`),
          fapi<LsRow[]>(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=2`),
          fapi<LsRow[]>(`/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=5m&limit=2`),
          fapi<Array<[number, string, string, string, string]>>(`/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=4`),
          db.futuresSnapshot.findFirst({
            where: { symbol, ts: { gte: new Date(now - 72 * 60_000), lte: new Date(now - 48 * 60_000) } },
            orderBy: { ts: "desc" },
          }),
          getTape(symbol),
          getLiquidationSnapshot(),
          crossCheck(symbol),
        ]);

        // Task 34-4/35 — price fallback tiers (v14.0 Binance-only): fapi
        // markPrice → binance spot mirror. A fapi ban window no longer zeroes
        // the whole sample; the row keeps flowing with futures-only families
        // honestly null.
        let price = prem ? Number(prem.markPrice) || null : null;
        if (price === null) price = await spotPrice(symbol);
        if (price === null) continue; // honest — no price from ANY host, no row

        const oi = oiHistArr && oiHistArr.length >= 2 ? oiHistArr.map((h) => Number(h.sumOpenInterest)) : null;
        const oiBase = oi ? oi[oi.length - 1]! : null;
        const oiUsdRaw = oiHistArr && oiHistArr.length ? Number(oiHistArr[oiHistArr.length - 1]!.sumOpenInterestValue) : null;
        const oiDelta15m = oi && oi.length > 3 ? pct(oi[oi.length - 1]!, oi[oi.length - 4]!) : null;
        const oiDelta1h = oi && oi.length > 12 ? pct(oi[oi.length - 1]!, oi[oi.length - 13]!) : null;

        // price deltas: 15m from the 5m kline mini-series, 1h from our OWN row
        // (self-consistent with the stored series) — klines fallback below.
        let closes = k5 ? k5.map((k) => Number(k[4])) : [];
        if (closes.length < 4) {
          const k5s = await spotKlines(symbol, "5m", 4);
          closes = k5s ? k5s.map((k) => Number(k[4])) : [];
        }
        const priceDelta15m = closes.length >= 4 ? pct(closes[closes.length - 1]!, closes[0]!) : null;
        let priceDelta1h: number | null = prevRow ? pct(price, prevRow.price) : null;
        if (priceDelta1h === null) {
          let k1 = await fapi<Array<[number, string, string, string, string]>>(`/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=3`);
          if (!k1) k1 = await spotKlines(symbol, "1h", 3);
          const c1 = k1 ? k1.map((k) => Number(k[4])) : [];
          if (c1.length >= 3) priceDelta1h = pct(c1[c1.length - 1]!, c1[0]!);
        }

        const liqRow = liqSnap?.bySymbol?.[symbol] ?? null;

        const data = {
          symbol,
          ts,
          source: "LIVE",
          price,
          oiBase,
          oiUsdM: oiUsdRaw ? Number((oiUsdRaw / 1e6).toFixed(2)) : null,
          priceDelta15m,
          priceDelta1h,
          oiDelta15m,
          oiDelta1h,
          quadrant15m: classifyQuadrant(priceDelta15m, oiDelta15m),
          quadrant1h: classifyQuadrant(priceDelta1h, oiDelta1h),
          funding8h: prem ? Number((Number(prem.lastFundingRate) * 100).toFixed(4)) : null,
          crowdLS: crowdArr && crowdArr.length ? Number(crowdArr[crowdArr.length - 1]!.longShortRatio) : null,
          topLS: topArr && topArr.length ? Number(topArr[topArr.length - 1]!.longShortRatio) : null,
          takerLS: null,
          cvd15mPct: tape ? Number(tape.cvd15mPct.toFixed(2)) : null,
          cvd1hPct: tape ? Number(tape.cvd1hPct.toFixed(2)) : null,
          vol15mUsd: tape ? Math.round(tape.vol15mUsd) : null,
          liqLong10mUsd: liqRow ? Math.round(liqRow.longsUsd10m) : null,
          liqShort10mUsd: liqRow ? Math.round(liqRow.shortsUsd10m) : null,
          liqUsd1h: liqRow ? Math.round(liqRow.usd1h) : null,
          fundingSettled: cross.fundingSettled,
          oiChk: cross.oiChk,
        };

        await db.futuresSnapshot.upsert({
          where: { symbol_ts_source: { symbol, ts, source: "LIVE" } },
          create: data,
          update: data,
        });
        written.push(symbol);
      } catch (e) {
        console.error(`[futures] sample ${symbol} failed`, e);
      }
    }
    return { symbols: written, skipped: false };
  } finally {
    sampleInFlight = false;
  }
}

// ── one-shot 1h BACKFILL (~14d) — instant quadrant-study depth ─────────────

interface BackfillState { at: string; symbols: string[]; rows: number }

async function readBackfillState(): Promise<BackfillState | null> {
  const row = await db.engineSetting.findUnique({ where: { key: "futures.backfillState" } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as BackfillState;
  } catch {
    return null;
  }
}

let backfillInFlight = false;
let lastBackfillAttemptAt = 0;
const BACKFILL_RETRY_MS = 10 * 60_000; // ban-aware self-heal cadence

/** Fetch the 1h OI/price/L-S/funding grid and store ~14d of honestly-limited rows.
    Resume-safe: the persisted state lists COMPLETED symbols; a symbol that
    failed (ban, empty payload) is retried by later sampler ticks until it lands. */
export async function ensureBackfill(force = false): Promise<BackfillState | null> {
  if (backfillInFlight) return null;
  const existing = await readBackfillState();
  const done = new Set(existing?.symbols ?? []);
  const pending = FUTURES_ANCHORS.filter((s) => !done.has(s));
  if (existing && pending.length === 0 && !force) return existing;
  if (!force && Date.now() - lastBackfillAttemptAt < BACKFILL_RETRY_MS) return null;
  if (fapiBanRemainingMs() > 0) return null; // never hammer a live IP ban (gate-shared ban clock)
  lastBackfillAttemptAt = Date.now();
  backfillInFlight = true;
  try {
    const written: string[] = [...done];
    let total = 0;
    let first = true;
    for (const symbol of pending) {
      if (!first) await new Promise((r) => setTimeout(r, 12_000)); // spread the burst — back-to-back symbol fetches are exactly how bans happen
      first = false;
      try {
        const n = await backfillSymbol(symbol);
        if (n > 0) {
          written.push(symbol);
          total += n;
        }
      } catch (e) {
        console.error(`[futures] backfill ${symbol} failed`, e);
      }
    }
    if (total === 0 && written.length === 0) return null; // resumable — a later sampler tick retries
    const state: BackfillState = { at: new Date().toISOString(), symbols: written, rows: (existing?.rows ?? 0) + total };
    await db.engineSetting.upsert({
      where: { key: "futures.backfillState" },
      create: { key: "futures.backfillState", value: JSON.stringify(state) },
      update: { value: JSON.stringify(state) },
    });
    return state;
  } finally {
    backfillInFlight = false;
  }
}

async function backfillSymbol(symbol: string): Promise<number> {
  const [oiHist, klinesRaw, crowd, top, funding] = await Promise.all([
    fapi<OiHistRow[]>(`/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=${BACKFILL_HOURS}`),
    fapi<Array<[number, string, string, string, string]>>(`/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${BACKFILL_HOURS + 1}`),
    fapi<LsRow[]>(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=${BACKFILL_HOURS}`),
    fapi<LsRow[]>(`/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=${BACKFILL_HOURS}`),
    fapi<Array<{ fundingRate: string; fundingTime: number }>>(`/fapi/v1/fundingRate?symbol=${symbol}&limit=60`),
  ]);
  // map raw kline rows here — market-feed's fetcher throws on a ban, this
  // module fails soft instead
  const klines = (klinesRaw ?? []).map((k) => ({ openTime: Number(k[0]), close: Number(k[4]) }));
  if (!oiHist || oiHist.length < 5 || klines.length < 5) return 0;

  // grid points: use OI-hist timestamps (1h close times); kline close matches
  // the same hour (openTime + 1h). Tolerance 5min.
  const closeAt = (openTime: number): number => openTime + 3_600_000;
  const nearest = <T extends { ts: number }>(arr: T[], ts: number, tolMs: number): T | null => {
    let best: T | null = null;
    let bestD = Infinity;
    for (const r of arr) {
      const d = Math.abs(r.ts - ts);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return bestD <= tolMs ? best : null;
  };

  const points = oiHist
    .map((h) => {
      const ts = Number(h.timestamp);
      const k = nearest(klines.map((c) => ({ ts: closeAt(c.openTime), close: c.close })), ts, 5 * 60_000);
      if (!k) return null;
      const c = nearest(crowd?.map((r) => ({ ts: Number(r.timestamp), v: Number(r.longShortRatio) })) ?? [], ts, 5 * 60_000);
      const t = nearest(top?.map((r) => ({ ts: Number(r.timestamp), v: Number(r.longShortRatio) })) ?? [], ts, 5 * 60_000);
      return { ts, price: k.close, oiBase: Number(h.sumOpenInterest), oiUsdM: Number(h.sumOpenInterestValue) / 1e6, crowdLS: c?.v ?? null, topLS: t?.v ?? null };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => a.ts - b.ts);
  if (points.length < 5) return 0;

  // funding in effect at ts = latest fundingTime ≤ ts (funding history is ascending)
  const fundingAsc = (funding ?? []).map((f) => ({ ts: Number(f.fundingTime), rate: Number(f.fundingRate) * 100 })).sort((a, b) => a.ts - b.ts);

  const rows = points.map((p, i) => {
    const prev = i > 0 ? points[i - 1]! : null;
    const priceDelta1h = prev ? pct(p.price, prev.price) : null;
    const oiDelta1h = prev ? pct(p.oiBase, prev.oiBase) : null;
    const fund = fundingAsc.length ? [...fundingAsc].reverse().find((f) => f.ts <= p.ts) ?? null : null;
    return {
      symbol,
      ts: new Date(p.ts),
      source: "BACKFILL",
      price: p.price,
      oiBase: p.oiBase,
      oiUsdM: Number(p.oiUsdM.toFixed(2)),
      priceDelta15m: null,
      priceDelta1h,
      oiDelta15m: null,
      oiDelta1h,
      quadrant15m: null,
      quadrant1h: classifyQuadrant(priceDelta1h, oiDelta1h),
      funding8h: fund ? Number(fund.rate.toFixed(4)) : null,
      crowdLS: p.crowdLS,
      topLS: p.topLS,
      takerLS: null,
      cvd15mPct: null,
      cvd1hPct: null,
      vol15mUsd: null,
      liqLong10mUsd: null,
      liqShort10mUsd: null,
      liqUsd1h: null,
      fundingSettled: null,
      oiChk: null,
      fwd15mPct: null,
      // inline settlement from the series itself
      fwd1hPct: (() => {
        const nxt = points.find((q) => q.ts >= p.ts + 55 * 60_000 && q.ts <= p.ts + 70 * 60_000);
        return nxt ? pct(nxt.price, p.price) : null;
      })(),
      fwd4hPct: (() => {
        const nxt = points.find((q) => q.ts >= p.ts + 225 * 60_000 && q.ts <= p.ts + 255 * 60_000);
        return nxt ? pct(nxt.price, p.price) : null;
      })(),
    };
  });

  // createMany — a LIVE sample landing on the same hour grid keeps its own
  // row (source differs in the unique key), so no overwrite of either side.
  const res = await db.futuresSnapshot.createMany({ data: rows });
  return res.count;
}

// ── forward-return settlement + retention ──────────────────────────────────

let settleInFlight = false;
let lastSettleAt = 0;
let lastPruneAt = 0;

export async function settleFuturesForwards(force = false): Promise<{ settled: number; pruned: number }> {
  if (settleInFlight) return { settled: 0, pruned: 0 };
  if (!force && Date.now() - lastSettleAt < SETTLE_INTERVAL_MS) return { settled: 0, pruned: 0 };
  settleInFlight = true;
  lastSettleAt = Date.now();
  try {
    const now = Date.now();
    let settled = 0;
    // LIVE rows older than 4h may need all three horizons; rows 15m-4h old
    // only the early ones. One query per pass, bounded 300 oldest.
    const pending = await db.futuresSnapshot.findMany({
      where: { source: "LIVE", ts: { lte: new Date(now - 15 * 60_000) }, OR: [{ fwd15mPct: null }, { fwd1hPct: null }, { fwd4hPct: null }] },
      orderBy: { ts: "asc" },
      take: 300,
    });
    for (const row of pending) {
      const ts = row.ts.getTime();
      const data: { fwd15mPct?: number; fwd1hPct?: number; fwd4hPct?: number } = {};
      if (row.fwd15mPct === null) {
        const nxt = await nearestLaterPrice(row.symbol, ts, 10 * 60_000, 25 * 60_000);
        if (nxt !== null && row.price > 0) data.fwd15mPct = ((nxt - row.price) / row.price) * 100;
      }
      if (row.fwd1hPct === null) {
        const nxt = await nearestLaterPrice(row.symbol, ts, 55 * 60_000, 85 * 60_000);
        if (nxt !== null && row.price > 0) data.fwd1hPct = ((nxt - row.price) / row.price) * 100;
      }
      if (row.fwd4hPct === null && ts < now - 4 * 3_600_000 - 30 * 60_000) {
        const nxt = await nearestLaterPrice(row.symbol, ts, 225 * 60_000, 300 * 60_000);
        if (nxt !== null && row.price > 0) data.fwd4hPct = ((nxt - row.price) / row.price) * 100;
      }
      if (Object.keys(data).length) {
        await db.futuresSnapshot.update({ where: { id: row.id }, data });
        settled++;
      }
    }

    // retention: 30d age rule + hard cap (both cheap, hourly at most)
    let pruned = 0;
    if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
      lastPruneAt = Date.now();
      const old = await db.futuresSnapshot.deleteMany({ where: { ts: { lt: new Date(Date.now() - RETENTION_DAYS * 86_400_000) } } });
      pruned += old.count;
      const total = await db.futuresSnapshot.count();
      if (total > HARD_CAP) {
        const excess = await db.futuresSnapshot.findMany({ orderBy: { ts: "asc" }, take: total - HARD_CAP, select: { id: true } });
        const del = await db.futuresSnapshot.deleteMany({ where: { id: { in: excess.map((r) => r.id) } } });
        pruned += del.count;
      }
    }
    return { settled, pruned };
  } finally {
    settleInFlight = false;
  }
}

async function nearestLaterPrice(symbol: string, ts: number, minAheadMs: number, maxAheadMs: number): Promise<number | null> {
  const row = await db.futuresSnapshot.findFirst({
    where: { symbol, ts: { gte: new Date(ts + minAheadMs), lte: new Date(ts + maxAheadMs) } },
    orderBy: { ts: "asc" },
    select: { price: true },
  });
  return row ? row.price : null;
}

// ── LEARNING LAYER — the best-filter identification ────────────────────────

interface StudyRow {
  ts: number;
  price: number;
  quadrant1h: string | null;
  fwd1hPct: number | null;
  fwd4hPct: number | null;
  funding8h: number | null;
  crowdLS: number | null;
  topLS: number | null;
  cvd15mPct: number | null;
  liqLong10mUsd: number | null;
  liqShort10mUsd: number | null;
  fundingSettled: number | null;
  oiBase: number | null;
  oiChk: number | null;
}

export interface EdgeCandidate {
  filter: string;
  family: "A" | "B" | "C" | "D" | "E";
  rule: string;
  n: number;
  meanFwd1h: number;
  medianFwd1h: number;
  winPct: number;
  baselineMean: number;
  edge: number;
  thresholdNote: string;
  confidence: "LOW" | "MEDIUM" | "HIGH" | "COLLECTING";
}

export interface AttributionCell {
  direction: string;
  quadrant: string;
  n: number;
  avgPnl: number;
  medianPnl: number;
  winPct: number;
}

export interface FuturesEdge {
  builtAt: string;
  rowsScanned: number;
  settledRows: number;
  baselineMeanFwd1h: number;
  quadrantStudy: Array<{ quadrant: QuadrantId; label: string; n: number; meanFwd1h: number; medianFwd1h: number; winPct: number; meanFwd4h: number | null; verdict: "CONTINUES" | "FADES" | "n/a" }>;
  familyStudy: EdgeCandidate[];
  attribution: { cells: AttributionCell[]; joined: number; note: string };
  bestFilter: { filter: string; family: string; rule: string; edge: number; n: number; confidence: string; source: "MARKET-EDGE" | "BOOK-EDGE" } | null;
  maturity: { settled: number; target: number; progressPct: number };
}

let edgeCache: { at: number; value: FuturesEdge } | null = null;

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Number((s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2).toFixed(3));
}

function pctl(arr: number[], q: number): number | null {
  if (arr.length < 10) return null; // percentile thresholds need a real distribution
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)));
  return s[idx]!;
}

function mean(arr: number[]): number {
  return arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3)) : 0;
}

function confidenceOf(n: number): "LOW" | "MEDIUM" | "HIGH" | "COLLECTING" {
  if (n >= 100) return "HIGH";
  if (n >= 40) return "MEDIUM";
  if (n >= 20) return "LOW";
  return "COLLECTING";
}

/** Ranked filter candidates + bestFilter — the deliverable of store & learn. */
export async function buildFuturesEdge(force = false): Promise<FuturesEdge> {
  if (!force && edgeCache && Date.now() - edgeCache.at < EDGE_CACHE_TTL) return edgeCache.value;

  const rowsRaw = await db.futuresSnapshot.findMany({
    select: {
      ts: true, price: true, quadrant1h: true, fwd1hPct: true, fwd4hPct: true,
      funding8h: true, crowdLS: true, topLS: true, cvd15mPct: true,
      liqLong10mUsd: true, liqShort10mUsd: true,
      fundingSettled: true, oiBase: true, oiChk: true,
    },
    orderBy: { ts: "asc" },
    take: 40_000,
  });
  const rows: StudyRow[] = rowsRaw.map((r) => ({ ...r, ts: r.ts.getTime() }));
  const settled = rows.filter((r) => r.fwd1hPct !== null);
  const baseline = mean(settled.map((r) => r.fwd1hPct!));

  // 1) QUADRANT STUDY — the empirical four-quadrant truth table
  const quadrantStudy: FuturesEdge["quadrantStudy"] = [];
  for (const qid of Object.keys(QUADRANT_META) as QuadrantId[]) {
    const sub = settled.filter((r) => r.quadrant1h === qid);
    if (!sub.length) continue;
    const f1 = sub.map((r) => r.fwd1hPct!);
    const f4arr = sub.map((r) => r.fwd4hPct).filter((v): v is number => v !== null);
    const m = mean(f1);
    const mdn = median(f1);
    quadrantStudy.push({
      quadrant: qid,
      label: QUADRANT_META[qid].label,
      n: sub.length,
      meanFwd1h: m,
      medianFwd1h: mdn,
      winPct: Number(((f1.filter((v) => v > 0).length / f1.length) * 100).toFixed(1)),
      meanFwd4h: f4arr.length >= 10 ? mean(f4arr) : null,
      verdict: m > baseline ? "CONTINUES" : "FADES",
    });
  }

  // 2) FAMILY STUDY — factor extremes vs baseline (data-driven thresholds)
  const fam: EdgeCandidate[] = [];
  const push = (
    filter: string, family: EdgeCandidate["family"], rule: string, subRows: StudyRow[],
    thresholdNote: string,
  ): void => {
    // settle-safe: only rows whose forward return actually settled count
    const sub = subRows.filter((r) => r.fwd1hPct !== null).map((r) => r.fwd1hPct!);
    if (sub.length < 5) return; // below study floor — skip silently, maturity bar reports the rest
    const m = mean(sub);
    fam.push({
      filter, family, rule, n: sub.length,
      meanFwd1h: m, medianFwd1h: median(sub),
      winPct: Number(((sub.filter((v) => v > 0).length / sub.length) * 100).toFixed(1)),
      baselineMean: baseline,
      edge: Number((m - baseline).toFixed(3)),
      thresholdNote,
      confidence: confidenceOf(sub.length),
    });
  };

  const funding = rows.map((r) => r.funding8h).filter((v): v is number => v !== null);
  const fHi = pctl(funding, 0.9);
  const fLo = pctl(funding, 0.1);
  if (fHi !== null) push("FUNDING_HOT", "A", `funding8h ≥ ${fHi.toFixed(4)}% (crowded longs)`, settled.filter((r) => r.funding8h !== null && r.funding8h >= fHi), `p90 of ${funding.length} rows`);
  if (fLo !== null) push("FUNDING_COLD", "A", `funding8h ≤ ${fLo.toFixed(4)}% (crowded shorts)`, settled.filter((r) => r.funding8h !== null && r.funding8h <= fLo), `p10 of ${funding.length} rows`);

  const crowd = rows.map((r) => r.crowdLS).filter((v): v is number => v !== null);
  const cHi = pctl(crowd, 0.9);
  const cLo = pctl(crowd, 0.1);
  if (cHi !== null) push("CROWD_LONG_CROWDED", "A", `crowd L/S ≥ ${cHi.toFixed(2)}`, settled.filter((r) => r.crowdLS !== null && r.crowdLS >= cHi), `p90 of ${crowd.length}`);
  if (cLo !== null) push("CROWD_SHORT_CROWDED", "A", `crowd L/S ≤ ${cLo.toFixed(2)}`, settled.filter((r) => r.crowdLS !== null && r.crowdLS <= cLo), `p10 of ${crowd.length}`);

  const spreads = rows.map((r) => (r.topLS !== null && r.crowdLS !== null ? r.topLS - r.crowdLS : null)).filter((v): v is number => v !== null);
  const sHi = pctl(spreads, 0.75);
  if (sHi !== null) push("SMART_VS_CROWD_HI", "A", `top-trader L/S − crowd L/S ≥ ${sHi.toFixed(2)}`, settled.filter((r) => r.topLS !== null && r.crowdLS !== null && r.topLS - r.crowdLS >= sHi), `p75 of ${spreads.length}`);

  const cvd = rows.map((r) => r.cvd15mPct).filter((v): v is number => v !== null);
  const cvdLo = pctl(cvd, 0.1);
  const cvdHi = pctl(cvd, 0.9);
  if (cvdLo !== null) push("CVD_SELL_FLUSH", "B", `15m CVD ≤ ${cvdLo.toFixed(1)}% of volume`, settled.filter((r) => r.cvd15mPct !== null && r.cvd15mPct <= cvdLo), `p10 of ${cvd.length} live rows`);
  if (cvdHi !== null) push("CVD_BUY_IGNITION", "B", `15m CVD ≥ ${cvdHi.toFixed(1)}% of volume`, settled.filter((r) => r.cvd15mPct !== null && r.cvd15mPct >= cvdHi), `p90 of ${cvd.length} live rows`);

  for (const [fid, label] of [["LIQ_LONG_FLUSH", "longs liquidated 10m ≥"], ["LIQ_SHORT_FLUSH", "shorts liquidated 10m ≥"]] as const) {
    const vals = rows.map((r) => (fid === "LIQ_LONG_FLUSH" ? r.liqLong10mUsd : r.liqShort10mUsd)).filter((v): v is number => v !== null && v > 0);
    const thr = pctl(vals, 0.9);
    if (thr !== null) {
      push(
        fid, "C", `${label} $${Math.round(thr).toLocaleString("en-US")}`,
        settled.filter((r) => (fid === "LIQ_LONG_FLUSH" ? r.liqLong10mUsd : r.liqShort10mUsd) !== null && (fid === "LIQ_LONG_FLUSH" ? r.liqLong10mUsd! : r.liqShort10mUsd!) >= thr),
        `p90 of ${vals.length} live rows`,
      );
    }
  }

  // v14.0 — predicted (premiumIndex) vs SETTLED (fundingRate history) funding
  // divergence: the Binance cross-plane successor of the old cross-venue rule.
  const crossSpread = rows.map((r) => (r.fundingSettled !== null && r.funding8h !== null ? Math.abs(r.funding8h - r.fundingSettled) : null)).filter((v): v is number => v !== null);
  const xsHi = pctl(crossSpread, 0.9);
  if (xsHi !== null) push("CROSS_FUNDING_WIDE", "E", `|funding pred−settled| ≥ ${xsHi.toFixed(4)}%`, settled.filter((r) => r.fundingSettled !== null && r.funding8h !== null && Math.abs(r.funding8h - r.fundingSettled) >= xsHi), `p90 of ${crossSpread.length} live rows`);

  fam.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

  // 3) SIGNAL ATTRIBUTION — the realized book joined to the quadrant context
  const btcOldest = await db.futuresSnapshot.findFirst({ where: { symbol: "BTCUSDT", quadrant1h: { not: null } }, orderBy: { ts: "asc" }, select: { ts: true } });
  const cells: AttributionCell[] = [];
  let joined = 0;
  let attributionNote = "waiting for the first settled signals inside the snapshot window";
  if (btcOldest) {
    const btcRows = await db.futuresSnapshot.findMany({
      where: { symbol: "BTCUSDT", quadrant1h: { not: null } },
      orderBy: { ts: "asc" },
      select: { ts: true, quadrant1h: true },
    });
    const sigs = await db.signal.findMany({
      where: { status: { in: ["SL", "TP3", "EXPIRED", "CLOSED"] }, qualityFlag: null, createdAt: { gte: btcOldest.ts } },
      orderBy: { createdAt: "desc" },
      take: 1500,
      select: { direction: true, createdAt: true, pnlPercent: true },
    });
    const byCell = new Map<string, number[]>();
    for (const s of sigs) {
      const t = s.createdAt.getTime();
      // binary search the nearest snapshot within the ±fence
      let lo = 0;
      let hi = btcRows.length - 1;
      let best: (typeof btcRows)[number] | null = null;
      let bestD = Infinity;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const midTs = btcRows[mid]!.ts.getTime();
        const d = Math.abs(midTs - t);
        if (d < bestD) {
          bestD = d;
          best = btcRows[mid]!;
        }
        if (midTs < t) lo = mid + 1;
        else hi = mid - 1;
      }
      if (best && bestD <= ATTRIBUTION_FENCE_MS) {
        joined++;
        const key = `${s.direction}|${best.quadrant1h}`;
        const arr = byCell.get(key) ?? [];
        arr.push(s.pnlPercent);
        byCell.set(key, arr);
      }
    }
    for (const [key, arr] of byCell) {
      const [direction, quadrant] = key.split("|");
      cells.push({
        direction: direction!,
        quadrant: quadrant!,
        n: arr.length,
        avgPnl: Number(mean(arr).toFixed(2)),
        medianPnl: Number(median(arr).toFixed(2)),
        winPct: Number(((arr.filter((v) => v > 0).length / arr.length) * 100).toFixed(1)),
      });
    }
    cells.sort((a, b) => a.avgPnl - b.avgPnl);
    attributionNote = joined > 0 ? `${joined} settled signals joined to the BTC quadrant context (±${ATTRIBUTION_FENCE_MS / 60_000}m fence, clean ledger)` : "no settled signals inside the snapshot window yet";
  }

  // 4) BEST FILTER — book-edge candidates outrank market-edge candidates when
  // they exist (they price the actual strategy, not the raw market).
  let bestFilter: FuturesEdge["bestFilter"] = null;
  const bookCandidates = cells
    .filter((c) => c.n >= 15)
    .map((c) => ({
      filter: `${c.direction === "LONG" ? "BLOCK LONG" : "BLOCK SHORT"} in ${c.quadrant}`,
      family: "D",
      rule: `${c.direction} signals issued in ${c.quadrant} context averaged ${c.avgPnl}% levered net (n=${c.n}, win ${c.winPct}%)`,
      edge: c.avgPnl,
      n: c.n,
      confidence: confidenceOf(c.n),
      source: "BOOK-EDGE" as const,
      meaningful: c.avgPnl < 0,
    }))
    .filter((c) => c.meaningful)
    .sort((a, b) => a.edge - b.edge);
  const marketCandidates = fam
    .filter((f) => f.n >= 20 && Math.sign(f.medianFwd1h) === Math.sign(f.meanFwd1h) && f.edge !== 0)
    .map((f) => ({ filter: f.filter, family: f.family, rule: `${f.rule} → fwd1h ${f.edge > 0 ? "+" : ""}${f.edge}% vs baseline (n=${f.n})`, edge: f.edge, n: f.n, confidence: f.confidence, source: "MARKET-EDGE" as const }));
  const pool = [...bookCandidates, ...marketCandidates];
  if (pool.length) {
    const top = pool.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))[0]!;
    bestFilter = { filter: top.filter, family: top.family, rule: top.rule, edge: top.edge, n: top.n, confidence: top.confidence, source: top.source };
  }

  const value: FuturesEdge = {
    builtAt: new Date().toISOString(),
    rowsScanned: rows.length,
    settledRows: settled.length,
    baselineMeanFwd1h: baseline,
    quadrantStudy,
    familyStudy: fam,
    attribution: { cells, joined, note: attributionNote },
    bestFilter,
    maturity: { settled: settled.length, target: SETTLED_TARGET, progressPct: Math.min(100, Number(((settled.length / SETTLED_TARGET) * 100).toFixed(1))) },
  };
  edgeCache = { at: Date.now(), value };
  return value;
}

// ── API payload ────────────────────────────────────────────────────────────

export interface FuturesLive {
  at: string;
  anchors: Array<{
    symbol: string;
    ts: string;
    price: number;
    oiBase: number | null;
    oiUsdM: number | null;
    priceDelta15m: number | null;
    priceDelta1h: number | null;
    oiDelta15m: number | null;
    oiDelta1h: number | null;
    quadrant15m: QuadrantId | null;
    quadrant1h: QuadrantId | null;
    funding8h: number | null;
    crowdLS: number | null;
    topLS: number | null;
    cvd15mPct: number | null;
    cvd1hPct: number | null;
    liqLong10mUsd: number | null;
    liqShort10mUsd: number | null;
    liqUsd1h: number | null;
    fundingSettled: number | null;
    oiChk: number | null;
    crossSpreadBps8h: number | null;
  }>;
  series: Array<{ symbol: string; points: Array<{ ts: number; price: number; oiBase: number | null; quadrant1h: string | null }> }>;
  services: { tape: Awaited<ReturnType<typeof getTapeHealth>>; liq: Awaited<ReturnType<typeof getLiquidationStatus>> };
  edge: FuturesEdge;
  backfill: BackfillState | null;
  counts: { total: number; live: number; backfill: number; settled1h: number; last24h: number };
}

let liveCache: { at: number; value: FuturesLive } | null = null;

export async function getFuturesLive(force = false): Promise<FuturesLive> {
  if (!force && liveCache && Date.now() - liveCache.at < 15_000) return liveCache.value;

  const [latestRows, edge, backfill, tapeHealth, liqStatus, countTotal, countLive, countBackfill, countSettled, count24h, seriesRaw] = await Promise.all([
    Promise.all(
      FUTURES_ANCHORS.map((s) => db.futuresSnapshot.findFirst({ where: { symbol: s, source: "LIVE" }, orderBy: { ts: "desc" } })),
    ),
    buildFuturesEdge(),
    readBackfillState(),
    getTapeHealth().catch(() => ({ reachable: false, connected: false, source: "OFFLINE", symbols: 0, trades: 0, dataStalled: true })),
    getLiquidationStatus().catch(() => null),
    db.futuresSnapshot.count(),
    db.futuresSnapshot.count({ where: { source: "LIVE" } }),
    db.futuresSnapshot.count({ where: { source: "BACKFILL" } }),
    db.futuresSnapshot.count({ where: { fwd1hPct: { not: null } } }),
    db.futuresSnapshot.count({ where: { ts: { gte: new Date(Date.now() - 86_400_000) } } }),
    db.futuresSnapshot.findMany({
      where: { ts: { gte: new Date(Date.now() - 24 * 3_600_000) }, symbol: "BTCUSDT" },
      orderBy: { ts: "asc" },
      select: { ts: true, price: true, oiBase: true, quadrant1h: true },
    }),
  ]);

  const stride = Math.max(1, Math.ceil(seriesRaw.length / 120));
  const points = seriesRaw.filter((_, i) => i % stride === 0 || i === seriesRaw.length - 1).map((r) => ({ ts: r.ts.getTime(), price: r.price, oiBase: r.oiBase, quadrant1h: r.quadrant1h }));

  const anchors = latestRows.map((row, i) => {
    if (!row) {
      return {
        symbol: FUTURES_ANCHORS[i]!, ts: "", price: 0, oiBase: null, oiUsdM: null, priceDelta15m: null, priceDelta1h: null,
        oiDelta15m: null, oiDelta1h: null, quadrant15m: null, quadrant1h: null, funding8h: null, crowdLS: null, topLS: null,
        cvd15mPct: null, cvd1hPct: null, liqLong10mUsd: null, liqShort10mUsd: null, liqUsd1h: null,
        fundingSettled: null, oiChk: null, crossSpreadBps8h: null,
      };
    }
    return {
      symbol: row.symbol,
      ts: row.ts.toISOString(),
      price: row.price,
      oiBase: row.oiBase,
      oiUsdM: row.oiUsdM,
      priceDelta15m: row.priceDelta15m,
      priceDelta1h: row.priceDelta1h,
      oiDelta15m: row.oiDelta15m,
      oiDelta1h: row.oiDelta1h,
      quadrant15m: row.quadrant15m as QuadrantId | null,
      quadrant1h: row.quadrant1h as QuadrantId | null,
      funding8h: row.funding8h,
      crowdLS: row.crowdLS,
      topLS: row.topLS,
      cvd15mPct: row.cvd15mPct,
      cvd1hPct: row.cvd1hPct,
      liqLong10mUsd: row.liqLong10mUsd,
      liqShort10mUsd: row.liqShort10mUsd,
      liqUsd1h: row.liqUsd1h,
      fundingSettled: row.fundingSettled,
      oiChk: row.oiChk,
      crossSpreadBps8h:
        row.fundingSettled !== null && row.funding8h !== null
          ? Number(((row.funding8h - row.fundingSettled) * 10_000).toFixed(1)) // bps per 8h (predicted − settled)
          : null,
    };
  });

  const value: FuturesLive = {
    at: new Date().toISOString(),
    anchors,
    series: [{ symbol: "BTCUSDT", points }],
    services: { tape: tapeHealth, liq: liqStatus },
    edge,
    backfill,
    counts: { total: countTotal, live: countLive, backfill: countBackfill, settled1h: countSettled, last24h: count24h },
  };
  liveCache = { at: Date.now(), value };
  return value;
}
