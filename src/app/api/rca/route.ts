// ── Task 81 RCA-AGENT API — LIVE root-cause & fix agent (operator question
// «آیا نیاز به یک ایجنت برای ریشه‌یابی و فیکس (LIVE و راستی‌آزمایی‌شده) لازم است؟»)
//   GET  /api/rca  → latest report + staleness (cheap, no run)
//   POST /api/rca  → { action: "run" } — full mission suite run (single-flight)
// The dashboard card auto-runs when the latest report is stale (previous
// Tehran day or >6h old) — the agent is live, not decorative.

import { NextResponse } from "next/server";
import { runRca, getRcaLatest } from "@/lib/rca-agent";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const latest = await getRcaLatest();
    // LIVE self-heal (same sanctioned pattern as maybeRunScheduledReports /
    // maybeApplyExtension riding the pulse GET): when the latest report is
    // from a previous Tehran day or older than 6h, the GET itself triggers a
    // fresh mission run — single-flight inside runRca() coalesces racers.
    // No mutation of the trading domain; the POST stays key/session-gated.
    if (latest.stale && !latest.running) {
      const report = await runRca();
      return NextResponse.json({ report, ageMs: Date.now() - report.at, stale: false, running: false });
    }
    return NextResponse.json(latest);
  } catch {
    return NextResponse.json({ report: null, ageMs: null, stale: true, running: false }, { status: 200 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== "run") {
      return NextResponse.json({ error: "unknown action — use { action: 'run' }" }, { status: 400 });
    }
    const report = await runRca();
    return NextResponse.json({ report, ageMs: 0, stale: false, running: false });
  } catch {
    return NextResponse.json({ error: "rca run failed" }, { status: 500 });
  }
}
