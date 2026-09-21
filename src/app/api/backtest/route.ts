import { NextRequest, NextResponse } from "next/server";
import { getBacktestBundle, getLearnerAutoState } from "@/lib/backtest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET /api/backtest — last replay + runs ring + auto-tune state + scheduler */
export async function GET() {
  const [bundle, learner] = await Promise.all([getBacktestBundle(), getLearnerAutoState()]);
  return NextResponse.json({ ...bundle, learner });
}

/**
 * POST /api/backtest — DISABLED (v6.0 TOTAL AUTONOMY).
 * Manual replay / auto-tune / scheduler toggles are removed: the learner is
 * ALWAYS-ON and refreshes the learned mean on its own cadence (maybeAutoLearner
 * on the engine heartbeat, default every 6h), and the AI GOVERNOR can trigger
 * replays autonomously when its grounded telemetry shows stale evidence.
 * Manual learning control is a manual mode — removed.
 */
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    {
      error: "manual learning triggers disabled — the auto-learner is always-on and refreshes the learned mean on its own cadence; the AI governor triggers replays autonomously when evidence goes stale",
      autonomy: "total",
      note: "learning is LLM-agent-controlled; the AI SUPERVISOR flags any simulated/contaminated learning input",
    },
    { status: 423 },
  );
}
