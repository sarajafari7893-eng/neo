import { NextResponse } from "next/server";
import { getWhaleFlowBundle, whaleGroundingLines } from "@/lib/whales";

export const dynamic = "force-dynamic";

/** GET /api/market/whales — live whale tape + smart-money positioning.
 * v6.4.2: FLOW-RULED — the lens follows the engine's dynamic scan domain
 * (rotating tape sweep + open-signal / whale-hit pins), NOT a fixed top-N
 * symbol list. Coverage stats ship in the bundle for honest display. */
export async function GET() {
  try {
    const bundle = await getWhaleFlowBundle();
    return NextResponse.json({ ts: Date.now(), bundle, grounding: whaleGroundingLines(bundle) });
  } catch (err) {
    console.error("[market/whales]", err);
    return NextResponse.json({ error: "whale telemetry failed" }, { status: 500 });
  }
}
