import { NextResponse } from "next/server";
import { nearMissState } from "@/lib/near-miss";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/near-miss — v10.13+v10.14 NEAR-MISS EVIDENCE PROGRAM feed
 * (operator APPROVE 2026-09-18T18:58Z msg 861802415 and APPROVE
 * 2026-09-19T08:56Z msg 861802419: «پیشنهادات سوپروایزر رو کامل و مهندسی
 * انجام بده»).
 *
 * Serves the three paper-only evidence arms:
 *  · nm-score   — score-band rejects |adjScore| ∈ [0.85, 1.0)×effMin
 *                 (supervisor proposal msg 3677), hypothetical admission
 *  · nm-barrier — VOL-BARRIER rejects with t1r ∈ (cap, 1.5×cap]
 *                 (supervisor proposal 2026-09-18T18:53Z), hypothetical
 *                 1.5×cap barrier TTL — v10.14: cap is REGIME-ADAPTIVE
 *                 (volBarrierAdaptive=1) and every row carries volPctile +
 *                 capUsed + baseCap metadata (BARRIER-CAP-NEAR-MISS
 *                 counterfactual audit of the widening itself)
 *  · nm-gate    — memory-gate-suppressed score-passing candidates
 *                 (supervisor proposal msg 3920 GATE-NEAR-MISS), hypothetical
 *                 admission — the gate's opportunity-cost cohort
 * Each arm reports the rolling-30 settled cohort with Wilson-LB95, net USD
 * and v10.14 SQN-style R statistics (√N × mean(R)/std(R), raw + 10% trimmed).
 * gateDecision applies the msg-3920 rule: ≥30 settles with positive
 * counterfactual expectancy → FILE_KNOB_ADJUST (SQN upgrade via advisor);
 * negative → KEEP_GATE. gateSqn snapshots the LIVE memory-gate windows
 * (legacy mean-% vs SQN side by side). ZERO live risk: paper records only —
 * no orders, no ledger rows, no EngineSetting writes.
 */
export async function GET() {
  try {
    const s = await nearMissState();
    let gateSqn: Awaited<ReturnType<typeof import("@/lib/engine")["memoryGateSqnSnapshot"]>> | null = null;
    try {
      const { memoryGateSqnSnapshot } = await import("@/lib/engine");
      gateSqn = memoryGateSqnSnapshot();
    } catch {
      /* engine module unavailable (e.g. build-time) — feed the arms anyway */
    }
    return NextResponse.json({ ok: true, data: { ...s, gateSqn } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[near-miss] GET error", err);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "near-miss state unavailable" }, { status: 500 });
  }
}
