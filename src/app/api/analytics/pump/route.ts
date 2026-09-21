import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computePumpPerformance, persistPumpPerformance } from "@/lib/pump-performance";
import { getPumpEngineStatus } from "@/lib/pump-dump";

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/pump — PUMP/DUMP RADAR · performance forensics + AI
 * journal (v9.1, operator mandate 2026-09-13: «ماژول نمایش عملکرد و جورنال
 * برای هوش مرکزی»).
 * Returns the measured per-kind success book, 24h activity, top symbols,
 * best/worst tracks, the recent radar journal (PUMP_RADAR events) and the
 * live engine status (gate + authority). Side effect (debounced 30min):
 * persists the digest to EngineSetting "pump.performance" so the governor /
 * advisor / engine-memory consume the same evidence on their own cycles.
 */
export async function GET() {
  try {
    const [perf, status] = await Promise.all([computePumpPerformance(), getPumpEngineStatus()]);
    const persisted = await persistPumpPerformance(perf);
    if (persisted) {
      await db.signalEvent.create({
        data: {
          type: "ENGINE",
          symbol: null,
          level: "ai",
          message: `PUMP RADAR PERFORMANCE → EngineSetting "pump.performance" · ${perf.headline} · 24h declared ${perf.window24h.declared} (success ${perf.window24h.success} / failure ${perf.window24h.failure}) · radar-spawned signals ${perf.totals.spawnedSignals} · journal lines ${perf.journal.length}`,
        },
      });
    }
    return NextResponse.json({ ...perf, status, persistedThisCall: persisted }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[pump-performance] error", err);
    return NextResponse.json({ error: "pump performance analytics failure" }, { status: 500 });
  }
}
