// ── FlowRadar Neo v8.0 MULTI-TIMEFRAME FLOW SCANNER (EPOCH-2, server-only) ──
// Operator mandate 2026-09-08: «معماری سیستم اسکنر جریانات مالی با قابلیت ردیابی
// در تایم فریمهای مختلف». Research base: docs/RESEARCH-FLOW-DETECTION.md.
//
// Design laws (research-derived):
//   · HTF dominance — 4h/1h carry the bias; 15m/5m only time the entry.
//   · Closed bars only — every structure call is on a CLOSED candle (no repaint,
//     no lookahead).
//   · Flow must explain price — the OI×price validity matrix and CVD divergence
//     rule come from flow.ts; this module extends them across TFs.
//   · Sweeps are context — a sweep counts only against the prior 24-bar swing of
//     ITS OWN timeframe, with a ≥50% rejection wick.
//
// Cadence: rotating batch of 6 symbols per call (engine tick ×25 ≈ 87s) → the
// full 40-64 symbol domain re-scans in ~10-16min. Per-TF kline caches keep the
// API cost at ~24 kline calls/min worst case. Persistence: one FlowScan row per
// (symbol, tf) UPSERTED (no churn) + the whole board in EngineSetting
// "flowscan.board" (single-row upsert — race-free by construction).

import { db } from "@/lib/db";
import { gateFetch } from "./fapi-gate";
import { fetchFlowMetrics } from "./flow";
import { bybitKlines, bybitHealth } from "./bybit-feed";

export const SCAN_TFS = ["4h", "1h", "15m", "5m"] as const;
export type ScanTf = (typeof SCAN_TFS)[number];

const TF_WEIGHT: Record<ScanTf, number> = { "4h": 0.35, "1h": 0.3, "15m": 0.2, "5m": 0.15 };
const TF_LIMIT: Record<ScanTf, number> = { "4h": 72, "1h": 96, "15m": 120, "5m": 120 };
const TF_TTL: Record<ScanTf, number> = { "4h": 480_000, "1h": 240_000, "15m": 90_000, "5m": 45_000 };
const BOARD_KEY = "flowscan.board";
const BATCH = 6;
// DATA-REVIVAL 2026-10-21 — 60s/6 symbols needed ~11min to rotate a 64-symbol
// board; the operator mandate is flow tracking at HIGH SPEED. 20s/6 → full
// board ~3.5min. Bybit public plane carries this easily; the fapi-gate
// telemetry lane is sheddable as before.
const MIN_INTERVAL_MS = 20_000;
const NET_BIAS_MIN = 20; // |netScore| needed to call a LONG/SHORT board
const HTF_FLIP_MIN = { h4: 25, h1: 30 }; // HTF-conflict thresholds for FLOW-SHIFT
const SHIFT_COOLDOWN_MS = 2 * 3600_000;

export type FlowBias = "LONG" | "SHORT" | "NEUTRAL";

export interface MtfTfRow {
  tf: ScanTf;
  score: number; // −100..+100 along the TF's own read
  bias: FlowBias;
  trend: "UP" | "DOWN" | "FLAT";
  structure: "BOS_UP" | "BOS_DOWN" | "CHOH_UP" | "CHOH_DOWN" | "SWEEP_HIGH" | "SWEEP_LOW" | "RANGE";
  sweep: boolean;
  cvdPct: number | null;
  volZ: number | null;
  atrPct: number | null;
}

export interface MtfRollup {
  symbol: string;
  at: number;
  netScore: number; // −100..+100, HTF-weighted consensus
  netBias: FlowBias;
  alignment: number; // how many TFs match netBias (0..4)
  tfs: MtfTfRow[];
  funding8h: number | null;
  oiDelta1h: number | null;
  venue?: "BINANCE" | "BYBIT" | "MIXED"; // DATA-REVIVAL 2026-10-21 — honest venue tag on the kline plane
}

interface FlowCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuy: number; // kline field 9 — base volume bought by TAKERS
}

// ── kline+flow fetch with per-(symbol,tf) cache and in-flight dedupe ──
const klineFlowCache = new Map<string, { at: number; candles: FlowCandle[]; venue: "BINANCE" | "BYBIT" }>();
const klineFlowInFlight = new Map<string, Promise<{ candles: FlowCandle[]; venue: "BINANCE" | "BYBIT" } | null>>();

// DATA-REVIVAL 2026-10-21 — silent-starvation fix: when the fapi plane fails
// (IP-ban 418), the failure is COUNTED and rate-limit-logged, and the scan
// falls back to the Bybit v5 kline plane with an honest venue tag. The old
// code swallowed every failure → FlowScan froze for 25 days with zero logs.
const fbStats = (() => {
  // globalThis dedupe — Turbopack can instantiate per-route bundles; the
  // engine's tick loop and the /api/flows route MUST share one counter set.
  const g = globalThis as { __nexusFlowFbStats?: { fapiFail: number; bybitOk: number; bybitFail: number; spotOk: number; lastWarnAt: number } };
  g.__nexusFlowFbStats ??= { fapiFail: 0, bybitOk: 0, bybitFail: 0, spotOk: 0, lastWarnAt: 0 };
  return g.__nexusFlowFbStats;
})();

// third rung — Binance SPOT klines via the data-vision mirror host family
// (api.binance.com is IP-banned; data-api.binance.vision is NOT — proven live
// by the feed probe). Spot klines share the exact field layout (takerBuy at
// index 9) so CVD stays REAL. For niche Binance listings absent from Bybit
// linear this is the only honest revival path.
async function spotKlines(symbol: string, tf: ScanTf, limit: number): Promise<FlowCandle[] | null> {
  for (const host of ["https://data-api.binance.vision", "https://api.binance.com"]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6500);
      const res = await fetch(`${host}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok) continue;
      const raw = (await res.json()) as (string | number)[][];
      if (!Array.isArray(raw) || raw.length === 0) continue;
      return raw.map((k) => ({ openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), takerBuy: Number(k[9]) }));
    } catch {
      continue;
    }
  }
  return null;
}
function warnFallback(msg: string) {
  if (Date.now() - fbStats.lastWarnAt < 60_000) return;
  fbStats.lastWarnAt = Date.now();
  console.warn(`[flow-scanner] ${msg}`);
}
export function flowScanHealth(): { fapiFail: number; bybitOk: number; bybitFail: number; spotOk: number; bybit: ReturnType<typeof bybitHealth> } {
  return { fapiFail: fbStats.fapiFail, bybitOk: fbStats.bybitOk, bybitFail: fbStats.bybitFail, spotOk: fbStats.spotOk, bybit: bybitHealth() };
}

async function fetchKlinesFlow(symbol: string, tf: ScanTf): Promise<{ candles: FlowCandle[]; venue: "BINANCE" | "BYBIT" } | null> {
  const key = `${symbol}|${tf}`;
  const hit = klineFlowCache.get(key);
  if (hit && Date.now() - hit.at < TF_TTL[tf]) return hit;
  const existing = klineFlowInFlight.get(key);
  if (existing) return existing;
  const p = (async (): Promise<{ candles: FlowCandle[]; venue: "BINANCE" | "BYBIT" } | null> => {
    try {
      // v10.24 Task 34-a: klines through the central fapi-gate (telemetry lane
      // — a shedded (symbol,tf) simply re-scans on the next rotation).
      let venue: "BINANCE" | "BYBIT" = "BINANCE";
      let raw: (string | number)[][] | null = null;
      try {
        raw = await gateFetch<(string | number)[][]>(`/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${TF_LIMIT[tf]}`, { priority: "telemetry", timeoutMs: 6500 });
      } catch {
        raw = null;
      }
      if (!raw || raw.length === 0) {
        // honest fallback ladder — same-venue SPOT mirror first (keeps CVD REAL
        // via taker-buy field 9), then Bybit perp (taker split unavailable →
        // CVD null on those rows)
        fbStats.fapiFail++;
        const spot = await spotKlines(symbol, tf, TF_LIMIT[tf]);
        if (spot && spot.length > 0) {
          venue = "BINANCE"; // same venue, SPOT instrument class (vision mirror)
          fbStats.spotOk++;
          warnFallback(`fapi kline unavailable (${symbol} ${tf}) → BINANCE-SPOT mirror (CVD real, spot tape)`);
          klineFlowCache.set(key, { at: Date.now(), candles: spot, venue });
          return { candles: spot, venue };
        }
        fbStats.spotOk += 0; // keep the counter shape stable
        const alt = await bybitKlines(symbol, tf, TF_LIMIT[tf]);
        if (alt && alt.length > 0) {
          venue = "BYBIT";
          fbStats.bybitOk++;
          warnFallback(`spot+mirror miss (${symbol} ${tf}) → BYBIT perp fallback (CVD null on this row)`);
          const candles = alt.map((k) => ({ openTime: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume, takerBuy: NaN }));
          klineFlowCache.set(key, { at: Date.now(), candles, venue });
          return { candles, venue };
        }
        fbStats.bybitFail++;
        warnFallback(`kline starved on ALL planes: ${symbol} ${tf} (fapi + spot + bybit)`);
        return null;
      }
      const candles = raw.map((k) => ({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        takerBuy: Number(k[9]),
      }));
      klineFlowCache.set(key, { at: Date.now(), candles, venue: "BINANCE" });
      return { candles, venue: "BINANCE" as const };
    } catch {
      return null;
    } finally {
      klineFlowInFlight.delete(key);
    }
  })();
  klineFlowInFlight.set(key, p);
  return p;
}

// ── pure per-TF analytics (closed bars ONLY — the last raw kline may be
// unclosed, so it is dropped before any computation) ──
function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

function analyzeTf(symbol: string, tf: ScanTf, raw: FlowCandle[], funding8h: number | null, oiDelta1h: number | null): MtfTfRow | null {
  const candles = raw.slice(0, -1); // drop the possibly-unclosed bar — closed bars only
  if (candles.length < 40) return null;
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes.slice(-60), 20);
  const e50 = ema(closes.slice(-90), 50);
  const trend: MtfTfRow["trend"] = e20 > e50 * 1.0005 ? "UP" : e20 < e50 * 0.9995 ? "DOWN" : "FLAT";

  // pivots over the last 30 closed bars (fractal: 2 bars each side)
  const win = candles.slice(-30);
  const pivotHighs: number[] = [];
  const pivotLows: number[] = [];
  for (let i = 2; i < win.length - 2; i++) {
    const h = win[i]!.high;
    const l = win[i]!.low;
    if (h > win[i - 1]!.high && h > win[i - 2]!.high && h > win[i + 1]!.high && h > win[i + 2]!.high) pivotHighs.push(h);
    if (l < win[i - 1]!.low && l < win[i - 2]!.low && l < win[i + 1]!.low && l < win[i + 2]!.low) pivotLows.push(l);
  }
  const swingHigh = pivotHighs.length ? Math.max(...pivotHighs) : Math.max(...win.slice(0, -1).map((c) => c.high));
  const swingLow = pivotLows.length ? Math.min(...pivotLows) : Math.min(...win.slice(0, -1).map((c) => c.low));

  const last = win[win.length - 1]!;
  const range = last.high - last.low;
  let structure: MtfTfRow["structure"] = "RANGE";
  let sweep = false;
  if (range > 0) {
    // liquidity sweep — grab the obvious swing, close back inside, ≥50% rejection wick
    if (last.high > swingHigh && last.close < swingHigh && (last.high - last.close) / range >= 0.5) {
      structure = "SWEEP_HIGH";
      sweep = true;
    } else if (last.low < swingLow && last.close > swingLow && (last.close - last.low) / range >= 0.5) {
      structure = "SWEEP_LOW";
      sweep = true;
    } else if (last.close > swingHigh) {
      structure = trend === "DOWN" ? "CHOH_UP" : "BOS_UP";
    } else if (last.close < swingLow) {
      structure = trend === "UP" ? "CHOH_DOWN" : "BOS_DOWN";
    }
  }

  // CVD over the last 12 closed bars — direct taker aggression from kline field 9.
  // DATA-REVIVAL: Bybit-fallback candles carry takerBuy=NaN → cvdPct stays null
  // (honest measured gap — never invented from price direction).
  const w12 = candles.slice(-12);
  const vol12 = w12.reduce((a, c) => a + c.volume, 0);
  const buy12 = w12.reduce((a, c) => a + c.takerBuy, 0);
  const cvdPct = vol12 > 0 && Number.isFinite(buy12) ? Number((((2 * buy12 - vol12) / vol12) * 100).toFixed(2)) : null;

  // volume ignition z-score (last closed bar vs prior 30)
  const v30 = candles.slice(-31, -1).map((c) => c.volume);
  const vMean = v30.reduce((a, b) => a + b, 0) / Math.max(1, v30.length);
  const vStd = Math.sqrt(v30.reduce((a, b) => a + (b - vMean) * (b - vMean), 0) / Math.max(1, v30.length));
  const volZ = vStd > 0 ? Number((((last.volume - vMean) / vStd)).toFixed(2)) : null;

  // ATR% (14 bars, true range)
  let atrSum = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    atrSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const atrPct = Number(((atrSum / 14 / last.close) * 100).toFixed(2));

  // per-TF score −100..+100
  let s = 0;
  if (cvdPct !== null) s += Math.max(-40, Math.min(40, cvdPct * 2.2));
  s += trend === "UP" ? 18 : trend === "DOWN" ? -18 : 0;
  if (structure === "BOS_UP") s += 20;
  else if (structure === "BOS_DOWN") s -= 20;
  else if (structure === "CHOH_UP") s += 14;
  else if (structure === "CHOH_DOWN") s -= 14;
  if (structure === "SWEEP_LOW") s += 14; // sell-side liquidity grabbed → fuel for longs
  else if (structure === "SWEEP_HIGH") s -= 14; // buy-side grabbed → fuel for shorts
  if (volZ !== null && cvdPct !== null) s += Math.sign(cvdPct) * Math.min(3, Math.max(0, volZ)) * 4;
  const score = Math.round(Math.max(-100, Math.min(100, s)));
  const bias: FlowBias = score >= 25 ? "LONG" : score <= -25 ? "SHORT" : "NEUTRAL";

  return { tf, score, bias, trend, structure, sweep, cvdPct, volZ, atrPct };
}

// ── board state ──
const board = new Map<string, MtfRollup>();
let boardLoaded = false;
// (scanCursor removed in v12.10 — the two-speed rotation picks oldest-board-first,
//  no fixed cursor: hot lane 5/6 + tail 1/6 of every batch)
let lastScanAt = 0;
let scanInFlight = false;
const shiftLastAt = new Map<string, number>();

// ── RAM-SHED hook (RAM-SHED-20261024) ──────────────────────────────────────
// The instrumentation RSS governor calls this under memory pressure. The
// kline cache is the biggest DISCRETIONARY in-app store (candles per
// symbol×tf — safely refetchable within one scan cycle), so it sheds first:
// entries older than 10min are dropped + in-flight dedupe cleared. Returns
// the number of entries freed for the governor log. globalThis dedupe —
// Turbopack can instantiate per-route bundles; the governor must reach the
// ONE shared cache instance.
{
  const g = globalThis as { __nexusShed?: () => number };
  if (!g.__nexusShed) {
    g.__nexusShed = (): number => {
      let freed = 0;
      const now = Date.now();
      for (const [key, entry] of klineFlowCache) {
        if (now - entry.at > 10 * 60_000) {
          klineFlowCache.delete(key);
          freed++;
        }
      }
      klineFlowInFlight.clear();
      return freed;
    };
  }
}

async function loadBoard(): Promise<void> {
  if (boardLoaded) return;
  boardLoaded = true;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: BOARD_KEY } });
    if (row) {
      const parsed = JSON.parse(row.value) as { rows: MtfRollup[] };
      for (const r of parsed.rows ?? []) board.set(r.symbol, r);
    }
  } catch {
    /* cold start — the scanner repopulates within minutes */
  }
}

async function persistBoard(): Promise<void> {
  const rows = [...board.values()].sort((a, b) => Math.abs(b.netScore) - Math.abs(a.netScore)).slice(0, 64);
  const value = JSON.stringify({ at: Date.now(), rows });
  await db.engineSetting.upsert({ where: { key: BOARD_KEY }, create: { key: BOARD_KEY, value }, update: { value } });
}

async function scanSymbol(symbol: string): Promise<MtfRollup | null> {
  const settled = await Promise.allSettled(SCAN_TFS.map((tf) => fetchKlinesFlow(symbol, tf)));
  const raw = settled.map((r) => (r.status === "fulfilled" ? r.value : null));
  if (raw.filter(Boolean).length < 3) return null; // honest: need ≥3 TFs, no invented rows
  const venues = raw.filter(Boolean).map((r) => r!.venue);
  const rollupVenue: "BINANCE" | "BYBIT" | "MIXED" = venues.every((v) => v === "BINANCE") ? "BINANCE" : venues.every((v) => v === "BYBIT") ? "BYBIT" : "MIXED";

  // derivatives context is TF-agnostic — one shared cached fetch (flow.ts)
  let funding8h: number | null = null;
  let oiDelta1h: number | null = null;
  try {
    const m = await fetchFlowMetrics(symbol);
    if (m) {
      funding8h = m.funding8h;
      oiDelta1h = m.oiDelta1h;
    }
  } catch {
    /* context stays null — rows still ship with the measured price-flow vector */
  }

  const tfs: MtfTfRow[] = [];
  for (let i = 0; i < SCAN_TFS.length; i++) {
    const r = raw[i];
    if (!r) continue;
    const row = analyzeTf(symbol, SCAN_TFS[i]!, r.candles, funding8h, oiDelta1h);
    if (row) tfs.push(row);
  }
  if (tfs.length < 3) return null;

  const netScore = Math.round(tfs.reduce((a, t) => a + t.score * TF_WEIGHT[t.tf], 0));
  const netBias: FlowBias = netScore >= NET_BIAS_MIN ? "LONG" : netScore <= -NET_BIAS_MIN ? "SHORT" : "NEUTRAL";
  const alignment = netBias === "NEUTRAL" ? 0 : tfs.filter((t) => t.bias === netBias).length;
  return { symbol, at: Date.now(), netScore, netBias, alignment, tfs, funding8h, oiDelta1h, venue: rollupVenue };
}

/** Rotating scanner — call from the engine tick. Scans BATCH symbols per call. */
export async function maybeFlowScan(symbols: string[]): Promise<void> {
  await loadBoard();
  if (scanInFlight || symbols.length === 0) return;
  if (Date.now() - lastScanAt < MIN_INTERVAL_MS) return;
  scanInFlight = true;
  lastScanAt = Date.now();
  try {
    // v12.10 TWO-SPEED ROTATION (AUDIT-20261023 root-cause of «سرعت تشخیص»):
    // the tracked domain grew to ~900 symbols while the rotation budget stayed
    // at the 64-symbol design (6/call, 20s) → a full cycle takes ~50min against
    // the 20min board TTL → peekSymbolFlow() returns null (stale-never-gates)
    // for MOST of the universe → the MTF deploy guard silently blind. Fix: the
    // caller now passes the domain VOLUME-RANKED (hot deployable universe
    // first); this lane owns 5/6 of every batch, the long tail 1 slot — both
    // oldest-board-first so ages self-balance. Hot lane (64 syms) re-scans in
    // ~4.3min « well under the TTL; the dust tail rotates slowly but is
    // liquidity-floored out of deploys anyway.
    const HOT = 64;
    const boardAge = (s: string) => {
      const r = board.get(s);
      return r ? Date.now() - r.at : Number.POSITIVE_INFINITY;
    };
    const oldestFirst = (arr: string[], n: number): string[] =>
      [...arr].sort((a, b) => boardAge(b) - boardAge(a)).slice(0, Math.max(0, Math.min(n, arr.length)));
    const head = symbols.slice(0, HOT);
    const tail = symbols.slice(HOT);
    const batch: string[] = [...oldestFirst(head, tail.length > 0 ? BATCH - 1 : BATCH), ...oldestFirst(tail, tail.length > 0 ? 1 : 0)];
    if (batch.length === 0) return;
    for (const symbol of batch) {
      const rollup = await scanSymbol(symbol).catch(() => null);
      if (!rollup) continue;
      board.set(symbol, rollup);
      for (const t of rollup.tfs) {
        const data = {
          score: t.score,
          bias: t.bias,
          cvdPct: t.cvdPct,
          trend: t.trend,
          structure: t.structure,
          sweep: t.sweep,
          volZ: t.volZ,
          atrPct: t.atrPct,
          funding8h: rollup.funding8h,
          oiDelta1h: rollup.oiDelta1h,
        };
        await db.flowScan.upsert({ where: { symbol_tf: { symbol, tf: t.tf } }, create: { symbol, tf: t.tf, ...data }, update: data });
      }
    }
    await persistBoard();
  } finally {
    scanInFlight = false;
  }
}

/** v12.12 CARD-SENTINEL (2026-10-24) — on-demand single-symbol refresh that ALSO
 *  persists the FlowScan DB cards. ensureSymbolFlow() only warms the in-memory
 *  board; the DB rows the dashboard renders were left to the two-speed rotation,
 *  so any symbol that cooled off went stale for hours (BIRBUSDT cards 4h9m old
 *  while its events kept firing — SENTINEL-M0M2 finding #6). One in-flight
 *  refresh per process; callers rate-limit per symbol (route enforces 90s). */
let refreshInFlight = false;
export async function refreshSymbolFlow(symbol: string): Promise<MtfRollup | null> {
  if (refreshInFlight) return null;
  refreshInFlight = true;
  try {
    await loadBoard();
    const rollup = await scanSymbol(symbol).catch(() => null);
    if (!rollup) return null;
    board.set(symbol, rollup);
    for (const t of rollup.tfs) {
      const data = {
        score: t.score,
        bias: t.bias,
        cvdPct: t.cvdPct,
        trend: t.trend,
        structure: t.structure,
        sweep: t.sweep,
        volZ: t.volZ,
        atrPct: t.atrPct,
        funding8h: rollup.funding8h,
        oiDelta1h: rollup.oiDelta1h,
      };
      await db.flowScan.upsert({ where: { symbol_tf: { symbol, tf: t.tf } }, create: { symbol, tf: t.tf, ...data }, update: data });
    }
    await persistBoard();
    return rollup;
  } finally {
    refreshInFlight = false;
  }
}

/** Sync hot-path read for the deploy scan — returns the cached rollup or null. */
export function peekSymbolFlow(symbol: string): MtfRollup | null {
  const r = board.get(symbol);
  if (!r) return null;
  const age = Date.now() - r.at;
  if (age > 20 * 60_000) return null; // stale board never gates — 20min TTL
  return r;
}

/** Task 86: on-demand deploy-time snapshot — radar/event-trigger spawns often
 *  target a symbol the rotating board has not reached yet; scan it NOW so the
 *  gate decides on live flow instead of a cold board. */
export async function ensureSymbolFlow(symbol: string): Promise<MtfRollup | null> {
  await loadBoard();
  const peeked = peekSymbolFlow(symbol);
  if (peeked) return peeked;
  return scanSymbol(symbol);
}

/** v8.1 P1/P2: read-only access to the scanner's 15m kline cache — lets the
 *  liq-heatmap and vol-forecast modules reuse fresh candles with ZERO extra
 *  fetches. Returns null when the cache is cold or older than the TF TTL. */
export function peekFlowKlines(symbol: string, tf: ScanTf): FlowCandle[] | null {
  const hit = klineFlowCache.get(`${symbol}|${tf}`);
  if (!hit || Date.now() - hit.at >= TF_TTL[tf]) return null;
  return hit.candles;
}

/** FLOW-SHIFT tracking: warn when BOTH 1h and 4h bias flip against a live book. */
export async function flowShiftTracking(): Promise<void> {
  await loadBoard();
  const active = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { id: true, serial: true, symbol: true, direction: true } });
  if (active.length === 0) return;
  const { fireEvent } = await import("./engine"); // dynamic — keeps the module cycle off the boot path
  for (const s of active) {
    const r = board.get(s.symbol);
    if (!r || r.netBias === "NEUTRAL") continue;
    const h1 = r.tfs.find((t) => t.tf === "1h");
    const h4 = r.tfs.find((t) => t.tf === "4h");
    if (!h1 || !h4) continue;
    const dirLong = s.direction === "LONG";
    const against = dirLong ? "SHORT" : "LONG";
    const flipped = h1.bias === against && h4.bias === against && Math.abs(h1.score) >= HTF_FLIP_MIN.h1 && Math.abs(h4.score) >= HTF_FLIP_MIN.h4;
    if (!flipped) continue;
    const last = shiftLastAt.get(s.id) ?? 0;
    if (Date.now() - last < SHIFT_COOLDOWN_MS) continue;
    shiftLastAt.set(s.id, Date.now());
    await fireEvent(s.id, s.symbol, "ENGINE", "warn", `FLOW-SHIFT: NX-${String(s.serial).padStart(4, "0")} ${s.direction} ${s.symbol} — 1h (${h1.score}) and 4h (${h4.score}) flow boards both flipped ${against} while the book is live (board net ${r.netScore}, ${r.alignment}/4 TFs aligned). Regime damage visible BEFORE the stop — consider BE-trail status.`);
  }
}

/** Full board for /api/flows — sorted by |netScore|. */
export async function getFlowBoard(): Promise<{ at: string; coverage: number; rows: MtfRollup[] }> {
  await loadBoard();
  const rows = [...board.values()].sort((a, b) => Math.abs(b.netScore) - Math.abs(a.netScore));
  return { at: new Date().toISOString(), coverage: rows.length, rows: rows.slice(0, 48) };
}
