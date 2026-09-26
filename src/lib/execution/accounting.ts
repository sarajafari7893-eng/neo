/**
 * NEXUS//SIGNALS — real accounting ledger (LIVE-HARDENING Phase 5).
 *
 * Doctrine: MODELED ≠ PAPER ≠ REALIZED. These classes are distinct at the type
 * level AND enforced at runtime: a ledger entry's class is fixed at creation,
 * metrics are always computed per-class, and mixing classes in one computation
 * throws. Model assumptions can never masquerade as exchange-realized results.
 *
 * The 8 task-required metrics are emitted by `computeClassMetrics` for
 * REALIZED_PNL ledgers (and analogously for the other classes, never mixed).
 */

import type { PnlClass } from "./types";

export interface FillRecord {
  price: number;
  qtyUnits: number;
  feeUsd: number;
  at: string;
}

export interface LedgerEntryInput {
  class: PnlClass;
  signalId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  grossPnlUsd: number;
  feesUsd: number;
  fundingUsd: number;
  /** measured slippage vs model price, USD (entry+exit) */
  slippageUsd: number;
  fills: FillRecord[];
  /** engine-observed order round-trip latency */
  executionLatencyMs: number | null;
  /** model's predicted PnL for the same trade (for drag accounting) */
  modeledPnlUsd: number | null;
}

export interface LedgerEntry extends LedgerEntryInput {
  id: string;
  createdAt: string;
  /** partial-fill weighted average entry price (null when single fill) */
  partialFillVwapUsd: number | null;
}

export function makeLedgerEntry(input: LedgerEntryInput): LedgerEntry {
  if (input.class === "REALIZED_PNL" && input.fills.length === 0) {
    throw Object.assign(new Error("REALIZED_PNL requires at least one actual fill"), { code: "NO_FILLS" });
  }
  const partial = input.fills.length > 1;
  const vwap = partial
    ? input.fills.reduce((s, f) => s + f.price * f.qtyUnits, 0) / input.fills.reduce((s, f) => s + f.qtyUnits, 0)
    : null;
  return {
    ...input,
    id: `LED-${input.class}-${input.signalId}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    partialFillVwapUsd: vwap !== null ? Math.round(vwap * 1e6) / 1e6 : null,
  };
}

export interface ClassMetrics {
  n: number;
  gross_pnl: number;
  fees: number;
  funding: number;
  slippage: number;
  realized_pnl: number;
  realized_R: number | null;
  execution_latency_ms: number | null;
  model_vs_realized_error: number | null;
}

/**
 * Per-class metrics. Throws if the input mixes classes — mixing is the exact
 * failure mode this ledger exists to prevent.
 */
export function computeClassMetrics(entries: LedgerEntry[], riskPerTradeUsdBySignal?: Map<string, number>): ClassMetrics {
  const classes = new Set(entries.map((e) => e.class));
  if (classes.size > 1) {
    throw Object.assign(new Error(`mixed PnL classes: ${[...classes].join(",")} — per-class accounting only`), {
      code: "MIXED_PNL_CLASSES",
    });
  }
  const gross = entries.reduce((s, e) => s + e.grossPnlUsd, 0);
  const fees = entries.reduce((s, e) => s + e.feesUsd, 0);
  const funding = entries.reduce((s, e) => s + e.fundingUsd, 0);
  const slip = entries.reduce((s, e) => s + e.slippageUsd, 0);
  const realized = gross - fees - funding - slip;
  const latencies = entries.map((e) => e.executionLatencyMs).filter((v): v is number => typeof v === "number");
  const errors = entries
    .filter((e) => e.modeledPnlUsd !== null)
    .map((e) => (e.grossPnlUsd - (e.modeledPnlUsd as number)));

  const rValues =
    riskPerTradeUsdBySignal &&
      entries.every((e) => riskPerTradeUsdBySignal.has(e.signalId)) &&
      entries.every((e) => (riskPerTradeUsdBySignal.get(e.signalId) ?? 0) > 0)
      ? entries.map((e) => (realizedOf(e)) / (riskPerTradeUsdBySignal.get(e.signalId) as number))
      : null;

  return {
    n: entries.length,
    gross_pnl: round2(gross),
    fees: round2(fees),
    funding: round2(funding),
    slippage: round2(slip),
    realized_pnl: round2(realized),
    realized_R: rValues ? round4(rValues.reduce((s, v) => s + v, 0)) : null,
    execution_latency_ms: latencies.length ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : null,
    model_vs_realized_error: errors.length ? round4(errors.reduce((s, v) => s + v, 0) / errors.length) : null,
  };
}

function realizedOf(e: LedgerEntry): number {
  return e.grossPnlUsd - e.feesUsd - e.fundingUsd - e.slippageUsd;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
