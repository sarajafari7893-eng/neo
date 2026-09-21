import { NextResponse } from "next/server";
import { getVerdictCoreState, runVerdictLearn } from "@/lib/verdict";

export const dynamic = "force-dynamic";

const MIN_RUN_GAP_MS = 45_000;
let lastManualRun = 0;

/** GET /api/verdict-core — the central core's verdict-learning state
 * (runs, lastAnswer digest, lessons derived from the gate journal). */
export async function GET() {
  try {
    const state = await getVerdictCoreState();
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[verdict-core:GET]", err);
    return NextResponse.json({ error: "verdict-core read failure" }, { status: 500 });
  }
}

/** POST /api/verdict-core — operator-triggered learning cycle (LEARN NOW):
 * studies the gate journal and persists fresh lessons to the core. */
export async function POST() {
  try {
    if (Date.now() - lastManualRun < MIN_RUN_GAP_MS) {
      return NextResponse.json({ error: "a learning cycle just ran — give it a moment", cooldownMs: MIN_RUN_GAP_MS - (Date.now() - lastManualRun) }, { status: 429 });
    }
    lastManualRun = Date.now();
    const state = await runVerdictLearn(12);
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[verdict-core:POST]", err);
    return NextResponse.json({ error: "verdict-core cycle failure" }, { status: 500 });
  }
}
