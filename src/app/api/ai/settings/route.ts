// ── /api/ai/settings — AI-CORE operator settings (v6.7.4 THOUGHT-CORE) ──
// The deployment gates stay governor-only (see /api/settings); THIS route owns
// the AI infrastructure mode — the operator may upgrade/downgrade the LLM core
// to reasoning ("thought") mode. Every change is audited into the event feed.

import { NextResponse } from "next/server";
import { getAiSettings, putAiSettings, describeAi, THOUGHT_CHANNELS } from "@/lib/ai-settings";

export const dynamic = "force-dynamic";

/** GET — current AI-core settings + the per-channel thought plan. */
export async function GET() {
  const ai = await getAiSettings();
  return NextResponse.json({ ai, describe: describeAi(ai), channels: THOUGHT_CHANNELS });
}

/** PUT — operator toggle: { thoughtMode: 0 | 1 }. Clamped, persisted, audited. */
export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = body as { thoughtMode?: unknown };
  if (typeof b.thoughtMode !== "number" || ![0, 1].includes(b.thoughtMode)) {
    return NextResponse.json({ error: "thoughtMode must be 0 (fast) or 1 (thought)" }, { status: 400 });
  }
  const before = await getAiSettings();
  const ai = await putAiSettings({ thoughtMode: b.thoughtMode });
  if (before.thoughtMode !== ai.thoughtMode) {
    // audit trail in the event feed (best-effort — never block the toggle)
    try {
      const { fireEvent } = await import("@/lib/engine");
      await fireEvent(
        null,
        null,
        "SYSTEM",
        "info",
        ai.thoughtMode === 1
          ? `AI THOUGHT-CORE ENGAGED — judgment channels (analyst chat · card brief · governor) now reason step-by-step before answering; deep-learn stays thought, symbol-scan stays fast (latency contract)`
          : `AI THOUGHT-CORE OFF — all LLM channels reverted to fast mode (lower latency, shallower reasoning)`
      );
    } catch {
      /* audit must never break the toggle */
    }
  }
  return NextResponse.json({ ai, describe: describeAi(ai), channels: THOUGHT_CHANNELS });
}
