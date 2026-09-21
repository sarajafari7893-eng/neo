// ── FlowRadar Neo fee-aware accounting (pure, client-safe) ──
// Paper account starts at $100. Margin sized by confidence coefficient.
// NET PnL = gross move − round-trip taker commission − pro-rated funding swap.

export const ACCOUNT_START_USD = 100;
export const TAKER_FEE_RATE = 0.0005; // Binance USDT-M taker, per side
export const FUNDING_RATE_8H = 0.0001; // 0.01% / 8h baseline

export interface FeeBreakdown {
  notionalUsd: number;
  commissionUsd: number; // entry + exit taker
  swapUsd: number; // pro-rated 8h funding
  totalFeesUsd: number;
  grossUsd: number;
  netUsd: number;
  netPct: number;
}

export function feeBreakdown(marginUsd: number, leverage: number, grossPct: number, minutesHeld: number): FeeBreakdown {
  const notionalUsd = marginUsd * leverage;
  const commissionUsd = notionalUsd * TAKER_FEE_RATE * 2;
  const swapUsd = notionalUsd * FUNDING_RATE_8H * (minutesHeld / 480);
  const grossUsd = notionalUsd * (grossPct / 100);
  const totalFeesUsd = commissionUsd + swapUsd;
  const netUsd = grossUsd - totalFeesUsd;
  const netPct = marginUsd > 0 ? (netUsd / marginUsd) * 100 : 0;
  return { notionalUsd, commissionUsd, swapUsd, totalFeesUsd, grossUsd, netUsd, netPct };
}

/** Margin sized by confidence: 2%..8% of equity, linear conf 55→96, clamped. */
export function confidenceMargin(confidence: number, equity: number, freeMargin: number): number {
  const clamped = Math.min(96, Math.max(55, confidence));
  const pct = 0.02 + ((clamped - 55) / (96 - 55)) * 0.06; // 2%..8%
  let margin = equity * pct;
  margin = Math.max(1, Math.min(margin, equity * 0.1, freeMargin));
  return Number(margin.toFixed(2));
}

// ── v6.6 TRANCHE-AWARE LADDER ACCOUNTING (operator-approved fix, 2026-09-07) ──
// The announced exit policy is real: TP1 banks 50% of the position, TP2 banks
// 30% more (80% cumulative), the 20% runner rides to TP3 (or stops/expiry).
// The old ledger priced the WHOLE margin at the FINAL exit price — it both
// overstated TP3 trades (runner-sized exit priced on full margin) and
// understated TP1→BE round-trips (banked TP1 profit vanished). Forensics
// (op-qa-0907.mjs, Q2) showed the distortion is ±$8 aggregate but per-trade it
// misstates win math; this table makes settled pnl match what the card announces.
export const LADDER_TRANCHES = { tp1: 0.5, tp2: 0.3, runner: 0.2 } as const;

/** Weighted UNLEVERED move over the tranche ladder — feed straight into
 * feeBreakdown as grossPct (fees still accrue on the FULL notional: the three
 * exit fills sum to one complete position, so commission/swap totals are unchanged). */
export function ladderWeightedMove(tranches: Array<{ weight: number; movePct: number }>): number {
  if (tranches.length === 0) return 0;
  const totalW = tranches.reduce((a, t) => a + t.weight, 0);
  if (totalW <= 0) return 0;
  return tranches.reduce((a, t) => a + t.weight * t.movePct, 0) / totalW;
}
