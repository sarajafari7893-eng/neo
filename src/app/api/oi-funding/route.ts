import { NextResponse } from "next/server";
import { getOiFundBoard } from "@/lib/oi-funding";

export const dynamic = "force-dynamic";

/** GET /api/oi-funding — v8.1 P1 derivatives board: OI Δ15m/1h/4h + funding + OI notional. */
export async function GET() {
  const board = await getOiFundBoard();
  return NextResponse.json(board);
}
