// ── NEXUS//SIGNALS — HARD RISK ENGINE (LIVE-HARDENING phase 10) ─────────────
// WHY: risk-governor.ts is an ADVISORY throttle (size multipliers). The spec
// requires an INDEPENDENT, DETERMINISTIC, NON-BYPASSABLE risk engine for the
// safety-critical path: strategy code cannot widen these limits, LLM output
// cannot touch them, and the daily/weekly emergency stops are absolute —
// even an operator-forced deploy is refused while they are breached (the
// operator's remaining lever is to fix the breach, not the limit).
//
// Pilot parameters (engineering examples per spec — NOT claimed universal):
//   risk_per_trade 0.10–0.25% equity · daily loss stop ≈1% · weekly ≈2.5%
//   max aggregate open risk 2% · correlated group cap 2 · symbol cap 1 open
// All verdicts carry deterministic reasons; every rejection is auditable.

import type { Signal } from "@prisma/client";

export const RISK_LIMITS = {
  RISK_PER_TRADE_PCT_MIN: 0.10,
  RISK_PER_TRADE_PCT_MAX: 0.25,
  DAILY_LOSS_STOP_PCT: 1.0,
  WEEKLY_EMERGENCY_STOP_PCT: 2.5,
  MAX_AGGREGATE_OPEN_RISK_PCT: 2.0,
  MAX_OPEN_POSITIONS: 6,
  MAX_OPEN_PER_SYMBOL: 1,
  CORRELATED_GROUP_CAP: 2, // BTC/ETH + high-beta majors move as one risk unit
  CLOCK_SKEW_MAX_MS: 2_500,
} as const;

/** Correlated groups — a position in one member consumes group budget. */
const CORRELATED: Record<string, string> = {
  BTCUSDT: "MAJOR", ETHUSDT: "MAJOR", BNBUSDT: "MAJOR",
  SOLUSDT: "HIGH-BETA", AVAXUSDT: "HIGH-BETA", SUIUSDT: "HIGH-BETA",
  DOGEUSDT: "HIGH-BETA", XRPUSDT: "HIGH-BETA", ADAUSDT: "HIGH-BETA",
};

export type RiskVerdict = "ALLOW" | "THROTTLE" | "REJECT" | "HALT";

export interface RiskInput {
  equityUsd: number;
  marginUsd: number;
  leverage: number;
  entryPrice: number;
  stopPrice: number;
  direction: "LONG" | "SHORT";
  symbol: string;
  openRows: Array<Pick<Signal, "symbol" | "direction" | "marginUsd" | "leverage" | "entryPrice" | "stopLoss">>;
  dailyPnlUsd: number; // settled, UTC day (negative = loss)
  equityAtDayStartUsd: number;
  weeklyPnlUsd: number; // settled, rolling 7d
  operatorForced: boolean;
}

export interface RiskDecision {
  verdict: RiskVerdict;
  reasons: string[];
  riskUsd: number;
  riskPct: number; // per-trade risk as % of equity
  sizeFactor: number; // 1 = keep computed size; <1 shrink; REJECT/HALT ignore
  dailyLossPct: number;
  weeklyLossPct: number;
  aggregateOpenRiskPct: number;
}

/** Deterministic per-trade risk: defined by invalidation distance, NOT by
 * leverage preference (spec phase 10). */
export function perTradeRiskUsd(i: Pick<RiskInput, "marginUsd" | "leverage" | "entryPrice" | "stopPrice">): number {
  const notional = i.marginUsd * i.leverage;
  const invalidationPct = i.entryPrice > 0 ? Math.abs(i.entryPrice - i.stopPrice) / i.entryPrice * 100 : 100;
  return notional * (invalidationPct / 100);
}

function openRowRiskUsd(r: RiskInput["openRows"][number]): number {
  const invalidationPct = r.entryPrice > 0 ? Math.abs(r.entryPrice - r.stopLoss) / r.entryPrice * 100 : 100;
  return r.marginUsd * r.leverage * (invalidationPct / 100);
}

export function evaluateRisk(i: RiskInput): RiskDecision {
  const reasons: string[] = [];
  const riskUsd = perTradeRiskUsd(i);
  const riskPct = i.equityUsd > 0 ? (riskUsd / i.equityUsd) * 100 : 100;
  const dailyLossPct = i.equityAtDayStartUsd > 0 ? Math.max(0, -i.dailyPnlUsd / i.equityAtDayStartUsd) * 100 : 0;
  const weeklyLossPct = i.equityAtDayStartUsd > 0 ? Math.max(0, -i.weeklyPnlUsd / (i.equityAtDayStartUsd + Math.max(0, i.weeklyPnlUsd))) * 100 : 0;
  const aggregateOpenRiskPct = i.equityUsd > 0 ? (i.openRows.reduce((a, r) => a + openRowRiskUsd(r), 0) / i.equityUsd) * 100 : 0;

  // ── ABSOLUTE HALTS (not bypassable by ANY code path incl. operator force) ──
  if (dailyLossPct >= RISK_LIMITS.DAILY_LOSS_STOP_PCT) {
    return { verdict: "HALT", reasons: [`DAILY LOSS STOP: settled −${dailyLossPct.toFixed(2)}% ≥ ${RISK_LIMITS.DAILY_LOSS_STOP_PCT}% — trading halted until next UTC day (non-bypassable)`], riskUsd, riskPct, sizeFactor: 0, dailyLossPct, weeklyLossPct, aggregateOpenRiskPct };
  }
  if (weeklyLossPct >= RISK_LIMITS.WEEKLY_EMERGENCY_STOP_PCT) {
    return { verdict: "HALT", reasons: [`WEEKLY EMERGENCY STOP: −${weeklyLossPct.toFixed(2)}% ≥ ${RISK_LIMITS.WEEKLY_EMERGENCY_STOP_PCT}% — manual operator intervention required (non-bypassable)`], riskUsd, riskPct, sizeFactor: 0, dailyLossPct, weeklyLossPct, aggregateOpenRiskPct };
  }
  if (!Number.isFinite(riskUsd) || !Number.isFinite(riskPct) || !Number.isFinite(i.entryPrice) || !Number.isFinite(i.stopPrice) || i.entryPrice <= 0 || i.stopPrice <= 0) {
    return { verdict: "HALT", reasons: ["UNKNOWN RISK STATE: entry/stop not finite — fail-closed (unknown execution state prevents new entries)"], riskUsd: 0, riskPct: 0, sizeFactor: 0, dailyLossPct, weeklyLossPct, aggregateOpenRiskPct };
  }

  // ── HARD REJECTS (bypassable only by explicit operator force, audited) ──
  if (i.openRows.filter((r) => r.symbol === i.symbol).length >= RISK_LIMITS.MAX_OPEN_PER_SYMBOL) {
    reasons.push(`symbol concentration: already ≥${RISK_LIMITS.MAX_OPEN_PER_SYMBOL} open on ${i.symbol}`);
  }
  if (i.openRows.length >= RISK_LIMITS.MAX_OPEN_POSITIONS) {
    reasons.push(`aggregate exposure: ${i.openRows.length} open ≥ cap ${RISK_LIMITS.MAX_OPEN_POSITIONS}`);
  }
  const grp = CORRELATED[i.symbol] ?? "OTHER";
  const groupOpen = i.openRows.filter((r) => (CORRELATED[r.symbol] ?? "OTHER") === grp).length;
  if (grp !== "OTHER" && groupOpen >= RISK_LIMITS.CORRELATED_GROUP_CAP) {
    reasons.push(`correlated exposure: ${grp} group already ${groupOpen} open ≥ cap ${RISK_LIMITS.CORRELATED_GROUP_CAP}`);
  }
  if (aggregateOpenRiskPct >= RISK_LIMITS.MAX_AGGREGATE_OPEN_RISK_PCT) {
    reasons.push(`aggregate open risk ${aggregateOpenRiskPct.toFixed(2)}% ≥ ${RISK_LIMITS.MAX_AGGREGATE_OPEN_RISK_PCT}%`);
  }
  if (riskPct > RISK_LIMITS.RISK_PER_TRADE_PCT_MAX * 4) {
    reasons.push(`per-trade risk ${riskPct.toFixed(2)}% > 4× cap — sizing defect`);
  }

  if (reasons.length > 0) {
    if (i.operatorForced) {
      return { verdict: "THROTTLE", reasons: ["OPERATOR OVERRIDE (audited): " + reasons.join(" · ")], riskUsd, riskPct, sizeFactor: 0.5, dailyLossPct, weeklyLossPct, aggregateOpenRiskPct };
    }
    return { verdict: "REJECT", reasons, riskUsd, riskPct, sizeFactor: 0, dailyLossPct, weeklyLossPct, aggregateOpenRiskPct };
  }

  // ── THROTTLE: per-trade risk above the pilot band ⇒ shrink to band edge ──
  let sizeFactor = 1;
  if (riskPct > RISK_LIMITS.RISK_PER_TRADE_PCT_MAX) {
    sizeFactor = Number((RISK_LIMITS.RISK_PER_TRADE_PCT_MAX / riskPct).toFixed(3));
    reasons.push(`per-trade risk ${riskPct.toFixed(2)}% > band max ${RISK_LIMITS.RISK_PER_TRADE_PCT_MAX}% — sized down ×${sizeFactor}`);
  }
  return { verdict: sizeFactor < 1 ? "THROTTLE" : "ALLOW", reasons, riskUsd, riskPct, sizeFactor, dailyLossPct, weeklyLossPct, aggregateOpenRiskPct };
}

/** UTC-day settled PnL + rolling-7d — computed from the ledger, never from
 * modeled projections. */
export function splitDailyWeekly(settled: Array<{ pnlUsd: number; closedAt: Date | null }>, now = Date.now()): { dailyPnlUsd: number; weeklyPnlUsd: number } {
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const weekAgo = now - 7 * 86_400_000;
  let daily = 0, weekly = 0;
  for (const s of settled) {
    const t = s.closedAt ? s.closedAt.getTime() : 0;
    if (t >= dayStart.getTime()) daily += s.pnlUsd;
    if (t >= weekAgo) weekly += s.pnlUsd;
  }
  return { dailyPnlUsd: Number(daily.toFixed(4)), weeklyPnlUsd: Number(weekly.toFixed(4)) };
}
