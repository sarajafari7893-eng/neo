import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/history?symbol=BTCUSDT&hours=24
 * Returns ascending price points for overlay charts.
 * Falls back to the asset sparkline when PricePoints are sparse.
 */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").toUpperCase();
  const hours = Math.min(48, Math.max(1, Number(req.nextUrl.searchParams.get("hours") ?? 24)));
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const asset = await db.marketAsset.findUnique({ where: { symbol } });
  if (!asset) return NextResponse.json({ error: "unknown symbol" }, { status: 404 });

  const cutoff = new Date(Date.now() - hours * 3600_000);
  const points = await db.pricePoint.findMany({
    where: { symbol, createdAt: { gte: cutoff } },
    orderBy: { createdAt: "asc" },
    take: 240,
    select: { price: true, createdAt: true },
  });

  let series = points.map((p) => ({ t: p.createdAt.toISOString(), price: p.price }));

  // sparse fallback: interleave sparkline (latest 48 ticks, evenly spaced)
  if (series.length < 8) {
    const spark = JSON.parse(asset.sparkline) as number[];
    const now = Date.now();
    series = spark.map((price, i) => ({
      t: new Date(now - (spark.length - 1 - i) * ((hours * 3600_000) / spark.length)).toISOString(),
      price,
    }));
  }

  return NextResponse.json({
    symbol,
    price: asset.price,
    hours,
    count: series.length,
    series,
  });
}
