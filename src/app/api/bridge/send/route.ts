// ── TELEGRAM BRIDGE proxy — send (server-side → bridge :3005) ───────────────
// POST {text, parse_mode?} → relays to the operator chat via the bridge.
// The dashboard reply box uses this route.

import { NextResponse } from "next/server";

const BRIDGE = "http://localhost:3005";
// (4-b) the relay now requires x-nexus-key on /send (audit P0-1)
const CONTROL_HEADERS = { "content-type": "application/json", "x-nexus-key": process.env.NEXUS_CONTROL_KEY ?? "" };

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { text?: string; parse_mode?: string } | null;
  const text = (body?.text ?? "").trim();
  if (!text) return NextResponse.json({ ok: false, error: "text required" }, { status: 400 });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(`${BRIDGE}/send`, {
      method: "POST",
      headers: CONTROL_HEADERS,
      body: JSON.stringify({ text, parse_mode: body?.parse_mode }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, error: "bridge unreachable" }, { status: 502 });
  }
}
