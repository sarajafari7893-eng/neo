// ── NEXUS//SIGNALS Research Factor Stack (server-only) ──
// v4.7 "RESEARCH FACTORS" — the 12 evidence-ranked factors from the deep
// research round (docs/research/FLOW-FACTOR-RESEARCH.md + factor-candidates.json).
//
//   P0  lpoc_quadrant        Glassnode LPOC: price × OI 4-quadrant regime
//   P0  taker_ratio_z        Taker buy/sell ratio z-score (klines field already fetched)
//   P0  cvd_real_divergence  REAL aggTrade CVD + classic/hidden divergence (trade-service)
//   P1  funding_extreme      per-strategy funding thresholds (MEAN-REVERT weights crowd
//                            extremes heavier; MOMENTUM/BREAKOUT lighter — trends persist)
//   P1  obi_smooth           Order-book imbalance (top-5 levels), EMA-smoothed,
//                            spoof-guarded by a 1.1s double-poll
//   P1  basis                perp–spot basis dislocation (/futures/data/basis)
//   P1  liq_magnets          REAL forceOrder price-bucket clusters within 0.35% (liq-service)
//   P2  vpin_lite            VPIN toxicity suppressor — volatility forecaster, NOT direction
//   P2  amihud_z             Amihud illiquidity z-score from klines (thin-market discount)
//   P2  top_trader_spread    top-trader position ratio vs retail account ratio (contrarian)
//   P2  vp_poc_distance      volume-profile POC distance / LVN breakout terrain (klines)
//   P3  etf_flow_bias        BTC spot-ETF 3-day net flow (Farside) — daily macro bias
//   P3  stablecoin_bias      stablecoin supply growth 7d (DefiLlama) — daily macro bias
//
// ADOPT RULE (from the research contract): every factor reports its vote
// separately with live values; VPIN and macro bias act as suppression /
// multiplier only. The stack score is folded into the flow gate score with
// an operator-tunable impact scale persisted in EngineSetting("research").
// Every number is measured at call time; unavailable ⇒ vote 0 + reason.

import type { Candle } from "@/lib/indicators";
import type { FlowMetrics } from "@/lib/flow";
import { getLiquidationSnapshot } from "@/lib/liquidations";
import { getTape } from "@/lib/trade-flow";
import { db } from "@/lib/db";

/* ── settings (operator tunables, persisted) ─────────────────── */

export interface ResearchSettings {
  impactScale: number; // 0..1.5 — how strongly the stack moves the flow gate
  enabled: Record<string, boolean>; // per-factor switches
}

export const RESEARCH_IDS = [
  "lpoc_quadrant",
  "taker_ratio_z",
  "cvd_real_divergence",
  "funding_extreme",
  "obi_smooth",
  "basis",
  "liq_magnets",
  "vpin_lite",
  "amihud_z",
  "top_trader_spread",
  "vp_poc_distance",
  "etf_flow_bias",
  "stablecoin_bias",
] as const;

export type ResearchId = (typeof RESEARCH_IDS)[number];

export const RESEARCH_DEFAULTS: ResearchSettings = {
  impactScale: 1.0,
  enabled: Object.fromEntries(RESEARCH_IDS.map((id) => [id, true])),
};

const RESEARCH_KEY = "research";
let researchCache: { s: ResearchSettings; ts: number } | null = null;

export async function getResearchSettings(): Promise<ResearchSettings> {
  if (researchCache && Date.now() - researchCache.ts < 15_000) return researchCache.s;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: RESEARCH_KEY } });
    const raw = row ? (JSON.parse(row.value) as Partial<ResearchSettings>) : null;
    const s: ResearchSettings = {
      impactScale: Math.max(0, Math.min(1.5, Number(raw?.impactScale ?? RESEARCH_DEFAULTS.impactScale) || 0)),
      enabled: { ...RESEARCH_DEFAULTS.enabled, ...(raw?.enabled ?? {}) },
    };
    researchCache = { s, ts: Date.now() };
    return s;
  } catch {
    return researchCache?.s ?? { ...RESEARCH_DEFAULTS, enabled: { ...RESEARCH_DEFAULTS.enabled } };
  }
}

export async function setResearchSettings(patch: Partial<ResearchSettings>): Promise<ResearchSettings> {
  const cur = await getResearchSettings();
  const next: ResearchSettings = {
    impactScale: Math.max(0, Math.min(1.5, Number(patch.impactScale ?? cur.impactScale) || 0)),
    enabled: { ...cur.enabled, ...(patch.enabled ?? {}) },
  };
  await db.engineSetting.upsert({
    where: { key: RESEARCH_KEY },
    create: { key: RESEARCH_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  researchCache = { s: next, ts: Date.now() };
  return next;
}

/* ── types ───────────────────────────────────────────────────── */

export interface ResearchVote {
  id: ResearchId;
  label: string;
  vote: number; // signed ALONG the candidate direction (0 = informational/off)
  value: string; // live measured value for the UI
  detail: string; // human-readable reason (may be empty)
}

export interface ResearchStack {
  score: number; // clamped −12..+12 sum of votes (before impact scaling)
  votes: ResearchVote[];
  suppress: string | null; // VPIN-style entry suppression reason
  macroMult: number; // direction-aware macro bias ×0.90..×1.10
  macroDetail: string | null;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/* ── P3 macro bias: daily-cached external flows ──────────────── */

interface MacroState {
  etf: { sum3dM: number | null; last: number | null; ok: boolean; at: number };
  stable: { growth7dPct: number | null; ok: boolean; at: number };
}

const macro: MacroState = {
  etf: { sum3dM: null, last: null, ok: false, at: 0 },
  stable: { growth7dPct: null, ok: false, at: 0 },
};
const MACRO_TTL_MS = 6 * 3600_000;
const MACRO_TIMEOUT_MS = 9000;

async function refreshEtfFlows(): Promise<void> {
  if (Date.now() - macro.etf.at < MACRO_TTL_MS) return;
  macro.etf.at = Date.now();
  // Farside daily BTC spot-ETF net-flow table (free, no key). The last
  // table rows are the most recent trading days; totals column is last.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), MACRO_TIMEOUT_MS);
    const res = await fetch("https://farside.co.uk/btc/", {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "user-agent": "Mozilla/5.0 (compatible; nexus-signals/4.7; research)" },
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    const parsed: Array<{ date: string; total: number }> = [];
    for (const r of rows) {
      const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").trim());
      if (cells.length < 4) continue;
      const date = cells[0];
      if (!/\d{1,2} \w{3} \d{4}/.test(date)) continue;
      const totalRaw = cells[cells.length - 1].replace(/,/g, "");
      const total = parseFloat(totalRaw);
      if (Number.isFinite(total)) parsed.push({ date, total });
    }
    if (parsed.length >= 4) {
      const last4 = parsed.slice(-4);
      macro.etf.sum3dM = Math.round(last4.slice(1).reduce((a, r) => a + r.total, 0)); // last 3 days, $M
      macro.etf.last = last4[last4.length - 1].total;
      macro.etf.ok = true;
    }
  } catch {
    macro.etf.ok = false; // source down — bias stays neutral, honestly
  }
}

interface LlamaPoint {
  date: string;
  totalCirculating?: { peggedUSD?: number };
}

async function refreshStablecoin(): Promise<void> {
  if (Date.now() - macro.stable.at < MACRO_TTL_MS) return;
  macro.stable.at = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), MACRO_TIMEOUT_MS);
    const res = await fetch("https://stablecoins.llama.fi/stablecoincharts/all", {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as LlamaPoint[];
    if (!Array.isArray(data) || data.length < 9) throw new Error("short series");
    const val = (p: LlamaPoint) => p?.totalCirculating?.peggedUSD ?? 0;
    const last8 = data.slice(-8).map(val);
    if (last8.some((v) => v <= 0)) throw new Error("bad points");
    const growth = ((last8[last8.length - 1] - last8[0]) / last8[0]) * 100;
    macro.stable.growth7dPct = Math.round(growth * 100) / 100;
    macro.stable.ok = true;
  } catch {
    macro.stable.ok = false;
  }
}

/** Direction-aware macro multiplier (ETF applies to BTC only — per research). */
function macroBias(symbol: string, direction: "LONG" | "SHORT"): { mult: number; detail: string | null } {
  const isLong = direction === "LONG";
  const parts: string[] = [];
  let mult = 1;
  if (macro.etf.ok && macro.etf.sum3dM !== null && symbol === "BTCUSDT" && Math.abs(macro.etf.sum3dM) >= 300) {
    const inflow = macro.etf.sum3dM > 0;
    const m = inflow ? 1.05 : 0.95;
    mult *= isLong ? m : 2 - m; // inflow lifts longs, drags shorts (and vice versa)
    parts.push(`ETF net ${macro.etf.sum3dM >= 0 ? "+" : ""}$${Math.round(macro.etf.sum3dM)}M/3d`);
  }
  if (macro.stable.ok && macro.stable.growth7dPct !== null && Math.abs(macro.stable.growth7dPct) >= 0.2) {
    const m = macro.stable.growth7dPct > 0 ? 1.03 : 0.97;
    mult *= isLong ? m : 2 - m;
    parts.push(`stablecoin supply ${macro.stable.growth7dPct >= 0 ? "+" : ""}${macro.stable.growth7dPct}%/7d`);
  }
  return { mult: Math.round(mult * 1000) / 1000, detail: parts.length > 0 ? parts.join(" · ") : null };
}

/* ── micro helpers over klines (P2) ──────────────────────────── */

/** Amihud illiquidity z-score: mean(|ret| / usdVol) normalized to its own history. */
function amihudZ(candles: Candle[]): { z: number; last: number } | null {
  if (candles.length < 80) return null;
  const window = candles.slice(-100);
  const illiq: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1].close;
    const ret = Math.abs((window[i].close - prev) / prev);
    const usdVol = window[i].volume * window[i].close;
    if (usdVol > 0) illiq.push(ret / usdVol);
  }
  if (illiq.length < 40) return null;
  const mean = illiq.reduce((a, b) => a + b, 0) / illiq.length;
  const sd = Math.sqrt(illiq.reduce((a, b) => a + (b - mean) ** 2, 0) / illiq.length);
  if (sd <= 0) return null;
  return { z: (illiq[illiq.length - 1] - mean) / sd, last: illiq[illiq.length - 1] };
}

interface PocInfo {
  pocDistPct: number;
  inLvn: boolean;
  lvnRatio: number;
}

/** Volume-profile POC distance + low-volume-node terrain from 100 bars. */
function volumeProfile(candles: Candle[]): PocInfo | null {
  if (candles.length < 80) return null;
  const window = candles.slice(-100);
  const lo = Math.min(...window.map((c) => c.low));
  const hi = Math.max(...window.map((c) => c.high));
  if (!(hi > lo)) return null;
  const BUCKETS = 24;
  const step = (hi - lo) / BUCKETS;
  const vols = new Array<number>(BUCKETS).fill(0);
  for (const c of window) {
    const tp = (c.high + c.low + c.close) / 3;
    let idx = Math.floor((tp - lo) / step);
    idx = Math.max(0, Math.min(BUCKETS - 1, idx));
    vols[idx] += c.volume;
  }
  let pocIdx = 0;
  for (let i = 1; i < BUCKETS; i++) if (vols[i] > vols[pocIdx]) pocIdx = i;
  const poc = lo + (pocIdx + 0.5) * step;
  const price = window[window.length - 1].close;
  const meanVol = vols.reduce((a, b) => a + b, 0) / BUCKETS;
  let priceIdx = Math.floor((price - lo) / step);
  priceIdx = Math.max(0, Math.min(BUCKETS - 1, priceIdx));
  const ratio = meanVol > 0 ? vols[priceIdx] / meanVol : 1;
  return {
    pocDistPct: Math.round(Math.abs((price - poc) / poc) * 10000) / 100,
    inLvn: ratio < 0.45,
    lvnRatio: Math.round(ratio * 100) / 100,
  };
}

/* ── OBI: double-poll depth with spoof guard (P1) ────────────── */

interface ObiState {
  ema: number | null; // smoothed imbalance (bid share, 0..1)
  lastPoll: number;
  lastSample: { obi: number; maxLevelUsd: number; totalUsd: number } | null;
  unstableUntil: number;
}
const obiState = new Map<string, ObiState>();
const OBI_TTL_MS = 20_000;

interface DepthRow {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

async function depthPoll(symbol: string): Promise<DepthRow | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=20`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as DepthRow;
  } catch {
    clearTimeout(t);
    return null;
  }
}

const sideUsd = (rows: Array<[string, string]>, n: number) =>
  rows.slice(0, n).reduce((a, [p, q]) => a + parseFloat(p) * parseFloat(q), 0);

/**
 * Order-book imbalance (bid share of top-5 notional), EMA-smoothed over
 * samples, with a 1.1s-apart double-poll spoof guard: a large resting
 * level (>35% of the side) that vanishes between the two samples, or a
 * sign-flipping imbalance, marks the book unstable → no vote this round.
 */
export async function obiSmooth(symbol: string): Promise<{ obi: number; guarded: boolean } | null> {
  let st = obiState.get(symbol);
  if (!st) {
    st = { ema: null, lastPoll: 0, lastSample: null, unstableUntil: 0 };
    obiState.set(symbol, st);
  }
  if (st.lastPoll > 0 && Date.now() - st.lastPoll < OBI_TTL_MS) {
    return st.ema !== null ? { obi: st.ema, guarded: false } : null;
  }
  st.lastPoll = Date.now();
  const [d1, d2] = await Promise.all([
    depthPoll(symbol),
    (async () => {
      await new Promise((r) => setTimeout(r, 1100));
      return depthPoll(symbol);
    })(),
  ]);
  if (!d1 || !d2) return null;
  const bid1 = sideUsd(d1.bids, 5);
  const ask1 = sideUsd(d1.asks, 5);
  const bid2 = sideUsd(d2.bids, 5);
  const ask2 = sideUsd(d2.asks, 5);
  if (bid1 <= 0 || ask1 <= 0 || bid2 <= 0 || ask2 <= 0) return null;
  const obi1 = bid1 / (bid1 + ask1);
  const obi2 = bid2 / (bid2 + ask2);

  // spoof guard: flip or a mega-level vanishing between samples
  const maxBid = Math.max(...d1.bids.slice(0, 5).map(([p, q]) => parseFloat(p) * parseFloat(q)), 0);
  const maxAsk = Math.max(...d1.asks.slice(0, 5).map(([p, q]) => parseFloat(p) * parseFloat(q)), 0);
  const megaGone =
    (maxBid > (bid1 + ask1) * 0.35 && bid2 < bid1 * 0.55) || (maxAsk > (bid1 + ask1) * 0.35 && ask2 < ask1 * 0.55);
  const flipped = Math.sign(obi1 - 0.5) !== Math.sign(obi2 - 0.5) && Math.abs(obi1 - obi2) > 0.18;
  if (megaGone || flipped) {
    st.unstableUntil = Date.now() + 30_000;
    return { obi: st.ema ?? obi2, guarded: true };
  }
  if (Date.now() < st.unstableUntil) return { obi: st.ema ?? obi2, guarded: true };

  const obi = (obi1 + obi2) / 2;
  st.ema = st.ema === null ? obi : st.ema * 0.6 + obi * 0.4;
  return { obi: st.ema, guarded: false };
}

/* ── basis + top-trader fetchers (P1/P2) ─────────────────────── */

interface RawBasis {
  indexPrice: string;
  contractPrice: string;
  basisRate: string;
  timestamp: number;
}

export async function basisRead(symbol: string): Promise<{ now: number; mean1h: number } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    // NOTE: /futures/data/basis requires `pair` (the base pair, = symbol for
    // USDT-M perpetuals) — passing `symbol` returns a VALIDATION error.
    const res = await fetch(`https://fapi.binance.com/futures/data/basis?pair=${symbol}&contractType=PERPETUAL&period=5m&limit=12`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as RawBasis[];
    if (!Array.isArray(rows) || rows.length < 6) return null;
    const rates = rows.map((r) => parseFloat(r.basisRate) * 100); // → %
    const now = rates[rates.length - 1];
    const mean1h = rates.reduce((a, b) => a + b, 0) / rates.length;
    return { now, mean1h };
  } catch {
    return null;
  }
}

interface RawRatio {
  longShortRatio: string;
  longAccount: string;
  timestamp: number;
}

export async function topTraderPositionRatio(symbol: string): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=5m&limit=3`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as RawRatio[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return parseFloat(rows[rows.length - 1].longShortRatio);
  } catch {
    return null;
  }
}

/* ── last measured stacks (UI feed) ────────────────────────────
 * L1: in-memory map (same-graph consumers). L2: EngineSetting
 * "research_stacks" written through (throttled) — the API route and the
 * engine live in SEPARATE Turbopack module graphs in dev, so the DB is the
 * only reliable shared store. Bonus: stacks survive restarts. */

export interface LastStackEntry {
  ts: number;
  direction: "LONG" | "SHORT";
  stack: ResearchStack;
}
export const lastStacks = new Map<string, LastStackEntry>();

const STACKS_KEY = "research_stacks";
const STACKS_MAX = 12;
const STACK_WRITE_TTL_MS = 45_000;
let lastStackWriteAt = 0;

export async function persistStacks(): Promise<void> {
  const now = Date.now();
  if (now - lastStackWriteAt < STACK_WRITE_TTL_MS) return;
  lastStackWriteAt = now;
  try {
    const entries = [...lastStacks.entries()]
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, STACKS_MAX)
      .map(([symbol, e]) => ({
        symbol,
        ts: e.ts,
        direction: e.direction,
        stack: e.stack.score,
        suppress: e.stack.suppress,
        macroMult: e.stack.macroMult,
        macroDetail: e.stack.macroDetail,
        votes: e.stack.votes,
      }));
    const value = JSON.stringify(entries);
    await db.engineSetting.upsert({
      where: { key: STACKS_KEY },
      create: { key: STACKS_KEY, value },
      update: { value },
    });
  } catch {
    /* persistence advisory */
  }
}

/** Measured stacks for the UI route (DB-backed — cross-graph safe).
 * Always reads the DB: the engine graph refreshes it on every stack change
 * (throttled 45s), so this stays fresh regardless of module graph isolation. */
export async function loadPersistedStacks(): Promise<Array<{ symbol: string; ts: number; direction: "LONG" | "SHORT"; stack: number; suppress: string | null; macroMult: number; macroDetail: string | null; votes: ResearchVote[] }>> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: STACKS_KEY } });
    if (!row) return [];
    return JSON.parse(row.value) as Array<{
      symbol: string; ts: number; direction: "LONG" | "SHORT"; stack: number; suppress: string | null; macroMult: number; macroDetail: string | null; votes: ResearchVote[];
    }>;
  } catch {
    return [];
  }
}

/* ── the stack ───────────────────────────────────────────────── */

export interface ResearchInput {
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string; // MOMENTUM | BREAKOUT | MEAN-REVERT | AI-SCALP | AI-SWING
  metrics: FlowMetrics; // base flow fetch (already measured upstream)
  price: number; // current measured price
  candles: Candle[] | null; // 15m klines for amihud/volume-profile
  price1hPct: number;
}

export async function assessResearchStack(input: ResearchInput): Promise<ResearchStack> {
  const { symbol, direction, strategy, metrics, price, candles, price1hPct } = input;
  const isLong = direction === "LONG";
  const along = (pts: number) => (isLong ? pts : -pts);
  const settings = await getResearchSettings();
  const on = (id: ResearchId) => settings.enabled[id] !== false;
  const votes: ResearchVote[] = [];
  let suppress: string | null = null;

  // NOTE: taker ratio z (P0) is computed in flow.ts where the raw 12-bucket
  // series is available — its vote is pushed onto this stack there via
  // takerZVote().

  // ── P0 cvd_real_divergence — REAL tape from trade-service ──
  if (on("cvd_real_divergence")) {
    try {
      const tape = await getTape(symbol);
      if (tape) {
        if (tape.divergence) {
          const d = tape.divergence;
          const label = d.type.replace("_", " ").toLowerCase();
          const bull = d.type.endsWith("BULL");
          // classic divergence = behavior change (tradeable); hidden = continuation
          const classic = d.type.startsWith("CLASSIC");
          const agrees = isLong === bull;
          const v = classic ? (agrees ? 3 : -3) : agrees ? 1.5 : -1.5;
          votes.push({
            id: "cvd_real_divergence",
            label: "CVD REAL · divergence",
            vote: along(v),
            value: `${d.type} ${d.strengthPct.toFixed(2)}%`,
            detail: `real tape: ${label} — ${classic ? (agrees ? "price/CVD behavior change supports the trade" : "divergence fights the trade") : agrees ? "absorption pattern confirms trend continuation" : "absorption pattern against the trade"} (CVD 15m ${tape.cvd15mPct >= 0 ? "+" : ""}${tape.cvd15mPct}%)`,
          });
        } else if (Math.abs(tape.cvd1hPct) >= 1.2) {
          // no divergence — real-CVD direction agreement bonus (±2)
          const bull = tape.cvd1hPct > 0;
          const agrees = isLong === bull;
          votes.push({
            id: "cvd_real_divergence",
            label: "CVD REAL · 1h",
            vote: along(agrees ? 2 : -2),
            value: `${tape.cvd1hPct >= 0 ? "+" : ""}${tape.cvd1hPct}% / $${Math.abs(Math.round(tape.cvd1hUsd / 1000))}K`,
            detail: `real aggTrade CVD 1h ${tape.cvd1hPct >= 0 ? "+" : ""}${tape.cvd1hPct}% of taker volume — ${agrees ? "agrees" : "disagrees"} with the candidate`,
          });
        } else {
          votes.push({
            id: "cvd_real_divergence",
            label: "CVD REAL · 1h",
            vote: 0,
            value: `${tape.cvd1hPct >= 0 ? "+" : ""}${tape.cvd1hPct}%`,
            detail: `real tape neutral (${tape.minutes}m of minute buckets, no divergence)`,
          });
        }
        // ── P2 vpin_lite — toxicity suppressor (never gives direction) ──
        if (on("vpin_lite") && tape.vpin && tape.vpin.value >= 0.55) {
          suppress = `VPIN ${tape.vpin.value.toFixed(2)} — toxic order flow (informed trading), new entries suppressed`;
          votes.push({
            id: "vpin_lite",
            label: "VPIN · toxicity",
            vote: 0,
            value: tape.vpin.value.toFixed(3),
            detail: suppress,
          });
        } else if (on("vpin_lite") && tape.vpin) {
          votes.push({
            id: "vpin_lite",
            label: "VPIN · toxicity",
            vote: 0,
            value: tape.vpin.value.toFixed(3),
            detail: `flow toxicity normal (${tape.vpin.buckets} volume buckets) — no suppression`,
          });
        }
      } else {
        votes.push({
          id: "cvd_real_divergence",
          label: "CVD REAL",
          vote: 0,
          value: "—",
          detail: "real tape warming or unreachable (trade-service) — no numbers invented",
        });
      }
    } catch {
      votes.push({ id: "cvd_real_divergence", label: "CVD REAL", vote: 0, value: "—", detail: "tape probe failed" });
    }
  }

  // ── P1 obi_smooth — spoof-guarded book imbalance ──
  if (on("obi_smooth")) {
    try {
      const obi = await obiSmooth(symbol);
      if (obi) {
        const bidHeavy = obi.obi >= 0.62;
        const askHeavy = obi.obi <= 0.38;
        const v = bidHeavy ? 2 : askHeavy ? -2 : 0;
        votes.push({
          id: "obi_smooth",
          label: "OBI top-5",
          vote: v === 0 ? 0 : along(v),
          value: obi.obi.toFixed(3),
          detail: obi.guarded
            ? `book churn detected — spoof guard active, sample skipped (last good imbalance ${(obi.obi * 100).toFixed(1)}% bid share)`
            : bidHeavy
              ? `book ${(obi.obi * 100).toFixed(1)}% bid share (smoothed) — resting demand`
              : askHeavy
                ? `book ${(obi.obi * 100).toFixed(1)}% bid share (smoothed) — resting supply`
                : `book balanced (${(obi.obi * 100).toFixed(1)}% bid share, smoothed)`,
        });
      } else {
        votes.push({ id: "obi_smooth", label: "OBI top-5", vote: 0, value: "—", detail: "depth probe unavailable" });
      }
    } catch {
      votes.push({ id: "obi_smooth", label: "OBI top-5", vote: 0, value: "—", detail: "depth probe failed" });
    }
  }

  // ── P1 basis — perp/spot dislocation ──
  if (on("basis")) {
    const b = await basisRead(symbol);
    if (b) {
      const persistentPremium = b.mean1h > 0.008 && b.now > 0.004;
      const dislocation = b.now < -0.004;
      let v = 0;
      if (persistentPremium) v = 2;
      else if (dislocation) v = -2.5;
      votes.push({
        id: "basis",
        label: "BASIS",
        vote: v === 0 ? 0 : along(v),
        value: `${b.now >= 0 ? "+" : ""}${b.now.toFixed(3)}%`,
        detail:
          persistentPremium
            ? `perp premium +${b.now.toFixed(3)}% (1h mean +${b.mean1h.toFixed(3)}%) — healthy leveraged demand`
            : dislocation
              ? `perp trades BELOW index (${b.now.toFixed(3)}%, 1h ${b.mean1h.toFixed(3)}%) — distrust/stress`
              : `basis ${b.now.toFixed(3)}% neutral (1h mean ${b.mean1h.toFixed(3)}%)`,
      });
    } else {
      votes.push({ id: "basis", label: "BASIS", vote: 0, value: "—", detail: "basis series unavailable" });
    }
  }

  // ── P1 liq_magnets — REAL forceOrder clusters near price ──
  if (on("liq_magnets")) {
    try {
      const snap = await getLiquidationSnapshot();
      const mags = (snap as { magnets?: Record<string, Array<{ price: number; usd: number }>> } | null)?.magnets?.[symbol];
      if (mags && mags.length > 0 && price > 0) {
        const near = mags
          .map((m) => ({ ...m, distPct: ((m.price - price) / price) * 100 }))
          .filter((m) => Math.abs(m.distPct) <= 0.35 && m.usd >= 100_000)
          .sort((a, b) => b.usd - a.usd)[0];
        if (near) {
          const above = near.distPct > 0;
          const usdStr = near.usd >= 1e6 ? `$${(near.usd / 1e6).toFixed(2)}M` : `$${Math.round(near.usd / 1000)}K`;
          votes.push({
            id: "liq_magnets",
            label: "LIQ MAGNET",
            vote: along(above ? 1 : -1), // price is pulled toward the cluster
            value: `${usdStr} @ ${near.distPct >= 0 ? "+" : ""}${near.distPct.toFixed(2)}%`,
            detail: `REAL liquidation cluster ${usdStr} ${above ? "above" : "below"} spot (forceOrder density) — sweep magnet ${above ? "up" : "down"}`,
          });
        } else {
          votes.push({ id: "liq_magnets", label: "LIQ MAGNET", vote: 0, value: "clear", detail: "no ≥$100K cluster within 0.35%" });
        }
      } else {
        votes.push({ id: "liq_magnets", label: "LIQ MAGNET", vote: 0, value: "—", detail: mags ? "clusters below threshold" : "no real liquidation density (feed warming or quiet)" });
      }
    } catch {
      votes.push({ id: "liq_magnets", label: "LIQ MAGNET", vote: 0, value: "—", detail: "magnet probe failed" });
    }
  }

  // ── P2 amihud_z + vp_poc_distance — klines-only factors ──
  if (on("amihud_z") && candles) {
    const a = amihudZ(candles);
    if (a) {
      const thin = a.z >= 2;
      const deep = a.z <= -1.5;
      votes.push({
        id: "amihud_z",
        label: "AMIHUD",
        vote: thin ? along(-1) : deep ? along(1) : 0,
        value: `z ${a.z >= 0 ? "+" : ""}${a.z.toFixed(1)}`,
        detail: thin
          ? `illiquidity z +${a.z.toFixed(1)} — thin tape, price impact per dollar elevated (momentum discounted)`
          : deep
            ? `illiquidity z ${a.z.toFixed(1)} — deep market, moves carry real flow`
            : `illiquidity z ${a.z.toFixed(1)} — normal liquidity regime`,
      });
    }
  }
  if (on("vp_poc_distance") && candles) {
    const vp = volumeProfile(candles);
    if (vp) {
      votes.push({
        id: "vp_poc_distance",
        label: "VP POC",
        vote: vp.inLvn ? along(1) : 0,
        value: `${vp.pocDistPct.toFixed(2)}%${vp.inLvn ? " · LVN" : ""}`,
        detail: vp.inLvn
          ? `price sits in a low-volume node (bucket ${Math.round(vp.lvnRatio * 100)}% of mean volume) — breakout terrain, moves accelerate`
          : `POC magnet ${vp.pocDistPct.toFixed(2)}% away — value area gravity`,
      });
    }
  }

  // ── P2 top_trader_spread — smart vs retail positioning ──
  if (on("top_trader_spread")) {
    const top = await topTraderPositionRatio(symbol);
    if (top !== null && metrics.crowdLongShort > 0) {
      const retailLong = metrics.crowdLongShort >= 1.6;
      const retailShort = metrics.crowdLongShort <= 0.7;
      const smartBull = top >= 1.15;
      const smartBear = top <= 0.85;
      const divergence = (retailLong && smartBear) || (retailShort && smartBull);
      if (divergence) {
        // crowd one way, top traders the other — follow the smart side (contrarian)
        const smartBullish = retailShort && smartBull;
        votes.push({
          id: "top_trader_spread",
          label: "SMART/RETAIL",
          vote: along(smartBullish ? 2 : -2),
          value: `top ${top.toFixed(2)} vs retail ${metrics.crowdLongShort.toFixed(2)}`,
          detail: `positioning split — top traders ${top.toFixed(2)} L/S vs retail accounts ${metrics.crowdLongShort.toFixed(2)} — following the institutional side`,
        });
      } else {
        votes.push({
          id: "top_trader_spread",
          label: "SMART/RETAIL",
          vote: 0,
          value: `top ${top.toFixed(2)} vs retail ${metrics.crowdLongShort.toFixed(2)}`,
          detail: "top-trader and retail positioning aligned — no split signal",
        });
      }
    } else {
      votes.push({ id: "top_trader_spread", label: "SMART/RETAIL", vote: 0, value: "—", detail: "positioning ratios unavailable" });
    }
  }

  // ── P3 macro bias (daily-cached) ──
  await Promise.all([refreshEtfFlows(), refreshStablecoin()]);
  const mb = macroBias(symbol, direction);
  const macroVotes: ResearchVote[] = [];
  if (mb.detail) {
    macroVotes.push({
      id: macro.etf.ok && symbol === "BTCUSDT" && Math.abs(macro.etf.sum3dM ?? 0) >= 300 ? "etf_flow_bias" : "stablecoin_bias",
      label: "MACRO BIAS",
      vote: 0, // applied as multiplier, not a vote
      value: `×${mb.mult.toFixed(2)}`,
      detail: `macro flow bias — ${mb.detail}`,
    });
  } else {
    macroVotes.push({
      id: "etf_flow_bias",
      label: "MACRO BIAS",
      vote: 0,
      value: "×1.00",
      detail: !macro.etf.ok && !macro.stable.ok ? "macro sources down — neutral bias (honest)" : "macro flows neutral",
    });
  }
  votes.push(...macroVotes);

  const stackScore = Math.round(clamp(votes.reduce((a, v) => a + v.vote, 0), -12, 12) * 10) / 10;
  return { score: stackScore, votes, suppress, macroMult: mb.mult, macroDetail: mb.detail };
}

/* ── taker z-score vote (P0) — raw series lives in flow.ts ───── */

/** Push the taker-ratio z vote from flow.ts (which owns the raw 12-bucket series). */
export function takerZVote(ratios: number[]): { z: number; vote: number } | null {
  if (ratios.length < 8) return null;
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const sd = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length);
  if (sd <= 0) return null;
  const z = (ratios[ratios.length - 1] - mean) / sd;
  const vote = z >= 1.6 ? 3 : z <= -1.6 ? -3 : 0;
  return { z: Math.round(z * 100) / 100, vote };
}

/* ── LPOC quadrant (P0) — replaces the scalar OI probe ───────── */

export type LpocQuadrant = "LONG_OPENINGS" | "SHORT_CLOSURES" | "SHORT_OPENINGS" | "LONG_CLOSURES" | "NEUTRAL";

export function lpocQuadrant(oiDelta1hPct: number, price1hPct: number): { quadrant: LpocQuadrant; oiRising: boolean; oiFalling: boolean; pxUp: boolean; pxDown: boolean } {
  const oiRising = oiDelta1hPct > 0.25;
  const oiFalling = oiDelta1hPct < -0.25;
  const pxUp = price1hPct > 0.15;
  const pxDown = price1hPct < -0.15;
  let quadrant: LpocQuadrant = "NEUTRAL";
  if (pxUp && oiRising) quadrant = "LONG_OPENINGS";
  else if (pxUp && oiFalling) quadrant = "SHORT_CLOSURES";
  else if (pxDown && oiRising) quadrant = "SHORT_OPENINGS";
  else if (pxDown && oiFalling) quadrant = "LONG_CLOSURES";
  return { quadrant, oiRising, oiFalling, pxUp, pxDown };
}

/** One-time audit event that the research stack is live (called from engine tick). */
let announced = false;
export async function announceResearchStack(version: string, impactScale: number): Promise<void> {
  if (announced) return;
  announced = true;
  try {
    await db.signalEvent.create({
      data: {
        signalId: null,
        symbol: null,
        type: "ENGINE",
        level: "ai",
        message: `RESEARCH STACK v4.7 armed — 12 evidence-ranked factors from the deep-research round (LPOC quadrant · taker z · real-CVD divergence · per-strategy funding · spoof-guarded OBI · basis · liq magnets · VPIN suppressor · Amihud · smart/retail split · POC terrain · ETF+stablecoin macro bias) — impact scale ×${impactScale} · ${version}`,
      },
    });
  } catch {
    /* audit is advisory */
  }
}
