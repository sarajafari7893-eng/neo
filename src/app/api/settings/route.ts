import { NextResponse } from "next/server";
import { getGateSettings, describeGate, gateClamps } from "@/lib/gate-settings";

export const dynamic = "force-dynamic";

/** GET /api/settings — current deployment gate tunables (read-only view) */
export async function GET() {
  const gate = await getGateSettings();
  // audit fix 2026-09-08: clamps now read the LIVE clamp table (was hardcoded
  // stale quartet reporting minScore floor 20 while the real floor is 12)
  return NextResponse.json({ gate, describe: describeGate(gate), clamps: gateClamps() });
}

const AUTONOMY_NOTICE = {
  error:
    "MANUAL MODES REMOVED (v6.0) — deployment gates are tuned EXCLUSIVELY by the AI governor agent: it receives measured telemetry every cycle, proposes gate changes that the core validates against hard clamps, and every change is audited in the decision log. No operator override exists.",
  autonomy: true,
};

/**
 * v6.0 operator mandate: «هیچ حالت دستی برای یادگیری و استقرار نباید باشه» —
 * deployment control is agent-controlled; the manual gate PUT is gone.
 */
export async function PUT() {
  return NextResponse.json(AUTONOMY_NOTICE, { status: 405 });
}
