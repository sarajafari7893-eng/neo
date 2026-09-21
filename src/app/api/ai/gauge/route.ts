import { NextResponse } from "next/server";
import { gateLive, gateStats, gateRecentBlocks, gateRecentDeploys, gateJournalHealth, gateJournalReady, gateJournalRefresh } from "@/lib/gate-journal";
import { getVerdictCoreState } from "@/lib/verdict";
import { getGateSettings, describeGate } from "@/lib/gate-settings";
import type { GateGaugeDTO } from "@/lib/api-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/gauge — the v8.2 GATE GAUGE feed (operator: «موتور گیج»).
 * Serves the live confirm/reject boundary: latest verdict per symbol|direction
 * (nearest-to-gate first), the 6h reason ledgers, hard-gate blocks, recent
 * deployments, journal health, and the VERDICT-CORE learning state
 * (runs / lastAnswer / lessons) that the central core derived from this journal.
 *
 * v8.2.1: ready() hydrates this route's module instance from the JSONL and
 * refresh() tail-ingests whatever the ENGINE's instance wrote since — without
 * these, Turbopack's per-route compilation left the gauge reading EMPTY rings
 * forever (operator bug report: «gate gauge کار نمی کند و دیتا ندارد»).
 */
export async function GET() {
  try {
    await gateJournalReady();
    await gateJournalRefresh(0); // force: the 8s operator poll is the liveness heartbeat
    const [gate, core] = await Promise.all([getGateSettings(), getVerdictCoreState()]);
    const payload: GateGaugeDTO = {
      ts: Date.now(),
      gate: { minScore: gate.minScore, describe: describeGate(gate) },
      live: gateLive(16),
      stats: gateStats(6),
      blocks: gateRecentBlocks(8),
      deploys: gateRecentDeploys(6),
      core: {
        runs: core.runs,
        lastRunAt: core.lastRunAt,
        lastAnswer: core.lastAnswer,
        lessons: core.lessons.map((l) => ({ at: l.at, scope: l.scope, pattern: l.pattern, action: l.action, label: l.label, confidence: l.confidence })),
      },
      health: gateJournalHealth(),
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[gauge] error", err);
    return NextResponse.json({ error: "gauge failure" }, { status: 500 });
  }
}
