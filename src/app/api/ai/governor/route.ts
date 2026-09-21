import { NextResponse } from "next/server";
import { getGovernorState } from "@/lib/governor";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET /api/ai/governor — governor config + decision log */
export async function GET() {
  const state = await getGovernorState();
  return NextResponse.json(state);
}

/**
 * POST /api/ai/governor — DISABLED (v6.0 TOTAL AUTONOMY).
 * ENGAGE/DISENGAGE, config edits and forced cycles are all removed: the
 * governor (the LLM analyst wired into the core) is ALWAYS ENGAGED and
 * self-schedules its grounded cycles from the engine heartbeat. Its decisions
 * are validated against the same clamps as before, applied autonomously and
 * audited. Manual control of the controlling agent is a manual mode — removed.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "manual governor control disabled — the AI governor is always engaged and self-schedules its grounded decision cycles",
      autonomy: "total",
      note: "the governor tunes only clamped tunables; every action is audited; the AI SUPERVISOR watches it",
    },
    { status: 423 },
  );
}
