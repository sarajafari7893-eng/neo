import { NextResponse } from "next/server";
import { getFlowBoard } from "@/lib/flow-scanner";

export const dynamic = "force-dynamic";

/** GET /api/flows — v8.0 multi-TF flow board (per-TF CVD/trend/structure + HTF-weighted rollup). */
export async function GET() {
  const board = await getFlowBoard();
  return NextResponse.json(board);
}
