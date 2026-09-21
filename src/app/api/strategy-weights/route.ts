import { NextRequest, NextResponse } from "next/server";
import { getStrategyWeights, putStrategyWeights, describeStrategyWeights, STAGED_PROPOSAL, STRATEGY_LIST } from "@/lib/strategy-weights";
import { fireEvent } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** GET /api/strategy-weights — v10.6 per-strategy sizing state (read-only). */
export async function GET() {
  const sw = await getStrategyWeights(true);
  return NextResponse.json({
    ...sw,
    describe: describeStrategyWeights(sw),
    stagedProposal: STAGED_PROPOSAL,
    strategies: STRATEGY_LIST,
    clamp: [0.25, 2.0],
  });
}

/** POST /api/strategy-weights — operator decision channel.
 * Body: { enabled?: boolean, weights?: Record<string, number> }
 * The SUPERVISOR stages weights; ONLY an explicit operator POST (or audited
 * script) may enable the module — mirrors the advisor approval invariant. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { enabled?: boolean; weights?: Record<string, number> };
    const cur = await getStrategyWeights(true);
    const next = await putStrategyWeights({ enabled: body.enabled, weights: body.weights }, "OPERATOR-API");
    const becameActive = next.enabled && !cur.enabled;
    await fireEvent(
      null,
      null,
      "ENGINE",
      "ai",
      `STRATEGY WEIGHTS v10.6: enabled ${cur.enabled ? "true" : "false"} → ${next.enabled ? "true" : "false"} · ${STRATEGY_LIST.map((s) => `${s} ×${cur.weights[s] ?? 1}→×${next.weights[s] ?? 1}`).join(" · ")} — per-strategy margin multiplier ${next.enabled ? "ACTIVE on the deploy path" : "neutral (module off)"} · ${describeStrategyWeights(next)}`,
    );
    return NextResponse.json({ ok: true, becameActive, ...next, describe: describeStrategyWeights(next) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}
