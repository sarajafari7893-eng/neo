// ── TELEGRAM BRIDGE proxy — mark-all-read (server-side → bridge :3005) ──────

import { NextResponse } from "next/server";

const BRIDGE = "http://localhost:3005";

export async function POST() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${BRIDGE}/read`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nexus-key": process.env.NEXUS_CONTROL_KEY ?? "" }, // (4-b) /read is gated (audit P0-1)
      body: JSON.stringify({ all: true }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, error: "bridge unreachable" }, { status: 502 });
  }
}
