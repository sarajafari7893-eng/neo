import { NextResponse } from "next/server";

// ── v1.5.0 EXEC-BRIDGE JOURNAL PROXY (operator mandate trace 1a1899d2237473d9) ──
// GET /api/toobit-bridge/journal → bridge :3021 /journal proxy — the full-event
// journal contract: fixed-$3 account summary, equity curve, since-boot event
// counters, raw audit tail (120 rows), closed-intent PnL board, latency
// percentiles. Thin fail-soft proxy (bridge down → { ok:false }, never a hang).

export const dynamic = "force-dynamic";

const BRIDGE = "http://127.0.0.1:3021";

export async function GET() {
  try {
    const r = await fetch(`${BRIDGE}/journal`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!r.ok) return NextResponse.json({ ok: false, bridge: "down" }, { status: 502, headers: { "cache-control": "no-store" } });
    const data = (await r.json()) as Record<string, unknown>;
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, bridge: "down" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
