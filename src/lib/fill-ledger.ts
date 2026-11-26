// ── Task 79 FILL LEDGER — missing-data doctrine item ② (operator mandate
// 2026-10-05) ─────────────────────────────────────────────────────────────────
// "Deflated edge $0.067/trade — unmeasured slippage could eat 15-75% of it.
// Cheapest: two extra columns on existing records." This module writes those
// columns at deploy time: the detection/scan reference price the chase gate
// anchored on, the actual entry, direction-adjusted adverse slippage in bps,
// and detection→deploy latency. One row per signal (unique).
// Fire-and-forget: a ledger failure can never block a deploy.
// P1-b ENTRY-DELAY TELEMETRY (audit 2026-10-25: 962/962 window rows were
// refSource='none', slipBps=0, latencyMs=NULL): the caller now labels the
// detection path explicitly (refSource) and the scan path feeds its REAL
// detection instant (frozen MTF snapshot `at`, FlowScan.updatedAt fallback)
// so latencyMs measures board→deploy lag instead of dying at NULL. slipBps
// math unchanged.

import { db } from "@/lib/db";

export interface FillRecordInput {
  signalId: string;
  symbol: string;
  engine: string;
  direction: string;
  refPrice: number | null; // chase-gate anchor (radar track anchorPrice / scan tick)
  entryPrice: number;
  detectedAt?: number | null; // epoch ms — radar track.detectedAt, or scan board-snapshot instant
  refSource?: "radar-anchor" | "scan" | "none"; // P1-b: explicit detection-path label from the caller
  createdAtMs: number;
}

export function recordFillLedger(r: FillRecordInput): void {
  void (async () => {
    const ref = r.refPrice && r.refPrice > 0 ? r.refPrice : r.entryPrice;
    const isLong = r.direction !== "SHORT";
    // adverse slippage, direction-adjusted: positive = paid WORSE than detection
    const slipBps = ref > 0 ? ((r.entryPrice - ref) / ref) * 10_000 * (isLong ? 1 : -1) : 0;
    // P1-b KPI: latencyMs = signal.createdAt − detectionInstant. Scan path =
    // board→deploy lag (the operator's standing entry-delay complaint, now
    // measured); radar path = track detection→deploy.
    const latencyMs = r.detectedAt ? Math.max(0, r.createdAtMs - r.detectedAt) : null;
    // P1-b: the explicit caller label wins; legacy heuristic keeps any old
    // caller (no refSource) honest.
    const refSource =
      r.refSource ?? (r.detectedAt ? "radar-anchor" : Math.abs(r.entryPrice - ref) < 1e-12 ? "none" : "scan");
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
