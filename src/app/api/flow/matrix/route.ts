import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureFlow, getFlowHistory, getFlowStatus } from "@/lib/flow";

export const dynamic = "force-dynamic";

/**
 * GET /api/flow/matrix — per-symbol order-flow matrix (top-14 by volume).
 * Same inputs the deployment flow-gate reads; includes OI Δ1h history rings.
 */
export async function GET() {
  try {
    const assets = await db.marketAsset.findMany({ orderBy: { volume24h: "desc" }, take: 14 });
    await ensureFlow(assets.map((a) => a.symbol));
    const flowStatus = getFlowStatus();

    const rows = await Promise.all(
      assets.map(async (a) => {
        const m = await import("@/lib/flow").then((mod) => mod.fetchFlowMetrics(a.symbol));
        return {
          symbol: a.symbol,
          price: a.price,
          change24h: a.change24h,
          volume24h: a.volume24h,
          metrics: m,
          history: getFlowHistory(a.symbol).slice(-24),
        };
      })
    );

    rows.sort((x, y) => Math.abs(y.metrics?.oiDelta1h ?? 0) - Math.abs(x.metrics?.oiDelta1h ?? 0));

    const fundingExtreme = rows.find((r) => r.metrics?.funding8h !== null && r.metrics?.funding8h !== undefined && Math.abs(r.metrics.funding8h) > 0.03);

    return NextResponse.json({
      status: flowStatus,
      fundingExtreme: fundingExtreme ? { symbol: fundingExtreme.symbol, funding8h: fundingExtreme.metrics?.funding8h ?? 0 } : null,
      rows: rows.map((r) => ({
        symbol: r.symbol,
        price: r.price,
        change24h: r.change24h,
        oiDelta1h: r.metrics?.oiDelta1h ?? null,
        oiDelta10m: r.metrics?.oiDelta10m ?? null,
        oiValueUsd: r.metrics?.oiValueUsd ?? null,
        cvdNetPctOfVol: r.metrics?.cvdNetPctOfVol ?? null,
        takerRatio: r.metrics?.takerRatio ?? null,
        crowdLongShort: r.metrics?.crowdLongShort ?? null,
        funding8h: r.metrics?.funding8h ?? null,
        history: r.history,
      })),
    });
  } catch (err) {
    console.error("[flow/matrix]", err);
    return NextResponse.json({ error: "flow matrix failure" }, { status: 500 });
  }
}
