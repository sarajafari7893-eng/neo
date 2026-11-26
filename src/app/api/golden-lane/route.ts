import { NextResponse } from "next/server";
import { getGoldenLaneStatus, maybeApplyExtension, maybeRunGoldenLaneAdjudication, getGoldenLaneAdjudication, getActiveLaneConfigs, PROMOTE_MIN_N, WINDOW_DAYS } from "@/lib/golden-lane";

export const dynamic = "force-dynamic";

/**
 * GET /api/golden-lane — Task 79 pre-registered paper evaluation of the
 * Task-78 Golden Formula v1.0 (+ R6-EDGE challenger). Full view: lane
 * analytics, rails, kill-switches K1..K4, recent settled matches.
 * The doctrine path: 7d PAPER → (operator APPROVE) → live $2 → day-30 re-run.
 */
export async function GET() {
  try {
    maybeApplyExtension();
    void maybeRunGoldenLaneAdjudication().catch(() => undefined); // v11.6 EQ-97 — window-end verdict of record + gen re-registration
    const block = await getGoldenLaneStatus();
    if (!block) return NextResponse.json({ error: "golden-lane unavailable" }, { status: 503 });
    return NextResponse.json(
      {
        ...block,
        adjudication: getGoldenLaneAdjudication(), // v11.6 — verdict of record (null until the first window closes)
        doctrine: {
          promoteMinN: PROMOTE_MIN_N,
          windowDays: WINDOW_DAYS,
          filters: getActiveLaneConfigs().map((c) => ({
            id: c.id,
            name: c.name,
            engineVersion: c.engineVersion,
            tehranHours: c.tehranHours,
            minTp1DistPct: c.minTp1DistPct,
            maxLeverage: c.maxLeverage,
            confidenceBand: c.confidenceBand,
            excludeStrategies: c.excludeStrategies,
            excludeRegimes: c.excludeRegimes,
          })),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[golden-lane] error", err);
    return NextResponse.json({ error: "golden-lane failure" }, { status: 500 });
  }
}
