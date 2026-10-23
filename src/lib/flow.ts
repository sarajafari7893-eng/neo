// ── FlowRadar Neo order-flow module (server-only) ──
// Real Binance USDT-M flow metrics: OI delta, taker CVD, crowd L/S, funding.
// scoreFlow → ±25 along candidate direction · OI-notional weighting (v4.5)
// · in-memory per-symbol history ring for sparklines (R17).
// v10.24 Task 34-a: fapi REST now goes through the process-wide fapi-gate
// (weight budget + global ban awareness + single-flight). Telemetry lane —
// sheddable under pressure; every caller is throw/null-tolerant already.

import { gateFetch } from "./fapi-gate";
import { liquidationPressure } from "./liquidations";
import { bridgeOiHist, bridgeTape, bridgeKlines, bybit5mMove, bybitTickerRow, okx5mMove, type FlowSource } from "./flow-bridge";

const TIMEOUT_MS = 6500;
const CACHE_TTL = 150_000; // 2.5min
const STALE_GRACE = 600_000; // 10min

export interface WhalePrint5m {
  count: number;
  totalUsd: number;
  maxUsd: number;
  buyUsd: number;
  sellUsd: number;
}

export interface FlowMetrics {
  oiDelta10m: number | null;
  oiDelta1h: number | null;
  oiValueUsd: number | null;
  cvdNetBase: number | null;
  cvdNetPctOfVol: number | null;
  takerRatio: number | null;
  takerMean: number | null;
  crowdLongShort: number | null;
  crowdLongPct: number | null;
  // v6.7 SMC: topLongShortPositionRatio — POSITION sizing of the top-20% most
  // profitable trader cohort (Binance futures/data). Unlike the retail account
  // ratio (crowdLongShort), this is where size actually sits — the whale-
  // positioning read the research flagged as the missing feed.
  topLongShort: number | null;
  funding8h: number | null;
  // v6.7 SMART-MONEY (operator-approved SMC package): real USD taker flow from
  // aggTrades (side-flag m) + single-fill whale prints ≥$250K in 5m.
  cvdUsd60s: number | null;
  whalePrint5m: WhalePrint5m | null;
}

export interface FlowAssessment {
  verdict: "CONFIRMS" | "CONFLICTS" | "NEUTRAL" | "UNAVAILABLE" | "NO-DATA";
  score: number; // -25..+25 along candidate direction
  reasons: string[];
  metrics: FlowMetrics;
  oiWeight: number;
  calibrated: boolean;
  // v12.1 Task-48 ② — honest blindness telemetry: "NO-DATA" ≠ "NEUTRAL".
  // 48h audit (Task-47): 70% of deploys were flow-blind yet labelled NEUTRAL
  // as if the book said "neutral" — data absence is not a neutral read.
  coverage: number; // non-null count of the decision-relevant metrics
  blind: boolean; // coverage === 0
  /** v12.2 TASK-52 — venue that actually fed this bundle (BINANCE | SPOT-MIRROR | BYBIT | MIXED) when fapi starved. */
  source?: FlowSource | "MIXED";
}

/** Decision-relevant metric keys — cvdNetBase is structurally null in the
 *  current pipeline and excluded from coverage on purpose. */
const COVERAGE_KEYS: Array<keyof FlowMetrics> = [
  "oiDelta10m", "oiDelta1h", "oiValueUsd", "cvdNetPctOfVol", "takerRatio", "takerMean",
  "crowdLongShort", "topLongShort", "funding8h", "cvdUsd60s",
];

export function flowCoverageOf(m: FlowMetrics): number {
  return COVERAGE_KEYS.reduce((a, k) => a + (m[k] != null ? 1 : 0), 0);
}

const BLIND_CACHE_TTL = 20_000; // v12.1: all-null metrics are a STARVATION state,
// not a sample — 20s TTL instead of 2.5min so flow recovers within seconds of
// the fapi-gate ban window lifting (Task-47: blindness rode 516 ban-drops/48h).

interface FlowCacheEntry {
  at: number;
  metrics: FlowMetrics;
  blind?: boolean; // all-null starvation sample — short TTL
}

// v12.2 TASK-52 — venue that fed the last metrics bundle per symbol
const flowSrcMap = new Map<string, FlowSource | "MIXED">();

/** Honest sourcing readout — which market the current flow numbers came from. */
export function getFlowSource(symbol: string): FlowSource | "MIXED" | null {
  return flowSrcMap.get(symbol) ?? null;
}

// v12.9 MULTI-VENUE CONSENSUS — per-key 60s cache + in-flight dedupe so the
// second-venue cross-check costs at most ONE fetch per venue per minute per
// symbol on the hot path. Fail-soft: any throw → cached null → consensus
// skips (never blocks, never invents).
const consensusCache = new Map<string, { at: number; val: unknown }>();
const consensusInFlight = new Map<string, Promise<unknown>>();
async function cachedConsensusVal<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
  const hit = consensusCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return (hit.val as T | null) ?? null;
  const inflight = consensusInFlight.get(key);
  if (inflight) return (await inflight as T | null) ?? null;
  const p = (async () => {
    let val: T | null = null;
    try {
      val = await fn();
    } catch {
      val = null;
    }
    consensusCache.set(key, { at: Date.now(), val });
    if (consensusCache.size > 800) {
      const oldest = consensusCache.keys().next().value;
      if (oldest) consensusCache.delete(oldest);
    }
    return val;
  })().finally(() => consensusInFlight.delete(key));
  consensusInFlight.set(key, p);
  return (await p as T | null) ?? null;
}

interface AggTrade {
  p: number;
  q: number;
  T: number;
  m: boolean; // isBuyerMaker → m=false means the TAKER bought
}

export const WHALE_PRINT_MIN_USD = 250_000;

const flowCache = new Map<string, FlowCacheEntry>();
const flowInFlight = new Map<string, Promise<FlowMetrics | null>>();

// per-symbol history ring: 1 point per FRESH sample, cap 60 (~2.5h)
const HISTORY_CAP = 60;
const flowHistory = new Map<string, Array<{ at: number; oiDelta1h: number }>>();

export function getFlowStatus(): { covered: number; lastOkAt: number | null; lastError: string | null } {
  let lastOkAt: number | null = null;
  let lastError: string | null = null;
  let covered = 0;
  for (const [, e] of flowCache) {
    if (Date.now() - e.at < STALE_GRACE) covered++;
    lastOkAt = Math.max(lastOkAt ?? 0, e.at) || null;
  }
  return { covered, lastOkAt, lastError };
}

async function fapi<T>(path: string): Promise<T> {
  const v = await gateFetch<T>(path, { priority: "telemetry", timeoutMs: TIMEOUT_MS });
  if (v === null) throw new Error(`fapi ${path} → unavailable`); // preserved throw semantics — allSettled callers treat it as partial absence
  return v;
}

export async function fetchFlowMetrics(symbol: string): Promise<FlowMetrics | null> {
  const cached = flowCache.get(symbol);
  const cachedTtl = cached?.blind ? BLIND_CACHE_TTL : CACHE_TTL;
  if (cached && Date.now() - cached.at < cachedTtl) return cached.metrics;
  if (cached && Date.now() - cached.at < STALE_GRACE && flowInFlight.has(symbol)) return cached.metrics;

  const existing = flowInFlight.get(symbol);
  if (existing) return existing;

  const p = (async (): Promise<FlowMetrics | null> => {
    try {
      const base = symbol.replace("USDT", "");
      const [oiHist, takerLS, crowd, premium, aggTrades, topPos] = await Promise.allSettled([
        fapi<Array<{ symbol: string; sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }>>(`/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=13`),
        fapi<Array<{ symbol: string; buySellRatio: string; timestamp: number }>>(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=13`),
        fapi<Array<{ symbol: string; longShortRatio: string; longAccount: string; shortAccount: string; timestamp: number }>>(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=2`),
        fapi<{ lastFundingRate: string; markPrice: string }>(`/fapi/v1/premiumIndex?symbol=${symbol}`),
        fapi<AggTrade[]>(`/fapi/v1/aggTrades?symbol=${symbol}&limit=1000`),
        fapi<Array<{ symbol: string; longShortRatio: string; timestamp: number }>>(`/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=5m&limit=2`),
      ]);

      // v12.2 TASK-52 — FLOW BRIDGE: when a fapi lane starves (ban/pool silence),
      // recover the recoverable lanes over the bridge instead of sliding into
      // blindness. Honest sourcing: the bundle records the venue that fed it.
      let flowSrc: FlowSource | "MIXED" = "BINANCE";
      const srcNote = (s: FlowSource): void => {
        if (flowSrc === "BINANCE") flowSrc = s;
        else if (flowSrc !== s) flowSrc = "MIXED";
      };

      let oi = oiHist.status === "fulfilled" ? oiHist.value : [];
      if (oi.length === 0) {
        const b = await bridgeOiHist(symbol, "5m", 13).catch(() => null);
        if (b && b.rows.length > 0) {
          oi = b.rows.map((r) => ({ symbol, sumOpenInterest: String(r.sumOpenInterest), sumOpenInterestValue: String(r.sumOpenInterestValue ?? 0), timestamp: r.timestamp }));
          srcNote(b.source);
          if (b.source === "BYBIT") {
            // bybit OI history is base-denominated only — notional from the
            // batched tickers call (measured, not invented)
            const t = await bybitTickerRow(symbol).catch(() => null);
            const lastOi = Number(oi[oi.length - 1]!.sumOpenInterest);
            const notional = t?.openInterestValue ?? (t && lastOi > 0 ? t.lastPrice * lastOi : 0);
            if (notional > 0) oi[oi.length - 1]!.sumOpenInterestValue = String(Math.round(notional));
          }
        }
      }

      const taker = takerLS.status === "fulfilled" ? takerLS.value : [];
      const crowdArr = crowd.status === "fulfilled" ? crowd.value : [];
      // crowd/top-trader L/S ratios have NO public equivalent on any other
      // venue — during a fapi starvation they stay null (honest absence).

      let prem = premium.status === "fulfilled" ? premium.value : null;
      if (!prem) {
        const t = await bybitTickerRow(symbol).catch(() => null);
        if (t && t.fundingRate !== null) {
          prem = { lastFundingRate: String(t.fundingRate), markPrice: String(t.markPrice ?? t.lastPrice) };
          srcNote("BYBIT");
        }
      }

      let oiDelta10m: number | null = null;
      let oiDelta1h: number | null = null;
      let oiValueUsd: number | null = null;
      if (oi.length >= 3) {
        const last = oi[oi.length - 1]!;
        const first = oi[0]!;
        const cur = Number(last.sumOpenInterest);
        oiValueUsd = Number(last.sumOpenInterestValue);
        oiDelta10m = first ? ((cur - Number(oi[Math.max(0, oi.length - 3)]!.sumOpenInterest)) / Number(oi[Math.max(0, oi.length - 3)]!.sumOpenInterest)) * 100 : null;
        oiDelta1h = Number(first.sumOpenInterest) > 0 ? ((cur - Number(first.sumOpenInterest)) / Number(first.sumOpenInterest)) * 100 : null;
      }

      // CVD proxy from taker ratio series: (ratio−1) averaged, weighted by recency
      let takerMean: number | null = null;
      let takerRatio: number | null = null;
      if (taker.length >= 2) {
        const ratios = taker.map((t) => Number(t.buySellRatio));
        takerRatio = ratios[ratios.length - 1]!;
        takerMean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      }

      const crowdLongShort = crowdArr.length > 0 ? Number(crowdArr[crowdArr.length - 1]!.longShortRatio) : null;
      const crowdLongPct = crowdArr.length > 0 ? Number(crowdArr[crowdArr.length - 1]!.longAccount) * 100 : null;
      const topPosArr = topPos.status === "fulfilled" ? topPos.value : [];
      const topLongShort = topPosArr.length > 0 ? Number(topPosArr[topPosArr.length - 1]!.longShortRatio) : null;
      const funding8h = prem ? Number(prem.lastFundingRate) * 100 : null;

      // v6.7: real USD taker flow + whale prints from the same aggTrades pull
      // (trades ≤1000 ≈ last minutes on liquid symbols; windows clipped by T).
      // v12.2 TASK-52: tape ladder — fapi aggTrades → BYBIT recent-trade →
      // SPOT-MIRROR trades (spot = last resort: spot flow ≠ perp flow).
      let agg = aggTrades.status === "fulfilled" ? aggTrades.value : [];
      if (agg.length === 0) {
        const b = await bridgeTape(symbol).catch(() => null);
        if (b && b.trades.length > 0) {
          agg = b.trades.map((t) => ({ p: t.price, q: t.qty, T: t.time, m: t.isBuyerMaker }));
          srcNote(b.source);
        }
      }
      const t60 = Date.now() - 60_000;
      const t300 = Date.now() - 300_000;
      let buy60 = 0;
      let sell60 = 0;
      const wp = { count: 0, totalUsd: 0, maxUsd: 0, buyUsd: 0, sellUsd: 0 };
      for (const t of agg) {
        const usd = t.p * t.q;
        if (t.T >= t60) {
          if (t.m) sell60 += usd;
          else buy60 += usd;
        }
        if (t.T >= t300 && usd >= WHALE_PRINT_MIN_USD) {
          wp.count++;
          wp.totalUsd += usd;
          if (usd > wp.maxUsd) wp.maxUsd = usd;
          if (t.m) wp.sellUsd += usd;
          else wp.buyUsd += usd;
        }
      }
      const cvdUsd60s = agg.length > 0 ? Math.round(buy60 - sell60) : null;
      const whalePrint5m: WhalePrint5m | null = wp.count > 0 ? { count: wp.count, totalUsd: Math.round(wp.totalUsd), maxUsd: Math.round(wp.maxUsd), buyUsd: Math.round(wp.buyUsd), sellUsd: Math.round(wp.sellUsd) } : null;

      // v12.2 TASK-52: when the fapi taker-ratio series is absent but a REAL
      // tape exists (bridge), the net-buy % of volume is measured from that
      // same tape — window-capped at 10min (a 1000-trade slice spanning hours
      // on an illiquid symbol is a stale read, not a flow read).
      const winStart = agg.length > 0 ? agg[0]!.T : 0;
      let buyWin = 0;
      let sellWin = 0;
      for (const t of agg) {
        const usd = t.p * t.q;
        if (t.m) sellWin += usd;
        else buyWin += usd;
      }
      const cvdFromTape = agg.length > 0 && buyWin + sellWin > 0 && winStart > 0 && Date.now() - winStart <= 600_000 ? ((buyWin - sellWin) / (buyWin + sellWin)) * 100 : null;
      const cvdNetPctOfVol = takerMean !== null ? (takerMean - 1) * 100 : cvdFromTape; // % of taker volume net buys

      const metrics: FlowMetrics = {
        oiDelta10m: oiDelta10m === null ? null : Number(oiDelta10m.toFixed(3)),
        oiDelta1h: oiDelta1h === null ? null : Number(oiDelta1h.toFixed(3)),
        oiValueUsd,
        cvdNetBase: null,
        cvdNetPctOfVol: cvdNetPctOfVol === null ? null : Number(cvdNetPctOfVol.toFixed(3)),
        takerRatio,
        takerMean,
        crowdLongShort,
        crowdLongPct,
        topLongShort: topLongShort === null ? null : Number(topLongShort.toFixed(3)),
        funding8h: funding8h === null ? null : Number(funding8h.toFixed(4)),
        cvdUsd60s,
        whalePrint5m,
      };
      const blind = flowCoverageOf(metrics) === 0;
      flowCache.set(symbol, { at: Date.now(), metrics, blind });
      flowSrcMap.set(symbol, flowSrc);

      // history ring (fresh samples only)
      if (metrics.oiDelta1h !== null) {
        const ring = flowHistory.get(symbol) ?? [];
        ring.push({ at: Date.now(), oiDelta1h: metrics.oiDelta1h });
        if (ring.length > HISTORY_CAP) ring.shift();
        flowHistory.set(symbol, ring);
      }
      return metrics;
    } catch {
      return null;
    } finally {
      flowInFlight.delete(symbol);
    }
  })();

  flowInFlight.set(symbol, p);
  return p;
}

export async function ensureFlow(symbols: string[], concurrency = 3): Promise<void> {
  const queue = [...symbols];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const s = queue.shift();
      if (s) await fetchFlowMetrics(s);
    }
  });
  await Promise.all(workers);
}

export function getFlowHistory(symbol: string): Array<{ at: number; oiDelta1h: number }> {
  return flowHistory.get(symbol) ?? [];
}

function fmtUsdShort(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

/**
 * v6.7 SMC-lite liquidity-sweep detector (operator-approved package item ⑥):
 * the last CLOSED bar trades through the prior 24-bar swing high/low but closes
 * back inside with a ≥50% rejection wick — the classic liquidity-grab print.
 * `supportive` marks whether the sweep aligns with the candidate direction.
 */
export function detectLiquiditySweep(
  candles: Array<{ high: number; low: number; close: number }> | undefined | null,
  direction: "LONG" | "SHORT"
): { swept: boolean; supportive: boolean; detail: string } {
  if (!candles || candles.length < 26) return { swept: false, supportive: false, detail: "" };
  const c = candles[candles.length - 1]!;
  const prior = candles.slice(candles.length - 25, candles.length - 1);
  const swingHigh = Math.max(...prior.map((k) => k.high));
  const swingLow = Math.min(...prior.map((k) => k.low));
  const range = c.high - c.low;
  if (range <= 0) return { swept: false, supportive: false, detail: "" };
  if (c.high > swingHigh && c.close < swingHigh && (c.high - c.close) / range >= 0.5) {
    const detail = `SMC sweep: bar traded ${(((c.high - swingHigh) / swingHigh) * 100).toFixed(2)}% above the 24-bar swing high then closed back inside (${Math.round(((c.high - c.close) / range) * 100)}% rejection wick) — buy-side liquidity grabbed`;
    return { swept: true, supportive: direction === "SHORT", detail: supportive_(detail, direction === "SHORT") };
  }
  if (c.low < swingLow && c.close > swingLow && (c.close - c.low) / range >= 0.5) {
    const detail = `SMC sweep: bar pierced ${(((swingLow - c.low) / swingLow) * 100).toFixed(2)}% below the 24-bar swing low then closed back inside (${Math.round(((c.close - c.low) / range) * 100)}% rejection wick) — sell-side liquidity grabbed`;
    return { swept: true, supportive: direction === "LONG", detail: supportive_(detail, direction === "LONG") };
  }
  return { swept: false, supportive: false, detail: "" };
}

function supportive_(detail: string, ok: boolean): string {
  return ok ? `${detail}, supports the candidate direction` : detail;
}

/** Score flow along the candidate direction → ±25 (v4.5 OI-notional weighted). */
export async function scoreFlow(symbol: string, direction: "LONG" | "SHORT", price1hAgoPct: number | null): Promise<FlowAssessment> {
  const m = await fetchFlowMetrics(symbol);
  if (!m) {
    return { verdict: "UNAVAILABLE", score: 0, reasons: ["flow metrics unavailable — no numbers invented"], metrics: { oiDelta10m: null, oiDelta1h: null, oiValueUsd: null, cvdNetBase: null, cvdNetPctOfVol: null, takerRatio: null, takerMean: null, crowdLongShort: null, crowdLongPct: null, topLongShort: null, funding8h: null, cvdUsd60s: null, whalePrint5m: null }, oiWeight: 1, calibrated: false, coverage: 0, blind: true };
  }
  const coverage = flowCoverageOf(m);
  const dir = direction === "LONG" ? 1 : -1;
  const reasons: string[] = [];
  // v12.1 Task-48 ② — HONEST NO-DATA: a fetch that completed with every
  // decision metric null (fapi ban window / budget shed) is BLINDNESS, not a
  // neutral book. The 48h census showed 70% of deploys rode this state while
  // the card read "FLOW-NEUTRAL". Blind flow never votes (score 0) but now
  // carries the NO-DATA verdict so cards, journals and gates can tell the
  // difference. (Gate on blindness = EngineSetting "flow-gate", default
  // tag-only: 10d ledger blind +$204.20 WR 57.1% vs sighted +$7.11 WR 52.8% —
  // blocking the blind cohort would have CUT +$204 of net.)
  if (coverage === 0) {
    return { verdict: "NO-DATA", score: 0, reasons: ["flow-blind — every decision metric null (fapi-gate starvation/ban window); no numbers invented, no neutral read claimed"], metrics: m, oiWeight: 1, calibrated: true, coverage: 0, blind: true };
  }
  // v12.2 TASK-52 — honest sourcing: when the bundle rode the bridge, say so
  // on the card/journal instead of silently mixing venues.
  const bridgeSrc = getFlowSource(symbol);
  if (bridgeSrc && bridgeSrc !== "BINANCE") {
    reasons.push(`flow source: ${bridgeSrc} bridge (fapi starved — flow numbers measured on the bridge venue, not Binance)`);
  }
  let raw = 0;

  // 1. CVD imbalance ±9
  if (m.cvdNetPctOfVol !== null) {
    const aligned = m.cvdNetPctOfVol * dir;
    const v = Math.max(-9, Math.min(9, aligned * 1.8));
    raw += v;
    const usdCtx = m.cvdUsd60s !== null ? ` (${m.cvdUsd60s >= 0 ? "+" : ""}$${(m.cvdUsd60s / 1000).toFixed(0)}K net taker USD/60s)` : "";
    reasons.push(`taker CVD ${m.cvdNetPctOfVol >= 0 ? "+" : ""}${m.cvdNetPctOfVol.toFixed(2)}% of taker volume ${aligned > 1 ? "agrees" : aligned < -1 ? "opposes" : "is neutral"}${usdCtx}`);
  }

  // 7. WHALE PRINTS ±5 (v6.7 SMC package): single fills ≥$250K near the entry
  // are the visible footprint of size players — aligned prints confirm, prints
  // against the thesis are distribution risk.
  if (m.whalePrint5m && m.whalePrint5m.totalUsd >= 400_000) {
    const whaleSide = m.whalePrint5m.buyUsd >= m.whalePrint5m.sellUsd ? 1 : -1;
    const aligned = whaleSide * dir;
    const desc = `${m.whalePrint5m.count} fill(s) ≥$250K totaling $${(m.whalePrint5m.totalUsd / 1000).toFixed(0)}K in 5m (max $${(m.whalePrint5m.maxUsd / 1000).toFixed(0)}K, ${m.whalePrint5m.buyUsd >= m.whalePrint5m.sellUsd ? "buy" : "sell"}-side dominant)`;
    if (aligned > 0) {
      raw += 5;
      reasons.push(`WHALE PRINTS ${desc} — pressing WITH the ${direction.toLowerCase()} thesis (smart-money participation)`);
    } else {
      raw -= 5;
      reasons.push(`WHALE PRINTS ${desc} — pressing AGAINST the ${direction.toLowerCase()} thesis (distribution risk)`);
    }
  }

  // 2. OI × price matrix ±7
  if (m.oiDelta1h !== null && price1hAgoPct !== null) {
    const priceDir = price1hAgoPct * dir; // >0: price moving in candidate's favor
    const oiUp = m.oiDelta1h > 0;
    if (priceDir > 0 && oiUp) {
      raw += 7;
      reasons.push(`new positions conviction — price ${price1hAgoPct >= 0 ? "+" : ""}${price1hAgoPct.toFixed(2)}%/1h with OI ${m.oiDelta1h >= 0 ? "+" : ""}${m.oiDelta1h.toFixed(2)}%/1h (fresh ${direction.toLowerCase()}s pressing)`);
    } else if (priceDir > 0 && !oiUp) {
      raw += 2;
      reasons.push(`short-covering style move — OI unwinding ${m.oiDelta1h.toFixed(2)}%/1h while price drifts favorably`);
    } else if (priceDir < 0 && oiUp) {
      raw -= 7;
      reasons.push(`opposing new positions — OI ${m.oiDelta1h.toFixed(2)}%/1h building against the ${direction.toLowerCase()} thesis`);
    } else {
      raw -= 2;
      reasons.push(`capitulation washout pattern — OI and price both unwinding`);
    }
  }

  // 3. REAL liquidation cascade (R16) — exhaustion logic ±3
  const liq = await liquidationPressure(symbol);
  if (liq) {
    if (liq.usd10m >= 400_000) {
      const sideWrecked = direction === "LONG" ? liq.longsUsd10m : liq.shortsUsd10m;
      if (sideWrecked > liq.usd10m * 0.6) {
        raw += 3;
        reasons.push(`REAL liquidation cascade: ${fmtUsdShort(liq.usd10m)} wrecked in 10m — ${direction === "LONG" ? "longs" : "shorts"} flushed (forceOrder), exhaustion tailwind`);
      } else {
        raw -= 1;
        reasons.push(`cascade ${fmtUsdShort(liq.usd10m)} in 10m hit the opposing side — momentum risk`);
      }
    } else {
      reasons.push(`no material liquidation cascade (${fmtUsdShort(liq.usd10m)} in 10m)`);
    }
  }

  // 4. Funding contrarian ±5
  if (m.funding8h !== null) {
    if (m.funding8h > 0.05) {
      const v = dir > 0 ? -5 : 5;
      raw += v;
      reasons.push(`funding ${m.funding8h.toFixed(4)}%/8h — crowded longs pay, contrarian edge`);
    } else if (m.funding8h < -0.05) {
      const v = dir > 0 ? 5 : -5;
      raw += v;
      reasons.push(`funding ${m.funding8h.toFixed(4)}%/8h — shorts pay, squeeze fuel for longs`);
    } else reasons.push(`funding ${m.funding8h.toFixed(4)}%/8h — neutral carry`);
  }

  // 5. Crowd positioning ±4
  if (m.crowdLongShort !== null) {
    if (m.crowdLongShort > 2.2) {
      raw += dir > 0 ? -4 : 4;
      reasons.push(`retail crowd ${m.crowdLongShort.toFixed(2)}:1 long — fade risk on longs`);
    } else if (m.crowdLongShort < 0.5) {
      raw += dir > 0 ? 4 : -4;
      reasons.push(`retail crowd ${m.crowdLongShort.toFixed(2)}:1 (heavy shorts) — contrarian tailwind for longs`);
    }
  }

  // 5b. TOP-TRADER positioning ±4 (v6.7 SMC): the top-20% cohort's POSITION
  // sizing — where size actually sits. Extremes fade; a top-vs-retail DIVERGENCE
  // (smart money leaning where the crowd is not) adds a +2 alignment bonus.
  if (m.topLongShort !== null) {
    if (m.topLongShort > 2) {
      raw += dir > 0 ? -4 : 4;
      reasons.push(`top traders ${m.topLongShort.toFixed(2)}:1 net-LONG by position size — crowded smart-money side, fade risk on longs`);
    } else if (m.topLongShort < 0.5) {
      raw += dir > 0 ? 4 : -4;
      reasons.push(`top traders ${m.topLongShort.toFixed(2)}:1 net-SHORT by position size — crowded smart-money side, tailwind against longs`);
    }
    if (m.crowdLongShort !== null && ((m.crowdLongShort > 1.5 && m.topLongShort < 0.8) || (m.crowdLongShort < 0.7 && m.topLongShort > 1.5))) {
      const smartSide = m.topLongShort > 1 ? 1 : -1;
      raw += smartSide === dir ? 2 : -2;
      reasons.push(`top-vs-retail divergence: crowd ${m.crowdLongShort.toFixed(2)}:1 vs top traders ${m.topLongShort.toFixed(2)}:1 — size sits with the ${smartSide === 1 ? "longs" : "shorts"}`);
    }
  }

  // 6. Taker acceleration ±5
  if (m.takerRatio !== null && m.takerMean !== null) {
    const accel = m.takerRatio - m.takerMean;
    const aligned = accel * dir;
    if (Math.abs(aligned) > 0.06) {
      raw += Math.max(-5, Math.min(5, aligned * 40));
      reasons.push(`taker buy/sell ${m.takerRatio.toFixed(3)} vs mean ${m.takerMean.toFixed(3)} — ${aligned > 0 ? "accelerating in favor" : "decelerating"}`);
    }
  }

  // OI-notional weighting (v4.5): deep books trusted more
  const oiWeight = m.oiValueUsd ? Math.max(0.5, Math.min(1.2, Math.sqrt(m.oiValueUsd / 50_000_000))) : 1;
  let score = Math.round(Math.max(-25, Math.min(25, raw * oiWeight)));
  if (Math.abs(oiWeight - 1) >= 0.15) reasons.push(`flow weighted ×${oiWeight.toFixed(2)} by OI notional ${fmtUsdShort(m.oiValueUsd ?? 0)} — deep-book flow trusted`);

  // ── v12.9 MULTI-VENUE CONSENSUS (AUDIT-NX3046-20261023, operator mandate
  // «باید از تمام صرافی‌ها مخصوصاً BINANCE تیکت گرفته بشه») ──
  // The bundle rode ONE venue's tape; nothing ever asked a SECOND venue
  // whether the tape agrees. NX-3046: BYBIT-only JCT showed CVD +18.5%
  // OPPOSING the short and OI unwinding — the bundle still rode neutral, and
  // no other venue was consulted. Now: the primary venue's 15m-window
  // (4×5m-bar) direction is compared against an INDEPENDENT second venue
  // (BYBIT-tape → OKX cross-check; Binance/SPOT-MIRROR-tape → BYBIT
  // cross-check). Sign-opposed moves diverging >1.5% clamp conviction to ±6
  // (below the ±8 CONFIRMS/CONFLICTS line) — cross-venue conflict can never
  // confirm a deploy. 60s per-symbol caches + in-flight dedupe keep the hot
  // path cheap; any fetch failure fails OPEN (consensus simply does not run,
  // no numbers invented). Single-venue coins (second rung null) are handled
  // by the engine-side SINGLE-VENUE deploy block.
  const consensusSrc = bridgeSrc ?? null;
  if (consensusSrc) {
    try {
      const pri = await cachedConsensusVal(`PRI5M|${symbol}`, 60_000, async () => {
        const r = await bridgeKlines(symbol, "5m", 4).catch(() => null);
        if (!r || r.rows.length < 4) return null;
        const o = r.rows[0]!.open, c = r.rows[r.rows.length - 1]!.close;
        return { move: o > 0 && c > 0 ? ((c - o) / o) * 100 : null, source: r.source as string };
      });
      const priMove = pri?.move ?? null;
      let secondName: string | null = null;
      let secondMove: number | null = null;
      if (consensusSrc === "BYBIT") {
        secondName = "OKX";
        secondMove = await cachedConsensusVal(`OKX5M|${symbol}`, 60_000, () => okx5mMove(symbol));
      } else if (consensusSrc === "BINANCE" || consensusSrc === "SPOT-MIRROR" || consensusSrc === "MIXED") {
        secondName = "BYBIT";
        secondMove = await cachedConsensusVal(`BYB5M|${symbol}`, 60_000, () => bybit5mMove(symbol));
      }
      if (priMove !== null && secondName && secondMove !== null) {
        const disagree = Math.sign(priMove) !== Math.sign(secondMove) && Math.abs(priMove - secondMove) > 1.5;
        if (disagree) {
          score = Math.max(-6, Math.min(6, score));
          reasons.push(`MULTI-VENUE DISAGREE: primary ${consensusSrc} 15m-window ${priMove >= 0 ? "+" : ""}${priMove.toFixed(2)}% vs ${secondName} ${secondMove >= 0 ? "+" : ""}${secondMove.toFixed(2)}% — cross-venue tapes conflict, conviction clamped ±6, cannot CONFIRM (operator mandate: confirmation from all venues, especially Binance — v12.9)`);
        } else if (Math.sign(priMove) === Math.sign(secondMove) && Math.abs(priMove - secondMove) <= 1.5) {
          reasons.push(`MULTI-VENUE AGREE: primary ${consensusSrc} ${priMove >= 0 ? "+" : ""}${priMove.toFixed(2)}% ≈ ${secondName} ${secondMove >= 0 ? "+" : ""}${secondMove.toFixed(2)}% over 15m — cross-venue tape concordant (v12.9)`);
        }
      }
    } catch {
      /* fail-open — consensus is telemetry, never a wedging gate */
    }
  }

  // ── v12.8 SURROGATE-FLOW CAP (AUDIT-20261023, operator mandate «اصلاح
  // پیشنهادی را کامل و مهندسی اجرا کن») ──
  // Forensics NX-3014 (BTWUSDT 03:13Z): the flow bundle read "CONFIRMS +10"
  // while its source was the BYBIT bridge (fapi banned) on a symbol whose
  // BINANCE quote was null and whose cross-venue dislocation ran 90-105bps —
  // the price collapsed −4.5% within 48s of deploy (SL −61.2% in 103s). A
  // surrogate venue's tape is REAL tape, but it is the WRONG venue's tape for
  // a Binance-doctrine engine on dislocated micro-caps: it must not be allowed
  // to CONFIRM a deploy. Cap: when the feeding source is not BINANCE, flow
  // conviction is clamped to ±6 — below the ±8 CONFIRMS/CONFLICTS line, so a
  // surrogate bundle can never confirm NOR fully veto; it can still feed the
  // flowVetoScore ≤−4 soft veto (score −5/−6 survives the clamp) and rides as
  // honest telemetry. BINANCE-sourced bundles are untouched.
  if (bridgeSrc && bridgeSrc !== "BINANCE") {
    score = Math.max(-6, Math.min(6, score));
    reasons.push(`SURROGATE-FLOW CAP: source ${bridgeSrc} ≠ BINANCE — conviction clamped ±6, surrogate flow cannot CONFIRM a deploy (NX-3014 48s-collapse forensics, v12.8)`);
  }

  const verdict = score >= 8 ? "CONFIRMS" : score <= -8 ? "CONFLICTS" : "NEUTRAL";
  return { verdict, score, reasons, metrics: m, oiWeight: Number(oiWeight.toFixed(2)), calibrated: true, coverage, blind: false, source: bridgeSrc ?? undefined };
}
