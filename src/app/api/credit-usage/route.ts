// ── NEXUS//SIGNALS — /api/credit-usage (GET) ─────────────────────────────────
// Read-only observability for the Week-0 credit-budget skeleton
// (src/lib/credit-budget.ts + src/config/credit-budget.json).
// NOT wired into the hot path: the ledger only reports — enforcement wiring
// into src/lib/ai.ts is phase-2, blocked on operator confirmation of Z.ai
// billing rules. 500-proof by contract: any internal failure returns
// 200 {ok:false} (degraded-JSON, same doctrine as /api/sentinel) so the
// dashboard can render a clean degraded state instead of an error surface.
import { NextResponse } from "next/server";
import { CREDIT_BUDGET, getUsage } from "@/lib/credit-budget";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const now = Date.now();
    const usage = await getUsage(now);
    return NextResponse.json(
      {
        ok: true,
        at: now,
        usage,
        config: {
          rollingWindowHours: CREDIT_BUDGET.rollingWindowHours,
          rollingWindowMaxCalls: CREDIT_BUDGET.rollingWindowMaxCalls ?? null,
          weeklyCapUsdOrUnits: CREDIT_BUDGET.weeklyCapUsdOrUnits,
          offPeak: CREDIT_BUDGET.offPeak,
          tierWeights: CREDIT_BUDGET.tierWeights,
          status: "SKELETON — placeholders; enforcement wiring into ai.ts is phase-2 (blocked on operator confirming Z.ai billing rules)",
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "credit-usage ledger unavailable (fail-open — never blocks calls)" },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}
