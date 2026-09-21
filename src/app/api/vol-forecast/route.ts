import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getVolBoard } from "@/lib/vol-forecast";

export const dynamic = "force-dynamic";

/** GET /api/vol-forecast — v8.1 P2 EWMA/HAR volatility forecast board (regime-severity sorted). */
export async function GET() {
  const assets = await db.marketAsset.findMany({ orderBy: { volume24h: "desc" }, take: 24, select: { symbol: true } });
  const board = await getVolBoard(assets.map((a) => a.symbol), 12);
  return NextResponse.json(board);
}
