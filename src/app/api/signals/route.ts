import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toSignalDTO } from "@/lib/stats";

export const dynamic = "force-dynamic";

/** GET /api/signals?status=ACTIVE&direction=LONG&symbol=BTCUSDT&limit=40 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const direction = sp.get("direction");
  const symbol = sp.get("symbol");
  const limit = Math.min(100, Number(sp.get("limit") ?? 40));

  const where: Record<string, unknown> = {};
  if (status && status !== "ALL") where.status = status === "OPEN" ? { in: ["ACTIVE", "TP1", "TP2"] } : status;
  if (direction && direction !== "ALL") where.direction = direction;
  if (symbol && symbol !== "ALL") where.symbol = symbol;

  const signals = await db.signal.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ signals: signals.map(toSignalDTO) });
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
