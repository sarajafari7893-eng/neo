import { NextResponse } from "next/server";
import { getLiquidationSnapshot } from "@/lib/liquidations";

export const dynamic = "force-dynamic";

/** GET /api/liquidations — proxy to liq-service (:3010) — honest null when down. */
export async function GET() {
  const snap = await getLiquidationSnapshot();
  if (!snap) return NextResponse.json({ online: false, status: null, recent: [], bySymbol: {} });
  return NextResponse.json({ online: true, ...snap });
}
