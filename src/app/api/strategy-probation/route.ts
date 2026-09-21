import { NextResponse } from "next/server";
import { evaluateStrategyProbation, getProbationState, describeProbation } from "@/lib/strategy-probation";

export const dynamic = "force-dynamic";

/** GET /api/strategy-probation — v10.11 STRAT-PROBATION status (read-only).
 * The strategy-level expectancy probation (EB shrinkage + Bonferroni UCB):
 * which strategies are ON probation (margin ×0.5 + effMin +5 double-confirm),
 * the full per-strategy statistics and the last transition actions.
 * Kicks a lazy evaluation pass (30min TTL) so status is always fresh. */
export async function GET() {
  try {
    const [ev, st] = await Promise.all([evaluateStrategyProbation(), getProbationState(true)]);
    return NextResponse.json(
      {
        ts: Date.now(),
        onProbation: Object.keys(st.entered),
        lastEvalAt: st.lastEvalAt,
        lastActions: st.lastEvalSummary,
        evaluation: ev
          ? {
              at: ev.at,
              familySize: ev.familySize,
              grandMean: Number(ev.grandMean.toFixed(3)),
              tauSq: Number(ev.tauSq.toFixed(3)),
              actions: ev.actions,
              strats: ev.strats.map((s) => ({
                strategy: s.strategy,
                n: s.n,
                meanPct: Number(s.mean.toFixed(2)),
                shrunkMeanPct: Number(s.shrunkMean.toFixed(2)),
                sd: Number(s.sd.toFixed(2)),
                ucbPct: Number(s.ucb.toFixed(2)),
                inEvaluationSet: s.inEvaluationSet,
                onProbation: s.onProbation,
              })),
            }
          : null,
        describe: describeProbation(st, ev),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[strategy-probation] GET error", err);
    return NextResponse.json({ error: "strategy-probation status failure" }, { status: 500 });
  }
}
