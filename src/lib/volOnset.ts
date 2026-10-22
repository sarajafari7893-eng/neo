// ── VOL-ONSET · eruption-bar onset detector (v1 rebuilt 2026-09-07) ──
// Research finding (2026-09-06 session): the |Δ24h| Top-movers board is a
// LAGGING view — by the time a symbol tops the board the move is 6–16h old.
// The LEADING pattern is the "eruption bar": a single 15m candle whose
// |return| ≥ 5× the trailing-24h median |return|. Measured lead: 6–16h
// before board entry; fwd-6h same-direction drift +10.7% avg on 3/3 samples.
//
// CONTRACT (calibration audit 2026-09-06): VOL-ONSET is TELEMETRY ONLY.
// It tags signals + votes 0 in the factor ledger. It NEVER changes score,
// thresholds, sizing or any live gate until the learning loop proves an
// edge on settled outcomes (onsetTagStats).

import { db } from "./db";
import { fetchFuturesKlines, type Candle } from "./market-feed";

// ── rules (single source of truth — surfaced in /api/vol-onset) ──
export const ONSET_RULES = {
  tfMinutes: 15, // 15m bars
  eruptionMult: 5, // |ret| ≥ 5× trailing median = eruption bar
  trailingBars: 96, // 24h of 15m bars — search + median window
  hotMinutes: 90, // eruption fresher than this + conditions = HOT
  minBars: 110, // below this: not enough tape, return null
  halfLifeMin: 180, // recency decay half-life in the score
  tickWindowHours: 50, // DB tick history window (~200 bars incl. baseline)
} as const;

export interface OnsetCore {
  eruptionAt: number;
  minutesSince: number;
  direction: 1 | -1; // 1 = up-eruption, -1 = down-eruption
  eruptRetPct: number; // eruption bar close-to-close return (signed %)
  displacementX: number; // |ret| / trailing median |ret|
  preRangePct: number; // 0–1 percentile of pre-eruption warmth (range vs baseline)
  preSlope: number; // %/bar drift of the 8 bars before eruption
  followThroughPct: number; // post-eruption drift in eruption direction (%, + = same)
}

export interface OnsetRow {
  symbol: string;
  score: number;
  hot: boolean;
  minutesSince: number;
  direction: "UP" | "DOWN";
  displacementX: number;
  eruptRetPct: number;
  followThroughPct: number;
  source: "kline" | "ticks";
}

export interface OnsetTag {
  hot: boolean;
  tag: string; // "VOL-ONSET↑" | "VOL-ONSET↓" — direction carried for post-stratified learning
  score: number;
  minutesSince: number;
  direction: "UP" | "DOWN";
  detail: string;
}

export interface OnsetTagStatsGroup {
  n: number;
  wins: number;
  winRatePct: number | null;
  avgNetPct: number | null;
  totalNetUsd: number;
}

// ── tick → 15m candle resampling ────────────────────────────────
export function resampleTicks(points: Array<{ t: number; p: number }>, tfMs = ONSET_RULES.tfMinutes * 60_000): Candle[] {
  const out: Candle[] = [];
  let bucket = -1;
  let cur: Candle | null = null;
  for (const pt of points) {
    const b = Math.floor(pt.t / tfMs);
    if (b !== bucket) {
      if (cur) out.push(cur);
      bucket = b;
      cur = { openTime: b * tfMs, open: pt.p, high: pt.p, low: pt.p, close: pt.p, volume: 0 };
    } else if (cur) {
      cur.high = Math.max(cur.high, pt.p);
      cur.low = Math.min(cur.low, pt.p);
      cur.close = pt.p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ── helpers ─────────────────────────────────────────────────────
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function percentileRank(xs: number[], v: number): number {
  if (xs.length === 0) return 0.5;
  let below = 0;
  for (const x of xs) if (x <= v) below++;
  return below / xs.length;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// ── core detection ──────────────────────────────────────────────
/**
 * Scan a candle series for the first eruption bar inside the trailing
 * 24h window. `bars` should span ≥ 50h (~200 bars): the trailing 96-bar
 * window is the search space, the older tail is the percentile baseline.
 */
export function detectOnset(bars: Candle[], nowMs: number = Date.now()): OnsetCore | null {
  if (!bars || bars.length < ONSET_RULES.minBars) return null;
  const TRAIL = ONSET_RULES.trailingBars;
  const window = bars.slice(-TRAIL);
  const baseline = bars.slice(0, Math.max(0, bars.length - TRAIL));
  if (window.length < TRAIL) return null;

  // median |return| across the trailing window (robust to the eruption itself)
  const absRets = window.map((b, i) => (i === 0 ? 0 : Math.abs((b.close - window[i - 1]!.close) / window[i - 1]!.close) * 100));
  const med = median(absRets.slice(1));
  if (!(med > 0)) return null;

  // first eruption bar in the window
  let idx = -1;
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const b = window[i]!;
    const ret = ((b.close - prev.close) / prev.close) * 100;
    if (Math.abs(ret) >= ONSET_RULES.eruptionMult * med) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;

  const erupt = window[idx]!;
  const prevClose = window[idx - 1]!.close;
  const eruptRetPct = ((erupt.close - prevClose) / prevClose) * 100;
  const direction: 1 | -1 = eruptRetPct >= 0 ? 1 : -1;
  const displacementX = Math.abs(eruptRetPct) / med;
  const minutesSince = Math.max(0, Math.round((nowMs - erupt.openTime) / 60_000));

  // pre-eruption warmth: mean range% of the 8 bars before the eruption,
  // ranked against the baseline distribution ("eruptions start warm,
  // not from dead squeezes" — 2026-09-06 finding: 28–85th pct)
  const preBars = bars.slice(Math.max(0, bars.indexOf(erupt) - 8), bars.indexOf(erupt));
  const preRanges = preBars.map((b) => ((b.high - b.low) / b.close) * 100);
  const baseRanges = baseline.map((b) => ((b.high - b.low) / b.close) * 100);
  const preRangePct = preRanges.length ? percentileRank(baseRanges, median(preRanges)) : 0.5;

  // pre-eruption slope (%/bar over the same 8 bars)
  let preSlope = 0;
  if (preBars.length >= 2) {
    const first = preBars[0]!;
    const last = preBars[preBars.length - 1]!;
    preSlope = ((last.close - first.close) / first.close) * 100 / (preBars.length - 1);
  }

  // follow-through: drift since the eruption bar close, in eruption direction
  const last = window[window.length - 1]!;
  const rawFt = ((last.close - erupt.close) / erupt.close) * 100;
  const followThroughPct = rawFt * direction;

  return { eruptionAt: erupt.openTime, minutesSince, direction, eruptRetPct, displacementX, preRangePct, preSlope, followThroughPct };
}

// ── scoring (0–100) ─────────────────────────────────────────────
// displacement 40 · recency 30 (half-life 180m) · follow-through 20
// (counter-direction ×0.35 penalty) · warming 10 (pre-range percentile)
export function onsetScoreOf(core: OnsetCore): number {
  const displacement = 40 * clamp01((core.displacementX - 1) / 9);
  const recency = 30 * Math.pow(0.5, core.minutesSince / ONSET_RULES.halfLifeMin);
  const ftRatio = clamp01(core.followThroughPct / Math.max(Math.abs(core.eruptRetPct), 0.3));
  let followThrough = 20 * ftRatio;
  if (core.followThroughPct < 0) followThrough = 20 * 0.35 * clamp01(Math.abs(core.followThroughPct) / Math.max(Math.abs(core.eruptRetPct), 0.3));
  const inWarmBelt = core.preRangePct >= 0.28 && core.preRangePct <= 0.85;
  const warming = 10 * (inWarmBelt ? 1 : 0.45);
  return Math.round(Math.min(100, Math.max(0, displacement + recency + followThrough + warming)));
}

// HOT = fresh + violent + not (yet) strongly retraced
export function isHot(core: OnsetCore): boolean {
  return (
    core.minutesSince <= ONSET_RULES.hotMinutes &&
    core.displacementX >= ONSET_RULES.eruptionMult &&
    (core.followThroughPct >= 0 || Math.abs(core.followThroughPct) < 0.5)
  );
}

export function coreToTag(core: OnsetCore): OnsetTag {
  const score = onsetScoreOf(core);
  const dir = core.direction === 1 ? "UP" : "DOWN";
  const age = core.minutesSince >= 60 ? `${(core.minutesSince / 60).toFixed(1)}h` : `${core.minutesSince}m`;
  const ft = `${core.followThroughPct >= 0 ? "+" : ""}${core.followThroughPct.toFixed(1)}%`;
  // direction-aware tag (2026-09-07 forward study, n=469): UP-eruptions mean fwd6h +0.88%
  // while DOWN-eruptions mean -1.55% — the calibrator must learn them SEPARATELY.
  const tag = `VOL-ONSET${core.direction === 1 ? "↑" : "↓"}`;
  return {
    hot: isHot(core),
    tag,
    score,
    minutesSince: core.minutesSince,
    direction: dir,
    detail: `15m eruption ×${core.displacementX.toFixed(1)} ${dir.toLowerCase()} ${age} ago · follow-through ${ft} · onset ${score}/100`,
  };
}

// ── data sourcing ───────────────────────────────────────────────
async function candlesFromTicks(symbol: string, windowHours = ONSET_RULES.tickWindowHours): Promise<Candle[] | null> {
  try {
    const since = new Date(Date.now() - windowHours * 3600_000);
    const pts = await db.pricePoint.findMany({ where: { symbol, createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, select: { price: true, createdAt: true } });
    if (pts.length < ONSET_RULES.minBars * 2) return null; // need density for 15m buckets
    return resampleTicks(pts.map((p) => ({ t: p.createdAt.getTime(), p: p.price })));
  } catch {
    return null;
  }
}

/**
 * Onset tag for one symbol — kline first, DB-tick fallback. NEVER throws.
 * `candles` (engine's 15m kline cache) is used when long enough.
 */
export async function onsetTagFor(symbol: string, candles?: Candle[] | null): Promise<OnsetTag | null> {
  try {
    let bars: Candle[] | null = null;
    let source: OnsetRow["source"] = "kline";
    if (candles && candles.length >= ONSET_RULES.minBars) {
      bars = candles;
    } else {
      try {
        bars = await fetchFuturesKlines(symbol, "15m", 220);
      } catch {
        bars = null;
      }
    }
    if (!bars || bars.length < ONSET_RULES.minBars) {
      bars = await candlesFromTicks(symbol);
      source = "ticks";
    }
    if (!bars) return null;
    const core = detectOnset(bars);
    if (!core) return null;
    const tag = coreToTag(core);
    void source; // per-symbol source only tracked in board rows
    return tag;
  } catch {
    return null; // contract: telemetry must never break the deploy path
  }
}

// ── v11.8 TASK-42: latest-eruption core for the RETEST GATE ─────
// detectOnset anchors on the FIRST eruption bar of the trailing 24h window
// (telemetry/reporting semantics — learning cohorts depend on it, do NOT
// change). On a pump→crash tape the pump anchors the core, the crash destroys
// its follow-through and isHot() goes false — the storm class (AGTUSDT
// 2026-10-17: 4 fade-stops into a −16%/100s intra-bar leg) slipped past the
// retest gate EVEN WHEN ARMED, for three stacked reasons: first-eruption
// anchoring, closed-bar lag, and the fade-direction exemption. The GATE asks
// a different question: "is the tape's MOST RECENT impulse leg fresh and
// unretraced?" — scan BACKWARD from the newest bar (forming bar INCLUDED:
// an intra-bar crash leg is exactly what the gate must see) for the most
// recent eruption bar within the hot window. This core feeds ONLY the engine
// retest gate (onsetGateTagFor) — telemetry, tags, board and learning stay on
// detectOnset. Never throws.
export function latestOnsetCore(bars: Candle[], nowMs: number = Date.now()): OnsetCore | null {
  try {
    if (!bars || bars.length < ONSET_RULES.minBars) return null;
    const TRAIL = ONSET_RULES.trailingBars;
    const window = bars.slice(-TRAIL);
    if (window.length < TRAIL) return null;
    const absRets = window.map((b, i) => (i === 0 ? 0 : Math.abs((b.close - window[i - 1]!.close) / window[i - 1]!.close) * 100));
    const med = median(absRets.slice(1));
    if (!(med > 0)) return null;
    const tfMs = ONSET_RULES.tfMinutes * 60_000;
    const hotCutoff = nowMs - (ONSET_RULES.hotMinutes + ONSET_RULES.tfMinutes) * 60_000;
    for (let i = window.length - 1; i >= 1; i--) {
      const b = window[i]!;
      if (b.openTime < hotCutoff) return null; // walked past the hot window — nothing fresh
      const ret = ((b.close - window[i - 1]!.close) / window[i - 1]!.close) * 100;
      if (Math.abs(ret) < ONSET_RULES.eruptionMult * med) continue;
      // most recent eruption bar (may be the FORMING bar — intra-bar legs are the storm class)
      const eruptRetPct = ret;
      const direction: 1 | -1 = eruptRetPct >= 0 ? 1 : -1;
      const minutesSince = Math.max(0, Math.round((nowMs - b.openTime) / 60_000));
      const last = window[window.length - 1]!;
      const rawFt = ((last.close - b.close) / b.close) * 100;
      const followThroughPct = rawFt * direction;
      const baseline = bars.slice(0, Math.max(0, bars.length - TRAIL));
      const idx = bars.indexOf(b);
      const preBars = bars.slice(Math.max(0, idx - 8), idx);
      const preRanges = preBars.map((c) => ((c.high - c.low) / c.close) * 100);
      const baseRanges = baseline.map((c) => ((c.high - c.low) / c.close) * 100);
      const preRangePct = preRanges.length && baseRanges.length ? percentileRank(baseRanges, median(preRanges)) : 0.5;
      let preSlope = 0;
      if (preBars.length >= 2) {
        const first = preBars[0]!;
        const lastPre = preBars[preBars.length - 1]!;
        preSlope = ((lastPre.close - first.close) / first.close) * 100 / (preBars.length - 1);
      }
      return { eruptionAt: b.openTime, minutesSince, direction, eruptRetPct, displacementX: Math.abs(eruptRetPct) / med, preRangePct, preSlope, followThroughPct };
    }
    return null;
  } catch {
    return null;
  }
}

export interface OnsetGateView {
  tag: OnsetTag; // OnsetTag-shaped view of the LATEST eruption (hot via isHot)
  core: OnsetCore;
  bars: Candle[]; // the bar series the core was computed on (engine retrace math)
}

/**
 * Onset GATE view for one symbol — same sourcing ladder as onsetTagFor
 * (engine 15m cache → kline fetch → DB-tick resample) but anchored on the
 * LATEST eruption (see latestOnsetCore). Never throws; null = no view.
 */
export async function onsetGateViewFor(symbol: string, candles?: Candle[] | null): Promise<OnsetGateView | null> {
  try {
    let bars: Candle[] | null = null;
    if (candles && candles.length >= ONSET_RULES.minBars) {
      bars = candles;
    } else {
      try {
        bars = await fetchFuturesKlines(symbol, "15m", 220);
      } catch {
        bars = null;
      }
    }
    if (!bars || bars.length < ONSET_RULES.minBars) {
      bars = await candlesFromTicks(symbol);
    }
    if (!bars) return null;
    const core = latestOnsetCore(bars);
    if (!core) return null;
    return { tag: coreToTag(core), core, bars };
  } catch {
    return null;
  }
}

// ── board (all tracked symbols, 90s cache) ──────────────────────
interface BoardCache {
  at: number;
  rows: OnsetRow[];
}
let boardCache: BoardCache | null = null;
let boardBuilding: Promise<void> | null = null;
const BOARD_TTL = 90_000;
// resilience (egress-outage lesson 2026-09-07): never let the route hang on a
// rebuild — answer with the last-good board after this deadline; the rebuild
// keeps running in the background and the next poll picks up fresh rows.
const BOARD_DEADLINE = 12_000;
const BOARD_MAX_SYMBOLS = 48;
const KLINE_CONCURRENCY = 5;

async function detectForSymbol(symbol: string): Promise<OnsetRow | null> {
  let bars: Candle[] | null = null;
  let source: OnsetRow["source"] = "kline";
  try {
    bars = await fetchFuturesKlines(symbol, "15m", 220);
  } catch {
    bars = null;
  }
  if (!bars || bars.length < ONSET_RULES.minBars) {
    bars = await candlesFromTicks(symbol);
    source = "ticks";
  }
  if (!bars) return null;
  const core = detectOnset(bars);
  if (!core) return null;
  return {
    symbol,
    score: onsetScoreOf(core),
    hot: isHot(core),
    minutesSince: core.minutesSince,
    direction: core.direction === 1 ? "UP" : "DOWN",
    displacementX: core.displacementX,
    eruptRetPct: core.eruptRetPct,
    followThroughPct: core.followThroughPct,
    source,
  };
}

async function rebuildBoard(): Promise<void> {
  try {
    const assets = await db.marketAsset.findMany({ orderBy: { volume24h: "desc" }, take: BOARD_MAX_SYMBOLS, select: { symbol: true } });
    const rows: OnsetRow[] = [];
    for (let i = 0; i < assets.length; i += KLINE_CONCURRENCY) {
      const batch = assets.slice(i, i + KLINE_CONCURRENCY).map((a) => a.symbol);
      const results = await Promise.all(batch.map((s) => detectForSymbol(s).catch(() => null)));
      for (const r of results) if (r) rows.push(r);
    }
    rows.sort((a, b) => b.score - a.score);
    // only overwrite the cache with a real result — an egress outage must not
    // replace the last-good board with an empty one
    if (rows.length > 0 || !boardCache) boardCache = { at: Date.now(), rows };
  } catch {
    /* keep last-good boardCache — never throw */
  }
}

export async function getOnsetBoard(): Promise<{ rows: OnsetRow[]; computedAt: number; fromCache: boolean }> {
  if (boardCache && Date.now() - boardCache.at < BOARD_TTL) {
    return { rows: boardCache.rows, computedAt: boardCache.at, fromCache: true };
  }
  // single-flight rebuild + deadline: the caller NEVER waits longer than
  // BOARD_DEADLINE — stale rows beat a hung upstream (2026-09-07 egress outage)
  if (!boardBuilding) boardBuilding = rebuildBoard().finally(() => { boardBuilding = null; });
  const raced = await Promise.race([
    boardBuilding.then(() => "fresh" as const),
    new Promise<"deadline">((res) => setTimeout(() => res("deadline"), BOARD_DEADLINE)),
  ]);
  if (raced === "fresh" && boardCache) {
    return { rows: boardCache.rows, computedAt: boardCache.at, fromCache: false };
  }
  return { rows: boardCache?.rows ?? [], computedAt: boardCache?.at ?? Date.now(), fromCache: true };
}

// ── learning loop: tagged vs rest on SETTLED signals ────────────
// SETTLED = TP1 | TP2 | TP3 | SL | EXPIRED | CLOSED (outcomes known)
const SETTLED_STATUSES = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] as const;

function groupStats(signals: Array<{ pnlPercent: number; marginUsd: number }>): OnsetTagStatsGroup {
  const n = signals.length;
  const wins = signals.filter((s) => s.pnlPercent > 0).length;
  const totalNetUsd = signals.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  return {
    n,
    wins,
    winRatePct: n > 0 ? Number(((wins / n) * 100).toFixed(1)) : null,
    avgNetPct: n > 0 ? Number((signals.reduce((a, s) => a + s.pnlPercent, 0) / n).toFixed(2)) : null,
    totalNetUsd: Number(totalNetUsd.toFixed(2)),
  };
}

/**
 * Post-stratified learning loop (2026-09-07 forward study): tags carry the
 * eruption direction (VOL-ONSET↑/↓), so tagged signals split into ALIGNED
 * (LONG+↑ or SHORT+↓ — deployment agrees with the eruption) vs COUNTER
 * (deployment against it) vs REST. The calibrator learns expectancy per stratum.
 */
export async function onsetTagStats(): Promise<{
  settledTotal: number;
  tagged: OnsetTagStatsGroup;
  taggedAligned: OnsetTagStatsGroup;
  taggedCounter: OnsetTagStatsGroup;
  rest: OnsetTagStatsGroup;
}> {
  try {
    const settled = await db.signal.findMany({
      where: { status: { in: [...SETTLED_STATUSES] } },
      select: { tags: true, direction: true, pnlPercent: true, marginUsd: true },
    });
    const hasTag = (t: string) => t.split(",").map((x) => x.trim()).some((x) => x.startsWith("VOL-ONSET"));
    const taggedSignals = settled.filter((s) => hasTag(s.tags));
    const restSignals = settled.filter((s) => !hasTag(s.tags));
    const aligned = taggedSignals.filter((s) =>
      (s.direction === "LONG" && s.tags.includes("VOL-ONSET↑")) ||
      (s.direction === "SHORT" && s.tags.includes("VOL-ONSET↓"))
    );
    const counter = taggedSignals.filter((s) => !aligned.includes(s));
    return {
      settledTotal: settled.length,
      tagged: groupStats(taggedSignals),
      taggedAligned: groupStats(aligned),
      taggedCounter: groupStats(counter),
      rest: groupStats(restSignals),
    };
  } catch {
    return {
      settledTotal: 0,
      tagged: groupStats([]),
      taggedAligned: groupStats([]),
      taggedCounter: groupStats([]),
      rest: groupStats([]),
    };
  }
}
