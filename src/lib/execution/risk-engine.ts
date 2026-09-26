/**
 * NEXUS//SIGNALS — risk engine (LIVE-HARDENING Phase 10).
 *
 * Deterministic, strategy-independent, non-bypassable:
 *  · sizing derives from INVALIDATION risk (entry→stop distance), never from
 *    leverage preference;
 *  · daily / rolling-weekly loss circuit breakers;
 *  · aggregate open-risk cap, per-symbol cap, correlated-group cap;
 *  · the state machine's ELIGIBLE→RISK_APPROVED transition is the ONLY consumer
 *    authorized to act on `approved`, and it cannot be reached without calling
 *    this module — strategy code has no route around it.
 *
 * Pilot parameters (task §10 — engineering examples, NOT claims of optimal
 * trading risk): per-trade 0.10–0.25% equity, daily stop ≈1%, weekly ≈2–3%.
 * Defaults sit inside those ranges and are clamp-locked.
 */

export interface RiskLimits {
  /** per-trade risk budget, % equity — clamped to [0.10, 0.25] */
  riskPerTradePct: number;
  /** daily realized-loss circuit breaker, % equity */
  dailyLossStopPct: number;
  /** rolling-weekly emergency stop, % equity */
  weeklyLossStopPct: number;
  /** max SUM of open per-trade risks, % equity */
  maxAggregateOpenRiskPct: number;
  /** max open risk concentrated in ONE symbol, % equity */
  maxPerSymbolOpenRiskPct: number;
  /** max open risk in one correlated group, % equity */
  maxGroupOpenRiskPct: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  riskPerTradePct: 0.2,
  dailyLossStopPct: 1.0,
  weeklyLossStopPct: 2.5,
  maxAggregateOpenRiskPct: 0.75,
  maxPerSymbolOpenRiskPct: 0.4,
  maxGroupOpenRiskPct: 0.6,
};

export function clampLimits(l: Partial<RiskLimits>): RiskLimits {
  const clamp = (v: number | undefined, lo: number, hi: number, dflt: number) =>
    Math.min(hi, Math.max(lo, typeof v === "number" && Number.isFinite(v) ? v : dflt));
  return {
    riskPerTradePct: clamp(l.riskPerTradePct, 0.1, 0.25, DEFAULT_LIMITS.riskPerTradePct),
    dailyLossStopPct: clamp(l.dailyLossStopPct, 0.5, 1.5, DEFAULT_LIMITS.dailyLossStopPct),
    weeklyLossStopPct: clamp(l.weeklyLossStopPct, 1.5, 3.0, DEFAULT_LIMITS.weeklyLossStopPct),
    maxAggregateOpenRiskPct: clamp(l.maxAggregateOpenRiskPct, 0.3, 1.0, DEFAULT_LIMITS.maxAggregateOpenRiskPct),
    maxPerSymbolOpenRiskPct: clamp(l.maxPerSymbolOpenRiskPct, 0.1, 0.5, DEFAULT_LIMITS.maxPerSymbolOpenRiskPct),
    maxGroupOpenRiskPct: clamp(l.maxGroupOpenRiskPct, 0.2, 0.8, DEFAULT_LIMITS.maxGroupOpenRiskPct),
  };
}

export interface OpenRiskPosition {
  symbol: string;
  /** committed risk for this open position, % equity */
  riskPct: number;
  group: string;
}

export interface RiskCandidate {
  symbol: string;
  entry: number;
  stop: number;
  group: string;
}

export interface RiskContext {
  equityUsd: number;
  /** realized pnl today, % equity (negative = loss) */
  realizedTodayPct: number;
  /** realized pnl rolling 7d, % equity */
  realizedWeekPct: number;
  open: OpenRiskPosition[];
  candidate: RiskCandidate;
}

export type RiskAssessment =
  | {
      approved: true;
      sizeUsd: number;
      riskUsd: number;
      invalidationPct: number;
      reasonCode: "RISK_APPROVED";
      detail: string;
    }
  | { approved: false; reasonCode: string; detail: string };

export function assessRisk(ctx: RiskContext, limits: RiskLimits = DEFAULT_LIMITS): RiskAssessment {
  const L = clampLimits(limits);
  const { equityUsd, candidate } = ctx;

  if (!(equityUsd > 0) || !Number.isFinite(equityUsd)) {
    return { approved: false, reasonCode: "EQUITY_UNKNOWN", detail: "equity unknown/non-finite — fail closed" };
  }
  if (!(candidate.entry > 0) || !(candidate.stop > 0) || candidate.entry === candidate.stop) {
    return { approved: false, reasonCode: "INVALIDATION_UNKNOWN", detail: "entry/stop invalid — cannot size from invalidation" };
  }

  // circuit breakers first (deterministic)
  if (ctx.realizedTodayPct <= -L.dailyLossStopPct) {
    return {
      approved: false,
      reasonCode: "DAILY_LOSS_STOP",
      detail: `realized today ${ctx.realizedTodayPct.toFixed(2)}% ≤ -${L.dailyLossStopPct}% — trading halted until next day`,
    };
  }
  if (ctx.realizedWeekPct <= -L.weeklyLossStopPct) {
    return {
      approved: false,
      reasonCode: "WEEKLY_LOSS_STOP",
      detail: `realized 7d ${ctx.realizedWeekPct.toFixed(2)}% ≤ -${L.weeklyLossStopPct}% — emergency stop`,
    };
  }

  const openAgg = ctx.open.reduce((s, p) => s + p.riskPct, 0);
  const openSymbol = ctx.open.filter((p) => p.symbol === candidate.symbol).reduce((s, p) => s + p.riskPct, 0);
  const openGroup = ctx.open.filter((p) => p.group === candidate.group).reduce((s, p) => s + p.riskPct, 0);

  if (openAgg >= L.maxAggregateOpenRiskPct) {
    return { approved: false, reasonCode: "AGGREGATE_RISK_CAP", detail: `open risk ${openAgg.toFixed(2)}% ≥ cap ${L.maxAggregateOpenRiskPct}%` };
  }
  if (openSymbol >= L.maxPerSymbolOpenRiskPct) {
    return { approved: false, reasonCode: "SYMBOL_CONCENTRATION", detail: `${candidate.symbol} open risk ${openSymbol.toFixed(2)}% ≥ cap ${L.maxPerSymbolOpenRiskPct}%` };
  }
  if (openGroup >= L.maxGroupOpenRiskPct) {
    return { approved: false, reasonCode: "GROUP_CONCENTRATION", detail: `group ${candidate.group} open risk ${openGroup.toFixed(2)}% ≥ cap ${L.maxGroupOpenRiskPct}%` };
  }

  // sizing from invalidation distance (NOT leverage preference)
  const invalidationPct = (Math.abs(candidate.entry - candidate.stop) / candidate.entry) * 100;
  if (!(invalidationPct > 0)) {
    return { approved: false, reasonCode: "INVALIDATION_UNKNOWN", detail: "zero invalidation distance" };
  }
  const remainingAggregate = L.maxAggregateOpenRiskPct - openAgg;
  const remainingSymbol = L.maxPerSymbolOpenRiskPct - openSymbol;
  const remainingGroup = L.maxGroupOpenRiskPct - openGroup;
  const budgetPct = Math.min(L.riskPerTradePct, remainingAggregate, remainingSymbol, remainingGroup);
  if (budgetPct <= 0) {
    return { approved: false, reasonCode: "NO_RISK_BUDGET", detail: "no remaining risk budget under caps" };
  }

  const riskUsd = (equityUsd * budgetPct) / 100;
  const sizeUsd = riskUsd / (invalidationPct / 100);

  return {
    approved: true,
    reasonCode: "RISK_APPROVED",
    sizeUsd: Math.floor(sizeUsd * 100) / 100,
    riskUsd: Math.floor(riskUsd * 100) / 100,
    invalidationPct: Math.round(invalidationPct * 1000) / 1000,
    detail: `sized ${Math.floor(sizeUsd)} USD from ${(budgetPct).toFixed(2)}% risk @ ${invalidationPct.toFixed(2)}% invalidation`,
  };
}
