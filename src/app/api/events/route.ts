import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/events?limit=40
 * Returns the event feed + `linked` — the newest events that carry a signalId
 * (drives the TERMINAL "Signal Links" rail so it always has data as long as
 * any signal-attached event exists).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(120, Number(url.searchParams.get("limit") ?? 40));

  const [events, linked] = await Promise.all([
    db.signalEvent.findMany({ orderBy: { createdAt: "desc" }, take: limit }),
    db.signalEvent.findMany({
      where: { signalId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
  ]);

  const map = (e: (typeof events)[number]) => ({
    id: e.id,
    signalId: e.signalId,
    type: e.type,
    symbol: e.symbol,
    message: e.message,
    level: e.level,
    createdAt: e.createdAt.toISOString(),
  });

  return NextResponse.json({ events: events.map(map), linked: linked.map(map) });
}
