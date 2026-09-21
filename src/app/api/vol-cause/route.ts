import { NextResponse } from "next/server";
import { captureTopVolCauses, settlePendingVolCauses, learnVolCauses, getVolCauseBoard } from "@/lib/volCause";

export const dynamic = "force-dynamic";

/**
 * GET /api/vol-cause — TOP-VOLATILITY FORENSICS board (v6.4)
 * Capture (top-|Δ24h| entries → cause attribution), settle (real fwd
 * returns) and learn (per-cause expectancy) all run throttled inside the
 * lib; this route always answers from persisted state, never blocking on
 * upstream exchanges.
 */
export async function GET() {
  try {
    // fire-and-forget — throttled inside the lib (3min capture / 2min settle)
    void captureTopVolCauses();
    void settlePendingVolCauses()
      .then(() => learnVolCauses())
      .catch(() => undefined);

    const board = await getVolCauseBoard();
    return NextResponse.json(board, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[vol-cause] error", err);
    return NextResponse.json({ error: "vol-cause unavailable" }, { status: 500 });
  }
}
