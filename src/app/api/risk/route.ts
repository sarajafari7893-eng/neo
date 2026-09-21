import { NextResponse } from "next/server";
import { getRiskState } from "@/lib/risk-overlay";

export const dynamic = "force-dynamic";

/** GET /api/risk — v8.1 P2 portfolio risk overlay state: clusters, drawdown sizing, verdict. */
export async function GET() {
  const { state } = await getRiskState();
  return NextResponse.json(state);
}
