// ── v10.22 MODEL GAPS — the disclosed honesty ledger (P1) ──────────────────
// Operator list (2026-09-22, «کمبودهای مهم») + the backtest-accepted deltas,
// each mapped to its post-v10.22 status. Imported by the ShadowVetoCard
// (dashboard disclosure) and available to any backtest/report script so the
// SAME table ships everywhere PnL is shown. Never present paper PnL without
// this table within reach.
export type GapStatus = "modeled" | "partial" | "open";

export interface ModelGap {
  id: string;
  area: string;
  gap: string;
  status: GapStatus;
  note: string;
}

export const MODEL_GAPS: ModelGap[] = [
  { id: "bid-ask", area: "paper fill", gap: "real bid/ask", status: "modeled", note: "v10.22: fills on the touched side (ask for LONG / bid for SHORT) from /fapi/v1/ticker/bookTicker." },
  { id: "spread", area: "paper fill", gap: "spread", status: "modeled", note: "v10.22: embedded in the touched-side fill price." },
  { id: "slippage", area: "paper fill", gap: "slippage", status: "partial", note: "v10.22: depth-aware top-20 book walk at entry; market exits pay a disclosed liquidity-tier table (2/5/10/20 bps). Full L2 path sim deferred to execution phase." },
  { id: "latency", area: "paper fill", gap: "latency", status: "partial", note: "v10.22: entry latency band sampled (0.5–2 bps normal, 2–10 bps cascade). No time-based path simulation; LIVE mitigations are CHASE-CAP (0.4–0.9%)." },
  { id: "partial-fill", area: "paper fill", gap: "partial fill", status: "partial", note: "v10.22: entry partials vs top-of-book size (50–95%). Exit-side partial fills not modeled." },
  { id: "rejection", area: "paper fill", gap: "order rejection", status: "modeled", note: "v10.22: sampled 0.5% (3% in cascades); rejected trades never enter the ledger and are counted." },
  { id: "liquidation", area: "risk", gap: "real liquidation price", status: "modeled", note: "v10.22: isolated-style liqPrice (MMR≈0.5%) triggered on MARK in the SV sweep; near-miss uses a last-price proxy (disclosed)." },
  { id: "mark-vs-last", area: "risk", gap: "mark price vs last price", status: "partial", note: "v10.22: liquidations on premiumIndex mark; TP/SL still trigger on last. Full dual-price triggering deferred." },
  { id: "funding", area: "costs", gap: "real funding settlement", status: "modeled", note: "v10.22: discrete stamps at 00/08/16 UTC with the symbol's REAL lastFundingRate (pro-rata baseline removed; fallback 0.01%)." },
  { id: "outage", area: "operations", gap: "exchange outage while position open", status: "open", note: "deliberately NOT simulated — operational risk is owned by guard rails (feed failover, kill-switch layers), not by a paper model. Fail-soft: feed loss freezes sweeps at last known marks." },
  { id: "intrabar", area: "backtest", gap: "exact TP/SL ordering inside a candle", status: "open", note: "paper sweep resolves at poll cadence (~4s); backtest keeps the conservative SL-first assumption." },
  { id: "ttl-ext", area: "backtest", gap: "dynamic TTL extension not simulated", status: "open", note: "accepted by the backtest report; extension stays disabled in live policy (radar R6 data)." },
  { id: "ladder-parity", area: "backtest", gap: "TP2/ladder parity with live in all cases", status: "partial", note: "paper close math is engine-identical (v6.6 tranches); kline-path differences remain." },
  { id: "sl-first", area: "backtest", gap: "SL-first conservative assumption", status: "open", note: "kept by design — it biases against the system, never for it." },
];

export const MODEL_GAPS_UPDATED = "2026-09-22T10:50Z";

/** One-paragraph summary for reports: N modeled / M partial / K open. */
export function modelGapsSummary(): string {
  const modeled = MODEL_GAPS.filter((g) => g.status === "modeled").length;
  const partial = MODEL_GAPS.filter((g) => g.status === "partial").length;
  const open = MODEL_GAPS.filter((g) => g.status === "open").length;
  return `Model-gaps ledger (v10.22): ${modeled} modeled · ${partial} partial · ${open} open — paper PnL is a bounded estimate, not an executable promise.`;
}

/** Plain-text table for scripts that print reports. */
export function modelGapsTable(): string {
  const lines = MODEL_GAPS.map((g) => `[${g.status.toUpperCase().padEnd(7)}] ${g.area} — ${g.gap}: ${g.note}`);
  return [modelGapsSummary(), ...lines].join("\n");
}
