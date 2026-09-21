import { NextResponse } from "next/server";
import { buildSreReport, runSreDaily } from "@/lib/sre-daily";

export const dynamic = "force-dynamic";

/** GET /api/report/sre — preview the senior-engineer report WITHOUT sending
 * (also returns the UI-canary table for the dashboard). */
export async function GET() {
  try {
    const report = await buildSreReport();
    return NextResponse.json(
      { ok: true, canary: report.canary, canaryOk: report.canaryOk, text: report.text },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[report/sre] build error", err);
    return NextResponse.json({ ok: false, error: "engineering daily compilation failed" }, { status: 500 });
  }
}

/** POST /api/report/sre — send the v9.6 ENGINEERING DAILY to the operator as
 * message #2 right after the daily performance report. Hard invariant: AT MOST
 * ONE SUCCESSFUL SEND PER TEHRAN CALENDAR DAY (mirror of the daily-report
 * guard) — cron misfires can never spam the operator chat. */
export async function POST() {
  try {
    const r = await runSreDaily();
    return NextResponse.json({ ok: r.ok, skipped: r.skipped, error: r.error, text: r.text }, { status: r.ok ? 200 : r.skipped ? 200 : 502 });
  } catch (err) {
    console.error("[report/sre] send error", err);
    return NextResponse.json({ ok: false, error: "engineering daily send failed" }, { status: 500 });
  }
}
