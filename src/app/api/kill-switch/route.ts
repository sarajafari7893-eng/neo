// ── NEXUS//SIGNALS — KILL-SWITCH CONTROL API (LIVE-HARDENING v11.0) ─────────
// GET  → current state (public read — safe: it is a status flag only).
// POST → { action: "engage" | "release", reason } — KEY-ONLY authorization.
//   WHY: the middleware's same-origin paths are CSRF defenses for browser UX,
//   not authentication — a non-browser client can forge sec-fetch-site/Origin
//   (audit finding F1, live-verified). The system's most critical control
//   therefore requires the actual secret (x-nexus-key), which no page and no
//   forged header can supply. A browser panel can be added later behind a
//   real session-auth layer; until then key-only is the honest fail-closed
//   posture. Every transition is written to the flag file + append-only trail.
import { NextRequest, NextResponse } from "next/server";
import { engageKillSwitch, releaseKillSwitch, killSwitchStatus } from "@/lib/kill-switch";
import { readFileSync } from "node:fs";

function controlKeyOk(req: NextRequest): boolean {
  let expected = "";
  try {
    expected = (readFileSync("/home/z/my-project/.env", "utf8").match(/^NEXUS_CONTROL_KEY=(.+)$/m)?.[1] ?? "").trim();
  } catch { expected = ""; }
  const got = (req.headers.get("x-nexus-key") ?? "").trim();
  return expected.length > 0 && got === expected;
}

export async function GET() {
  const s = killSwitchStatus();
  return NextResponse.json(
    { ...s, note: s.engaged ? "ALL deploys refused (423) while engaged" : "deploy path armed under normal gates" },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  if (!controlKeyOk(req)) {
    // v11.0 audit F1: a forged same-origin header is NOT authorization —
    // the kill-switch requires the control key (fail-closed on missing key).
    return NextResponse.json({ ok: false, error: "unauthorized: kill-switch control requires x-nexus-key header" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  let body: { action?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const action = body.action;
  const reason = String(body.reason ?? "").slice(0, 300);
  if (action === "engage") {
    if (!reason) return NextResponse.json({ ok: false, error: "engage requires a reason" }, { status: 400 });
    return NextResponse.json({ ok: true, state: engageKillSwitch(reason, "operator:key") });
  }
  if (action === "release") {
    return NextResponse.json({ ok: true, state: releaseKillSwitch(reason || "operator release", "operator:key") });
  }
  return NextResponse.json({ ok: false, error: "action must be 'engage' or 'release'" }, { status: 400 });
}
