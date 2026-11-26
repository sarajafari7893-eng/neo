import { NextResponse } from "next/server";
import { getOosTracker } from "@/lib/oos-tracker";

export const dynamic = "force-dynamic";

// ── v11.6 OOS TRACKER API (EQ-97 ③-b) ───────────────────────────────────────
// Live out-of-sample progress toward the STRATEGY-VALIDATION-PROTOCOL
// promotion bar (300 total / 60 per strategy), with trailing-14d settle pace
// and ETA. Consumed by the supervisor-cron senior review (replaces the static
// "insufficient OOS n" line) and available to any dashboard.

export async function GET() {
  try {
    const tracker = await getOosTracker();
    return NextResponse.json(tracker, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 140) }, { status: 500 });
  }
}
