// ── TELEGRAM BRIDGE proxy — inbox (server-side → bridge :3005) ──────────────
// Operator round 2026-09-11: two-way Telegram bridge. The dashboard polls this
// route to show operator messages + unread count. Server routes may hit the
// bridge on localhost directly (browser never touches :3005).

import { NextResponse } from "next/server";

const BRIDGE = "http://localhost:3005";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const unread = searchParams.get("unread") === "1";
  const n = searchParams.get("n") ?? "20";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${BRIDGE}/inbox?${unread ? "unread=1&" : ""}n=${n}`, {
      headers: { "x-nexus-key": process.env.NEXUS_CONTROL_KEY ?? "" }, // (4-b) /inbox is gated (audit P0-1)
      signal: ctrl.signal, cache: "no-store",
    });
    clearTimeout(t);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, error: "bridge unreachable", unread: 0, total: 0, messages: [] }, { status: 502 });
  }
}
