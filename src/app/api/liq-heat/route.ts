import { NextResponse } from "next/server";
import { getLiqHeatBoard } from "@/lib/liq-heatmap";

export const dynamic = "force-dynamic";

/**
 * GET /api/liq-heat — v8.1 P1 estimated liquidation heatmap board.
 * VOLUME-MAPPED ESTIMATE scaled by real OI when available — the module never
 * invents exchange position data; every surface must keep the ESTIMATE label.
 */
export async function GET() {
  const board = await getLiqHeatBoard(10);
  return NextResponse.json(board);
}
