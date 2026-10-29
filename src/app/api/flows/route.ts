import { NextResponse } from "next/server";
import { getFlowBoard, flowScanHealth } from "@/lib/flow-scanner";
import { getFeedStatus } from "@/lib/market-feed";
import { mirrorHealth } from "@/lib/binance-mirror"; // v14.0 — Binance mirror health (bybit-feed retired)
import { featureScaleHealth } from "@/lib/feature-scale";

export const dynamic = "force-dynamic";

/** GET /api/flows — v8.0 multi-TF flow board (per-TF CVD/trend/structure + HTF-weighted rollup).
 *  DATA-QUALITY SURFACING (2026-10-21, v14.0 Binance-only): the response
 *  carries an honest dataQuality block — which Binance kline plane fed the
 *  board (BINANCE/BINANCE-SPOT/MIXED), fallback counters, feed freshness.
 *  Silent starvation (the 25-day frozen board) can never hide again. */
export async function GET() {
  const board = await getFlowBoard();
  const fh = flowScanHealth();
  const feed = getFeedStatus();
  return NextResponse.json({
    ...board,
    dataQuality: {
      feedSource: feed.source,
      feedHost: feed.host,
      feedFallbackVenue: feed.fallbackVenue,
      feedConsecutiveFailures: feed.consecutiveFailures,
      klinePlane: {
        fapiFail: fh.fapiFail,
        mirrorOk: fh.mirrorOk,
        mirrorFail: fh.mirrorFail,
        spotMirrorOk: fh.spotOk,
        mirrorLastOkAt: fh.mirror.lastOkAt,
      },
      boardAgeMs: board.rows.length > 0 ? Date.now() - Math.max(...board.rows.map((r) => r.at)) : null,
      staleRows: board.rows.filter((r) => Date.now() - r.at > 30 * 60_000).length,
      featureScale: featureScaleHealth(),
    },
  });
}
