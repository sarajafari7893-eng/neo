import { NextResponse } from "next/server";
import { getFuturesLive, maybeFuturesSample, ensureBackfill, QUADRANT_META } from "@/lib/futures-taxonomy";

export const dynamic = "force-dynamic";

/**
 * v10.22 FUTURES TAXONOMY ENGINE (operator mandate: store → learn → best filter)
 *
 * GET /api/futures
 *   → live five-family snapshot for the anchors (BTC/ETH),
 *     quadrant grid state (OI × Price four-quadrant),
 *     24h BTC series, services honesty block (tape/liq),
 *     and the EDGE study: quadrant truth table + ranked family filters +
 *     signal attribution (book joined to quadrant context) + bestFilter.
 *
 * POST /api/futures { action: "sample" | "backfill" }
 *   → force-trigger the sampler / the one-shot 1h backfill (telemetry-only,
 *     no deploy-path authority — safe to expose to the operator dashboard).
 */
export async function GET() {
  try {
    const data = await getFuturesLive();
    return NextResponse.json({ ...data, quadrantMeta: QUADRANT_META }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[futures] live error", err);
    return NextResponse.json({ error: "futures taxonomy failure" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action === "sample") {
      const r = await maybeFuturesSample(true);
      return NextResponse.json({ ok: true, ...r }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "backfill") {
      const r = await ensureBackfill(true);
      return NextResponse.json({ ok: true, backfill: r }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ ok: false, error: "action must be 'sample' or 'backfill'" }, { status: 400 });
  } catch (err) {
    console.error("[futures] action error", err);
    return NextResponse.json({ ok: false, error: "futures action failure" }, { status: 500 });
  }
}
