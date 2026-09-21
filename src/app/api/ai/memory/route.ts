import { NextRequest, NextResponse } from "next/server";
import { buildEngineMemory } from "@/lib/ai-memory";

export const dynamic = "force-dynamic";

/** GET /api/ai/memory?symbol=BTCUSDT — the exact grounded object the analyst sees */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? undefined;
  const memory = await buildEngineMemory(symbol?.toUpperCase());
  return NextResponse.json({ memory });
}
