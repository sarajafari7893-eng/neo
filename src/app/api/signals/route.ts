import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toSignalDTO } from "@/lib/stats";
import { ENGINE_VERSION } from "@/lib/engine";

export const dynamic = "force-dynamic";

// ── v11.5 PUBLIC SIGNALS FEED (operator question 2026-10-12: «آیا میشود از
// سیگنالهای صادر شده API گرفت تا در داشبورد دیگر استفاده شود؟») ────────────
// READ-ONLY feed of every emitted signal, CORS-open so ANY external dashboard
// can consume it directly from the browser (no key needed for reads — writes
// stay gated by the control-plane middleware). POST remains 423 (total
// autonomy doctrine: deployment is 100% engine-autonomous).
//
//   GET /api/signals
//     ?status=ACTIVE|OPEN|TP1|TP2|TP3|SL|EXPIRED|CLOSED|ALL   (default ALL)
//     ?direction=LONG|SHORT|ALL                                (default ALL)
//     ?symbol=BTCUSDT                                          (exact match)
//     ?since=2026-10-12T00:00:00Z | 1791760000000              (createdAt ≥)
//     ?limit=40                                                (1..500, default 40)
//     ?format=full|compact                                     (default full)
//
//   compact → one flat row per signal for cheap external widgets:
//     { serial, symbol, direction, strategy, status, confidence,
//       entryPrice, stopLoss, tp1, tp2, tp3, leverage, marginUsd,
//       pnlPercent, reachedTp, createdAt, closedAt, tags }
//
// Response envelope: { meta: { engine, generatedAt, count, limit }, signals: [...] }
// CORS: Access-Control-Allow-Origin: * on GET/OPTIONS.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** GET /api/signals?status=ACTIVE&direction=LONG&symbol=BTCUSDT&limit=40 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const direction = sp.get("direction");
  const symbol = sp.get("symbol");
  const sinceRaw = sp.get("since");
  const format = sp.get("format") === "compact" ? "compact" : "full";
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit") ?? 40) || 40));

  const where: Record<string, unknown> = {};
  if (status && status !== "ALL") where.status = status === "OPEN" ? { in: ["ACTIVE", "TP1", "TP2"] } : status;
  if (direction && direction !== "ALL") where.direction = direction;
  if (symbol && symbol !== "ALL") where.symbol = symbol.toUpperCase();
  if (sinceRaw) {
    const ms = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw);
    if (Number.isFinite(ms)) where.createdAt = { gte: new Date(ms) };
  }

  const signals = await db.signal.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const body =
    format === "compact"
      ? signals.map((s) => ({
          serial: s.serial,
          symbol: s.symbol,
          direction: s.direction,
          strategy: s.strategy,
          status: s.status,
          confidence: s.confidence,
          entryPrice: s.entryPrice,
          stopLoss: s.stopLoss,
          tp1: s.tp1,
          tp2: s.tp2,
          tp3: s.tp3,
          leverage: s.leverage,
          marginUsd: s.marginUsd,
          pnlPercent: s.pnlPercent,
          reachedTp: s.reachedTp,
          createdAt: s.createdAt.toISOString(),
          closedAt: s.closedAt?.toISOString() ?? null,
          tags: s.tags ? s.tags.split(",").filter(Boolean) : [],
        }))
      : signals.map(toSignalDTO);

  return NextResponse.json(
    {
      meta: {
        engine: ENGINE_VERSION,
        generatedAt: new Date().toISOString(),
        count: body.length,
        limit,
        format,
        note: "read-only public feed — GET is keyless + CORS-open; deployment is engine-autonomous (POST 423)",
      },
      signals: body,
    },
    { headers: CORS },
  );
}

/**
 * POST /api/signals — DISABLED (v6.0 TOTAL AUTONOMY).
 * The operator-forced deployment path (which bypassed the gates) is removed:
 * deployment is 100% autonomous — the trigger bus → confluence/flow/regime/
 * memory gates → AI GOVERNOR supervision is the ONLY deploy path. Manual
 * deployment is exactly the un-audited flow the AI SUPERVISOR's no-manual,
 * no-simulation mandate exists to prevent.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "manual deployment disabled — signals deploy only via the autonomous trigger-bus → governor-gated engine",
      autonomy: "total",
      note: "no manual mode for deployment or learning; the AI SUPERVISOR enforces zero hallucination / zero simulation",
    },
    { status: 423 },
  );
}
