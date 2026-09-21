import { NextResponse } from "next/server";
import { rawCalStatus, armRawCal, disarmRawCal } from "@/lib/raw-cal";
import { computeRawcalPace, milestoneView, recentBlocks } from "@/lib/rawcal-telemetry"; // v9.2 pace monitor
import { computeRawcalQuality } from "@/lib/rawcal-quality"; // v9.3 sample quality lab — R6 data-health gate

export const dynamic = "force-dynamic";

/**
 * RAW-CAL capture-mode control (v9.1, operator mandate 2026-09-13) +
 * v9.2 PACE MONITOR (operator mandate 2026-09-13: «پایش ریتم صدور RAW-CAL و
 * رشد کتاب EPOCH-2 به سمت ۱۰۰»).
 *
 * GET  /api/rawcal            → full status (armed, issued, progress toward
 *                               the 100-settled AI CALIBRATION bar, rails)
 *                               + pace: issue/settle rates, observed spacing,
 *                               ETA to the bar, pipeline projection, cadence
 *                               grade, stall detection, milestone ledger,
 *                               recent issuance-block notes, book-growth
 *                               sparkline series, v9.3 sample QUALITY cohort
 *                               health (per-sample scores, R6 gate verdict,
 *                               warnings) so the R6 calibration rests on
 *                               healthy data.
 * POST /api/rawcal            → { action: "arm" | "disarm", reason?: string }
 *                               Arm: unfiltered signal issuance for data
 *                               capture only (spacing + open-cap rails).
 *                               Disarm: return to filtered operation under
 *                               central-intelligence command. The mode ALSO
 *                               auto-cancels itself when the EPOCH-2 book
 *                               reaches 100 settled and the new calibration
 *                               takes command.
 */
export async function GET() {
  try {
    const status = await rawCalStatus();
    const [pace, milestones, blocks, quality] = await Promise.all([
      computeRawcalPace().catch(() => null),
      milestoneView().catch(() => null),
      recentBlocks(12).catch(() => []),
      computeRawcalQuality().catch(() => null),
    ]);
    return NextResponse.json({ ...status, pace, milestones, blocks, quality }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[rawcal] status error", err);
    return NextResponse.json({ error: "rawcal status failure" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string };
    if (body.action === "arm") {
      const state = await armRawCal("OPERATOR (dashboard/API)");
      return NextResponse.json({ ok: true, state }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "disarm") {
      const state = await disarmRawCal(body.reason?.slice(0, 160) || "operator command — return to filtered operation", false);
      return NextResponse.json({ ok: true, state }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ ok: false, error: "action must be 'arm' or 'disarm'" }, { status: 400 });
  } catch (err) {
    console.error("[rawcal] action error", err);
    return NextResponse.json({ ok: false, error: "rawcal action failure" }, { status: 500 });
  }
}
