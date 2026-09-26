// ── FlowRadar Neo order-flow module (server-only) ──
// Real Binance USDT-M flow metrics: OI delta, taker CVD, crowd L/S, funding.
// scoreFlow → ±25 along candidate direction · OI-notional weighting (v4.5)
// · in-memory per-symbol history ring for sparklines (R17).
// v10.24 Task 34-a: fapi REST now goes through the process-wide fapi-gate
// (weight budget + global ban awareness + single-flight). Telemetry lane —
// sheddable under pressure; every caller is throw/null-tolerant already.

import { gateFetch } from "./fapi-gate";
import { liquidationPressure } from "./liquidations";

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
  verdict: "CONFIRMS" | "CONFLICTS" | "NEUTRAL" | "UNAVAILABLE";
  score: number; // -25..+25 along candidate direction
  reasons: string[];
  metrics: FlowMetrics;
  oiWeight: number;
  calibrated: boolean;
}

interface FlowCacheEntry {
  at: number;
  metrics: FlowMetrics;
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
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.metrics;
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

      const oi = oiHist.status === "fulfilled" ? oiHist.value : [];
      const taker = takerLS.status === "fulfilled" ? takerLS.value : [];
      const crowdArr = crowd.status === "fulfilled" ? crowd.value : [];
      const prem = premium.status === "fulfilled" ? premium.value : null;

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
      const cvdNetPctOfVol = takerMean !== null ? (takerMean - 1) * 100 : null; // % of taker volume net buys

      const crowdLongShort = crowdArr.length > 0 ? Number(crowdArr[crowdArr.length - 1]!.longShortRatio) : null;
      const crowdLongPct = crowdArr.length > 0 ? Number(crowdArr[crowdArr.length - 1]!.longAccount) * 100 : null;
      const topPosArr = topPos.status === "fulfilled" ? topPos.value : [];
      const topLongShort = topPosArr.length > 0 ? Number(topPosArr[topPosArr.length - 1]!.longShortRatio) : null;
      const funding8h = prem ? Number(prem.lastFundingRate) * 100 : null;

      // v6.7: real USD taker flow + whale prints from the same aggTrades pull
      // (trades ≤1000 ≈ last minutes on liquid symbols; windows clipped by T).
      const agg = aggTrades.status === "fulfilled" ? aggTrades.value : [];
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
      flowCache.set(symbol, { at: Date.now(), metrics });

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
    return { verdict: "UNAVAILABLE", score: 0, reasons: ["flow metrics unavailable — no numbers invented"], metrics: { oiDelta10m: null, oiDelta1h: null, oiValueUsd: null, cvdNetBase: null, cvdNetPctOfVol: null, takerRatio: null, takerMean: null, crowdLongShort: null, crowdLongPct: null, topLongShort: null, funding8h: null, cvdUsd60s: null, whalePrint5m: null }, oiWeight: 1, calibrated: false };
  }
  const dir = direction === "LONG" ? 1 : -1;
  const reasons: string[] = [];
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
  const score = Math.round(Math.max(-25, Math.min(25, raw * oiWeight)));
  if (Math.abs(oiWeight - 1) >= 0.15) reasons.push(`flow weighted ×${oiWeight.toFixed(2)} by OI notional ${fmtUsdShort(m.oiValueUsd ?? 0)} — deep-book flow trusted`);

  const verdict = score >= 8 ? "CONFIRMS" : score <= -8 ? "CONFLICTS" : "NEUTRAL";
  return { verdict, score, reasons, metrics: m, oiWeight: Number(oiWeight.toFixed(2)), calibrated: true };
}
