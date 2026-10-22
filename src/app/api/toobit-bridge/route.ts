import { NextResponse } from "next/server";

// ── v12.3 TASK-52 TOOBIT BRIDGE API (operator mandate trace 1a15630c8d7dbd95) ──
// GET  /api/toobit-bridge        → bridge /status proxy (mode, positions, metrics, doctrine)
// POST /api/toobit-bridge        → operator actions (auth: x-nexus-key):
//     { action: "toggle", enabled: boolean }
//     { action: "approve-live", approve: boolean }   // LIVE requires balance > 0 too
//     { action: "config", marginUsdt?, maxConcurrent?, leverage?, maxEntryDriftBps?, maxEntryAgeMs? }
//     { action: "close", serial }                     // manual close of one intent
// The bridge is the single writer of Toobit state; this route is a thin,
// fail-soft proxy (bridge down → { ok:false, bridge:"down" }, never a hang).

export const dynamic = "force-dynamic";

const BRIDGE = "http://127.0.0.1:3021";
const AUTH_KEY = "3195f6883529fa43a9d62d0fa92b01e7adc851ed0ed3b2b6";

export async function GET() {
  try {
    const r = await fetch(`${BRIDGE}/status`, { signal: AbortSignal.timeout(4000), cache: "no-store" });
    if (!r.ok) return NextResponse.json({ ok: false, bridge: "down" }, { status: 502, headers: { "cache-control": "no-store" } });
    const data = (await r.json()) as Record<string, unknown>;
    return NextResponse.json({ ok: true, ...data }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, bridge: "down" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}

export async function POST(req: Request) {
  if (req.headers.get("x-nexus-key") !== AUTH_KEY) {
    return NextResponse.json({ ok: false, err: "unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
  const action = String(body.action ?? "");
  try {
    let path: string | null = null;
    let payload: Record<string, unknown> = {};
    if (action === "toggle") { path = "/exec-toggle"; payload = { enabled: body.enabled !== false }; }
    else if (action === "approve-live") { path = "/approve-live"; payload = { approve: body.approve === true }; }
    else if (action === "config") {
      path = "/config";
      payload = {};
      if (typeof body.marginUsdt === "number") payload.marginUsdt = body.marginUsdt;
      if (typeof body.maxConcurrent === "number") payload.maxConcurrent = body.maxConcurrent;
      if (typeof body.leverage === "number") payload.leverage = body.leverage;
      if (typeof body.maxEntryDriftBps === "number") payload.maxEntryDriftBps = body.maxEntryDriftBps;
      if (typeof body.maxEntryAgeMs === "number") payload.maxEntryAgeMs = body.maxEntryAgeMs;
    } else if (action === "close") { path = "/close"; payload = { serial: Number(body.serial) }; }
    else return NextResponse.json({ ok: false, err: "unknown action" }, { status: 400 });
    const r = await fetch(`${BRIDGE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nexus-key": AUTH_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json({ ok: r.ok, ...data }, { status: r.ok ? 200 : 502 });
  } catch {
    return NextResponse.json({ ok: false, bridge: "down" }, { status: 502 });
  }
}
