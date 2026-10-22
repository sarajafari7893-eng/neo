// ── Task 79 FILL LEDGER — missing-data doctrine item ② (operator mandate
// 2026-10-05) ─────────────────────────────────────────────────────────────────
// "Deflated edge $0.067/trade — unmeasured slippage could eat 15-75% of it.
// Cheapest: two extra columns on existing records." This module writes those
// columns at deploy time: the detection/scan reference price the chase gate
// anchored on, the actual entry, direction-adjusted adverse slippage in bps,
// and (radar path) detection→deploy latency. One row per signal (unique).
// Fire-and-forget: a ledger failure can never block a deploy.

import { db } from "@/lib/db";

export interface FillRecordInput {
  signalId: string;
  symbol: string;
  engine: string;
  direction: string;
  refPrice: number | null; // chase-gate anchor (detection instant for radar)
  entryPrice: number;
  detectedAt?: number | null; // epoch ms, radar path only
  createdAtMs: number;
}

export function recordFillLedger(r: FillRecordInput): void {
  void (async () => {
    const ref = r.refPrice && r.refPrice > 0 ? r.refPrice : r.entryPrice;
    const isLong = r.direction !== "SHORT";
    // adverse slippage, direction-adjusted: positive = paid WORSE than detection
    const slipBps = ref > 0 ? ((r.entryPrice - ref) / ref) * 10_000 * (isLong ? 1 : -1) : 0;
    const latencyMs = r.detectedAt ? Math.max(0, r.createdAtMs - r.detectedAt) : null;
    const refSource = r.detectedAt ? "radar-anchor" : Math.abs(r.entryPrice - ref) < 1e-12 ? "none" : "scan";
    await db.fillLedger.upsert({
      where: { signalId: r.signalId },
      create: {
        signalId: r.signalId,
        symbol: r.symbol,
        engine: r.engine,
        direction: r.direction,
        refPrice: ref,
        entryPrice: r.entryPrice,
        slipBps: Number(slipBps.toFixed(2)),
        detectedAt: r.detectedAt ? new Date(r.detectedAt) : null,
        latencyMs,
        refSource,
      },
      update: {}, // deploy-time record is immutable
    });
  })().catch(() => undefined); // absolute fail-open — ledger never blocks trading
}
