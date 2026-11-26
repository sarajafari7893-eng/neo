// ── NEXUS//SIGNALS OPEN-PNL SINGLE SOURCE OF TRUTH (v12.0 · Task 45 Q2) ─────
// Operator query 2026-10-18: «چرا دستور بسته شدن تمام معاملات با رسیدن open pnl
// به 20$ انجام نمیشه؟ درصورتی که الان UNREALIZED بالای این عدد است»
//
// ROOT CAUSE (audited live): TWO different "unrealized" formulas existed.
//   · ACCOUNT bar (stats.ts) priced 100% of the margin at the CURRENT price on
//     EVERY open row — including settlement-unsafe (sim-sourced) rows. For
//     banked rows (TP1/TP2/BE-bank) this re-prices already-banked tranches at
//     today's mark → overstated book pnl (+$21.31 live vs +$12.9 real).
//   · The v11.5 close-all BREAKER (engine.ts) priced the tranche-aware ladder
//     mark (banked rungs at their rung prices, runner at current mark) and
//     skipped settlement-unsafe rows per the v10.16 doctrine — the honest
//     bankable number.
//   → The documented v11.5 contract («the trigger reads the same number the
//     ACCOUNT bar shows») was violated — by the BAR, not by the breaker.
//     The bar also disagreed with the sum of the position cards themselves
//     (cards carry the per-row tranche-aware pnlPercent stored by the engine).
//
// This module is now THE one open-pnl implementation; both the breaker and the
// ACCOUNT bar call it, so a $20 mandate can never again disagree with the bar:
//   · bankableUsd — breaker semantics: tranche-aware fee-NET mark, live-price,
//     settlement-safe rows only (rows that could actually be banked right now).
//   · allRowsUsd — legacy full-margin-at-current-price over every row with a
//     price (kept as account.unrealizedPnlAllRows for transparency).
// Pure + client-safe (imports only accounting.ts).

import { feeBreakdown, LADDER_TRANCHES, ladderWeightedMove } from "./accounting";

export interface OpenPnlSignalLike {
  id: number | string;
  symbol: string;
  direction: string;
  entryPrice: number;
  leverage: number;
  marginUsd: number;
  reachedTp: number;
  beBankedMovePct: number | null;
  beBankedFrac: number | null;
  createdAt: Date;
}

/** v10.19/v11.5 tranche-aware UNLEVERED mark (moved here from engine.ts — the
 * engine keeps importing it so breaker/close math is bit-identical). */
export function liveOpenMarkPct(
  s: Pick<OpenPnlSignalLike, "entryPrice" | "reachedTp" | "beBankedMovePct" | "beBankedFrac"> & { tp1: number; tp2: number },
  movePct: number,
  isLong: boolean,
): number {
  const moveAtPct = (px: number) => ((px - s.entryPrice) / s.entryPrice) * (isLong ? 1 : -1) * 100;
  if (s.reachedTp >= 1) {
    const beB = s.beBankedMovePct !== null && s.beBankedFrac != null ? { frac: s.beBankedFrac, movePct: s.beBankedMovePct } : null;
    const remain = beB ? 1 - beB.frac : 1;
    const tranches: Array<{ weight: number; movePct: number }> = [];
    if (beB) tranches.push({ weight: beB.frac, movePct: beB.movePct });
    tranches.push({ weight: LADDER_TRANCHES.tp1 * remain, movePct: moveAtPct(s.tp1) });
    if (s.reachedTp >= 2) tranches.push({ weight: LADDER_TRANCHES.tp2 * remain, movePct: moveAtPct(s.tp2) });
    tranches.push({ weight: (1 - LADDER_TRANCHES.tp1 - LADDER_TRANCHES.tp2) * remain, movePct });
    return ladderWeightedMove(tranches);
  }
  if (s.beBankedMovePct !== null && s.beBankedFrac != null) {
    return ladderWeightedMove([
      { weight: s.beBankedFrac, movePct: s.beBankedMovePct },
      { weight: 1 - s.beBankedFrac, movePct },
    ]);
  }
  return movePct;
}

export interface OpenBookRow {
  signal: OpenPnlSignalLike & { tp1: number; tp2: number };
  price: number;
  /** settlement-safe = live-sourced & fresh (breaker predicate); unsafe rows are
   * counted in allRowsUsd but NEVER in bankableUsd. */
  safe: boolean;
}

export interface OpenBookResult {
  /** breaker-consistent bankable NET (safe rows, tranche-aware) */
  bankableUsd: number;
  /** legacy full-margin current-price NET over ALL priced rows (display audit) */
  allRowsUsd: number;
  included: Array<{ id: number | string; symbol: string; price: number; markPct: number; netUsd: number }>;
  skipped: Array<{ symbol: string; reason: "settlement-unsafe" | "no-price" }>;
}

export function openBookNet(rows: OpenBookRow[], now: number): OpenBookResult {
  let bankableUsd = 0;
  let allRowsUsd = 0;
  const included: OpenBookResult["included"] = [];
  const skipped: OpenBookResult["skipped"] = [];
  for (const r of rows) {
    const s = r.signal;
    if (!(r.price > 0)) {
      skipped.push({ symbol: s.symbol, reason: "no-price" });
      continue;
    }
    const isLong = s.direction === "LONG";
    const movePct = ((r.price - s.entryPrice) / s.entryPrice) * (isLong ? 1 : -1) * 100;
    const heldMin = Math.max(0, (now - s.createdAt.getTime()) / 60_000);
    // legacy display mark: 100% of margin at the current price (old ACCOUNT bar)
    allRowsUsd += feeBreakdown(s.marginUsd, s.leverage, movePct, heldMin).netUsd;
    if (!r.safe) {
      skipped.push({ symbol: s.symbol, reason: "settlement-unsafe" });
      continue;
    }
    const mark = liveOpenMarkPct(s, movePct, isLong);
    const netUsd = feeBreakdown(s.marginUsd, s.leverage, mark, heldMin).netUsd;
    bankableUsd += netUsd;
    included.push({ id: s.id, symbol: s.symbol, price: r.price, markPct: Number(mark.toFixed(2)), netUsd: Number(netUsd.toFixed(4)) });
  }
  return { bankableUsd, allRowsUsd, included, skipped };
}
