import { NextResponse } from "next/server";
import { dqSnapshot } from "@/lib/dq-oracles";

// ── NEXUS//SIGNALS — /api/dq (GET) ───────────────────────────────────────────
// Data-quality oracles: OKX v5 perp mirror + Coinlore + CoinPaprika measured
// AGAINST the Binance reference plane (مرجع). Verdict GREEN/AMBER/RED.
// Recreated (trace 1a1849f647778885) after the 22:54Z golden-restore wipe —
// original built in trace 1a181db841517571, ladder upgrade in 1a184429d4bd0d05.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "BTCUSDT").toUpperCase().slice(0, 12);
  try {
    const report = await dqSnapshot(symbol);
    return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // fail-soft: never 500 the dashboard over a DQ probe
    return NextResponse.json(
      { ok: false, symbol, error: String(e).slice(0, 200) },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}
