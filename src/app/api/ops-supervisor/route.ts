// ── /api/ops-supervisor — senior-engineer oversight cron (v1.0) ─────────────
// GET  → state + journal (dashboard card / probes). Read-only, no key needed.
// POST → { action: "run-now" } forces a FULL supervisor cycle immediately
//        (x-nexus-key or same-origin per the control-plane middleware).
import { NextResponse } from "next/server";
import { getOpsSupervisorStatus, maybeRunOpsSupervisor } from "@/lib/ops-supervisor";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getOpsSupervisorStatus();
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[ops-supervisor GET]", err);
    return NextResponse.json({ error: "ops-supervisor status failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== "run-now") {
      return NextResponse.json({ ok: false, error: "unknown action — use {action:'run-now'}" }, { status: 400 });
    }
    const res = await maybeRunOpsSupervisor(true);
    return NextResponse.json({ ok: res.ran, ...res }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[ops-supervisor POST]", err);
    return NextResponse.json({ ok: false, error: "ops-supervisor cycle failed" }, { status: 500 });
  }
}
