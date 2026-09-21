import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeDurationAnalytics, persistDurationReport } from "@/lib/duration";

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/duration — DURATION LAB timing forensics (v6.7.1)
 * Operator mandate 2026-09-08: measure open-duration distribution
 * (min/max/avg/percentiles), status-rate by holding duration, and keep a
 * full evidence chain on fast-SL cases (<15min straight-to-SL) that
 * separates BE-trail fee-only exits from REAL kills.
 * Side effect (debounced 30min): persists the senior-core training report
 * to EngineSetting "duration.forensics" so the AI CORE advisor/governor can
 * read the timing evidence on their own cycles. UI polling never churns it.
 */
export async function GET() {
  try {
    const report = await computeDurationAnalytics();
    const persisted = await persistDurationReport(report);
    if (persisted) {
      // senior-core training report landed in the learning trail → surface it
      // in the AI event feed (same channel the advisor/governor audits use)
      await db.signalEvent.create({
        data: {
          type: "ENGINE",
          symbol: null,
          level: "ai",
          message: `DURATION LAB REPORT → EngineSetting "duration.forensics" · verdict ${report.diagnosis.verdict}: ${report.diagnosis.headline} · settled ${report.settledN} · median open ${report.summary.median}m · real fast-kills <15m ${report.fastKill.realKills} (never-green ${report.fastKill.neverGreenShare}%, flow-confirmed ${report.fastKill.flowConfirmShare}%) vs BE-trail fee-only ${report.fastKill.beTrailExits} · evidence: ${report.diagnosis.evidence.length} lines`,
        },
      });
    }
    return NextResponse.json({ ...report, persistedThisCall: persisted }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[duration] error", err);
    return NextResponse.json({ error: "duration analytics failure" }, { status: 500 });
  }
}
