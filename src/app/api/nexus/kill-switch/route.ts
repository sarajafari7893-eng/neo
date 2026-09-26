import { NextResponse } from "next/server";
import { readKillSwitch, engageKillSwitch, releaseKillSwitch } from "@/lib/execution/kill-switch";

export const dynamic = "force-dynamic";

/**
 * Task 34-6 (LIVE-HARDENING D1) — operator kill-switch control.
 *
 * The kill-switch referenced by the canonical entryGate (engine deploy path)
 * must be OPERABLE from the control plane:
 *   GET  → current state (engaged, by, at, reason)
 *   POST { action: "engage", reason } → block ALL new entries (fail-closed)
 *   POST { action: "release", reason? } → clear the switch (audited)
 *
 * Auth: middleware already requires the control key or operator session for
 * POST/PUT/PATCH/DELETE; the POST body is re-checked here (defense in depth,
 * armor-boot pattern). GET is read-only. State is a small JSON file under
 * .data/execution/ — survives restarts, fail-closed on corruption (readKillSwitch).
 */
export async function GET() {
  return NextResponse.json(readKillSwitch(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  // defense-in-depth re-check (mirrors /api/nexus/armor-boot)
  const expected = process.env.NEXUS_CONTROL_KEY ?? "";
  const provided = req.headers.get("x-nexus-key") ?? "";
  const keyOk = expected.length > 0 && provided.length > 0 && constantTimeEqual(provided, expected);
  if (!keyOk) {
    try {
      const { getToken } = await import("next-auth/jwt");
      const token = await getToken({ req: req as never, secret: process.env.NEXTAUTH_SECRET ?? "" });
      if (!token) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    } catch {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string; by?: string };
  const by = (body.by ?? "operator").toString().slice(0, 80);

  if (body.action === "engage") {
    const reason = (body.reason ?? "").toString().trim().slice(0, 200);
    if (!reason) return NextResponse.json({ ok: false, error: "reason is required to engage the kill-switch" }, { status: 400 });
    const state = engageKillSwitch(by, reason);
    return NextResponse.json({ ok: true, state }, { headers: { "Cache-Control": "no-store" } });
  }
  if (body.action === "release") {
    const state = releaseKillSwitch(by);
    return NextResponse.json({ ok: true, state }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ ok: false, error: "action must be 'engage' (reason required) or 'release'" }, { status: 400 });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
