import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { aiSignalBrief } from "@/lib/ai";
import { feeBreakdown } from "@/lib/accounting";
import { scoreFlow } from "@/lib/flow";
import { getCalibration } from "@/lib/calibration";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/ai/signal-scan { serial } — per-card AI SCAN (R17).
 * Grounds the model with: the exact card, live consensus price, NET PnL after
 * fees, TP/SL distances, factor votes at deploy, FRESH flow re-assessment,
 * realized symbol history, calibration status.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const serial = Number(body.serial);
    if (!serial) return NextResponse.json({ error: "serial required" }, { status: 400 });

    const sig = await db.signal.findFirst({ where: { serial } });
    if (!sig) return NextResponse.json({ error: `signal NX-${serial} not found` }, { status: 404 });

    const asset = await db.marketAsset.findUnique({ where: { symbol: sig.symbol } });
    const price = asset?.price ?? sig.entryPrice;

    const isLong = sig.direction === "LONG";
    const movePct = ((price - sig.entryPrice) / sig.entryPrice) * (isLong ? 1 : -1) * 100; // UNLEVERED move %
    const heldMin = Math.max(0, (Date.now() - sig.createdAt.getTime()) / 60_000);
    const fb = feeBreakdown(sig.marginUsd, sig.leverage, movePct, heldMin);

    const open = ["ACTIVE", "TP1", "TP2"].includes(sig.status);
    const tp1Dist = ((sig.tp1 - price) / price) * 100 * (isLong ? 1 : -1);
    const slDist = ((sig.stopLoss - price) / price) * 100 * (isLong ? 1 : -1);

    // fresh flow re-assessment NOW
    const { fetchKlines } = await import("@/lib/market-feed");
    let price1hAgoPct: number | null = null;
    try {
      const candles = await fetchKlines(sig.symbol, "15m", 5);
      if (candles.length >= 5) price1hAgoPct = ((candles[candles.length - 1]!.close - candles[0]!.close) / candles[0]!.close) * 100;
    } catch {
      /* flow probe still works without the price delta */
    }
    const flowNow = await scoreFlow(sig.symbol, sig.direction as "LONG" | "SHORT", price1hAgoPct);

    // realized history for this symbol
    const history = await db.signal.findMany({
      where: { symbol: sig.symbol, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, id: { not: sig.id } },
      select: { serial: true, status: true, pnlPercent: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    });
    const cal = await getCalibration();

    const grounding = [
      "CARD CONTEXT (ground truth — cite ONLY these numbers):",
      JSON.stringify({
        card: `NX-${String(sig.serial).padStart(4, "0")}`,
        symbol: sig.symbol,
        direction: sig.direction,
        strategy: sig.strategy,
        timeframe: sig.timeframe,
        status: sig.status,
        entry: sig.entryPrice,
        livePrice: price,
        netPnlPercent: Number(fb.netPct.toFixed(2)),
        netPnlUsd: Number(fb.netUsd.toFixed(3)),
        feesUsd: Number(fb.totalFeesUsd.toFixed(3)),
        heldMinutes: Math.round(heldMin),
        ttlMinutesRemaining: Math.max(0, Math.round((sig.expiresAt.getTime() - Date.now()) / 60_000)),
        tp1DistancePct: Number(tp1Dist.toFixed(2)),
        slDistancePct: Number(slDist.toFixed(2)),
        confidenceAtDeploy: sig.confidence,
        operatorNotes: sig.operatorNotes ?? null, // operator journal → per-card AI read (loop closure)
        factorVotesAtDeploy: sig.factorsJson ? JSON.parse(sig.factorsJson) : null,
        flowReMeasuredNow: { verdict: flowNow.verdict, score: flowNow.score, oiWeight: flowNow.oiWeight, reasons: flowNow.reasons.slice(0, 3), metrics: { oiDelta1h: flowNow.metrics.oiDelta1h, cvdNetPctOfVol: flowNow.metrics.cvdNetPctOfVol, funding8h: flowNow.metrics.funding8h, crowdLongShort: flowNow.metrics.crowdLongShort } },
        realizedSymbolHistory: history,
        calibration: { status: cal.status, settled: cal.settled },
        stillOpen: open,
      }),
      "RULES: open your summary with the serial (NX-xxxx). Every number from the context. Missing figure ⇒ say 'data not available yet'. If NET PnL < -35% recommend CLOSE; if TP1 not yet hit and flow CONFLICTS (<-8) lean PARTIAL/CLOSE; else HOLD with levels.",
    ].join("\n");

    const brief = await aiSignalBrief(grounding);

    return NextResponse.json({
      serial: sig.serial,
      card: `NX-${String(sig.serial).padStart(4, "0")}`,
      scannedAt: new Date().toISOString(),
      measured: {
        livePrice: price,
        netPnlPercent: Number(fb.netPct.toFixed(2)),
        netPnlUsd: Number(fb.netUsd.toFixed(3)),
        feesUsd: Number(fb.totalFeesUsd.toFixed(3)),
        heldMinutes: Math.round(heldMin),
        ttlMinutesRemaining: Math.max(0, Math.round((sig.expiresAt.getTime() - Date.now()) / 60_000)),
      },
      flowNow: { verdict: flowNow.verdict, score: flowNow.score, reasons: flowNow.reasons.slice(0, 3) },
      brief,
    });
  } catch (err) {
    console.error("[ai/signal-scan]", err);
    return NextResponse.json({ error: "signal scan failure" }, { status: 500 });
  }
}
