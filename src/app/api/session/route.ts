/* ── NEXUS//SIGNALS v10.16 CONTROL SESSION MINT (audit fix P0-1) ──
 * The dashboard is same-origin, so it authenticates through an HttpOnly
 * SameSite=Strict cookie instead of shipping the control key to the browser.
 * GET (idempotent, no data): mints a 12h signed expiry token.
 * Machine callers (scripts, cron) use the x-nexus-key header instead.
 * Gate logic: src/proxy.ts. If NEXUS_CONTROL_KEY is unset this route still
 * works, but the proxy fails closed — set the key in .env (ops: runbook §0).
 */
import { NextResponse } from "next/server";
import { createHmac } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CTL_COOKIE = "nexus-ctl";
const TTL_MS = 12 * 60 * 60 * 1000;

export async function GET() {
  const key = process.env.NEXUS_CONTROL_KEY || "";
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "NEXUS_CONTROL_KEY unset — control gate fails closed" },
      { status: 503 },
    );
  }
  const exp = String(Date.now() + TTL_MS);
  const sig = createHmac("sha256", key).update(exp).digest("hex");
  const res = NextResponse.json({ ok: true, expiresInMs: TTL_MS });
  res.cookies.set(CTL_COOKIE, `${exp}.${sig}`, {
    httpOnly: true,
    sameSite: "strict",
    secure: false, // sandbox gateway terminates TLS upstream; :81 is plain http
    path: "/",
    maxAge: Math.floor(TTL_MS / 1000),
  });
  return res;
}
