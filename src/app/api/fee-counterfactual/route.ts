import { NextResponse } from "next/server";
import { feeAnatomy, minScoreCounterfactual } from "@/lib/fee-counterfactual";

export const dynamic = "force-dynamic";

/**
 * GET /api/fee-counterfactual — v11.4 P1 machinery (EQ-92 P1, EQ-94 mandate).
 * Every candidate change must carry a fee-aware counterfactual; this endpoint
 * produces it on demand:
 *   · anatomy: gross / fee / net decomposition of the settled clean book
 *   · minScore: sweep of nominal-minScore raises over the ledger (the
 *     TIGHTEN-family counterfactual, fee-aware, with headroom separation)
 * Query: ?windowDays=14&minScore=1,2,3,4,5,6,7,8
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const windowDays = Math.min(45, Math.max(1, parseInt(url.searchParams.get("windowDays") ?? "14", 10) || 14));
    const thresholds = (url.searchParams.get("minScore") ?? "1,2,3,4,5,6,7,8")
      .split(",")
      .map((s) => Math.min(20, Math.max(1, parseInt(s.trim(), 10) || 0)))
      .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
      .sort((a, b) => a - b);
    const [anatomy, sweep] = await Promise.all([feeAnatomy(windowDays), minScoreCounterfactual(windowDays, thresholds.length ? thresholds : [1, 2, 3, 4, 5, 6, 7, 8])]);
    return NextResponse.json({ ts: Date.now(), anatomy, minScore: sweep }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[fee-counterfactual] error", err);
    return NextResponse.json({ error: "fee-counterfactual failure" }, { status: 500 });
  }
}
