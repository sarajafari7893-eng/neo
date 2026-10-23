import { NextResponse } from "next/server";
import { recordCascadeAlert, cascadeFreezes } from "@/lib/cascade-alerts";

// ── v12.10 internal ingest — price-ws tick-velocity cascade alerts (:3003 → :3000) ──
// POST { symbol, side: UP|DOWN, movePct, windowMs, lane, at }
// Freezes BOTH-direction machine deploys for the symbol for 10min (re-fires extend).
// GET — active freezes for the dashboard / supervisor grounding.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // External access is already gated by the proxy CONTROL_GATE (mutations need
  // x-nexus-key / session; loopback peers pass open — same doctrine as every
  // other mutating route). price-ws posts from localhost, no extra guard here.
  try {
    const body = (await req.json()) as {
      symbol?: string; side?: string; movePct?: number; windowMs?: number; lane?: string; at?: number;
    };
    const symbol = String(body.symbol ?? "").toUpperCase();
    if (!symbol.endsWith("USDT") || typeof body.movePct !== "number" || !Number.isFinite(body.movePct)) {
      return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
    }
    const rec = recordCascadeAlert({
      symbol,
      side: body.side === "UP" ? "UP" : "DOWN",
      movePct: body.movePct,
      windowMs: Number(body.windowMs ?? 0),
      lane: String(body.lane ?? "WS"),
      at: Number(body.at ?? Date.now()),
    });
    return NextResponse.json({ ok: true, freeze: rec });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e).slice(0, 200) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, freezes: cascadeFreezes() });
}
