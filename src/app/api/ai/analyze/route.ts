import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { aiAnalyzeSymbol } from "@/lib/ai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/ai/analyze { symbol } — structured symbol analysis */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol = String(body.symbol ?? "").toUpperCase();
    if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

    const asset = await db.marketAsset.findUnique({ where: { symbol } });
    const price = asset?.price ?? Number(body.price) ?? 0;
    const change24h = asset?.change24h ?? 0;

    const analysis = await aiAnalyzeSymbol(symbol, price, change24h);
    return NextResponse.json({ symbol, price, change24h, ...analysis });
  } catch (err) {
    console.error("[ai/analyze]", err);
    return NextResponse.json({ error: "ai failure" }, { status: 500 });
  }
}
