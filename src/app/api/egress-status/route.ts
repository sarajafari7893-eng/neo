import { NextResponse } from "next/server";
import { fapiEgressStatus, fapiGateStats } from "@/lib/fapi-gate";
import { getFeedStatus } from "@/lib/market-feed";

export const dynamic = "force-dynamic";

/**
 * GET /api/egress-status — v12.0 Task 44-② egress/IP management telemetry.
 * The rotating NAT pool + Binance named-IP bans picture in one place:
 * sampled current egress IP, every named banned pool IP with its real window,
 * the global silence window, and the rotation-aware early-probe counters.
 */
export async function GET() {
  return NextResponse.json(
    {
      ts: Date.now(),
      egress: fapiEgressStatus(),
      gate: fapiGateStats(),
      feed: getFeedStatus(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
