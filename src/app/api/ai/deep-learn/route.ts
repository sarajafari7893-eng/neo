import { NextResponse } from "next/server";
import { buildTp3Lab, getDeepLearnState } from "@/lib/tp3-lab";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/ai/deep-learn — TP3 deep-lab calculator + deep-learn lessons state */
export async function GET() {
  const [lab, state] = await Promise.all([buildTp3Lab(14), getDeepLearnState()]);
  return NextResponse.json({ lab, state });
}

/**
 * POST /api/ai/deep-learn — DISABLED (v6.0 TOTAL AUTONOMY).
 * The operator-forced research cycle is removed: the deep-learn loop is fully
 * autonomous — maybeAutoDeepLearn() fires on the engine heartbeat every ~30min,
 * collects fresh TP3/SL outcomes, runs the LLM research Q&A and persists the
 * lessons by itself. No manual triggers, no operator timing control.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "manual research triggers disabled — the deep-learn loop runs autonomously on the engine heartbeat (every ~30min, as fresh TP3/SL outcomes settle)",
      autonomy: "total",
      note: "learning is LLM-agent-controlled; the AI SUPERVISOR quarantines any ungrounded lesson before it reaches agents",
    },
    { status: 423 },
  );
}
