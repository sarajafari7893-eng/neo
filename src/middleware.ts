// ── NEXUS//SIGNALS — CONTROL-PLANE GATE (v2 · LIVE-HARDENING Phase 2) ────────
// v1 audit P0-1 closed the mutating /api/* surface with: key OR same-origin
// Origin header. v2 SECURITY FIX (Task P2, 2026-09-26): the Origin fallback
// was forgeable by any non-browser client (PoC: POST /api/bridge/send with
// `Origin: <host>` → 200 without key). Replaced with REAL authentication:
//
//   · GET / HEAD / OPTIONS → pass through (probes, dashboard polls).
//   · /api/auth/* → pass through (NextAuth's own CSRF-protected flows).
//   · POST / PUT / PATCH / DELETE → allowed only if
//       (a) header `x-nexus-key` === NEXUS_CONTROL_KEY (server-to-server), OR
//       (b) a valid NextAuth JWT session cookie exists (operator logged in
//           at /login by proving knowledge of the control key).
//     otherwise → 401 JSON, no-store. Key/session values NEVER echoed.
//   · Mutating requests remain rate-limited per-IP (60 per rolling 60s → 429),
//     counted only after successful auth (unauthenticated 401s are cheap).
//
// Edge-safe: constant-time compare; no node APIs; next-auth/jwt (jose) for
// session verification. Fail-closed: missing env or missing session → deny.

import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const WINDOW_MS = 60_000;
const MAX_MUTATIONS_PER_WINDOW = 60;
const UNAUTHORIZED = "unauthorized: mutating API requires x-nexus-key header or operator session";
const RATE_LIMITED = "rate limited: too many mutating requests (60/min per IP)";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
let lastSweepAt = 0;

/** Constant-time string equality (no node:crypto in the edge runtime). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function jsonError(status: number, error: string): NextResponse {
  return new NextResponse(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (!MUTATING.has(req.method.toUpperCase())) return NextResponse.next();

  // NextAuth flows (/api/auth/*) carry their own CSRF protection — never gate.
  if (pathname.startsWith("/api/auth/")) return NextResponse.next();

  // ── auth: control key (server-to-server) OR operator session (browser) ──
  const expected = process.env.NEXUS_CONTROL_KEY ?? "";
  const provided = req.headers.get("x-nexus-key") ?? "";
  const keyOk = expected.length > 0 && provided.length > 0 && constantTimeEqual(provided, expected);

  if (!keyOk) {
    try {
      const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET ?? "" });
      if (!token) return jsonError(401, UNAUTHORIZED);
    } catch {
      return jsonError(401, UNAUTHORIZED); // malformed/undecodable session → fail closed
    }
  }

  // ── rate limit authorized mutations per-IP (rolling 60s window, lite) ───
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip = (xff.split(",")[0] ?? "").trim() || "local";
  const now = Date.now();
  if (now - lastSweepAt > WINDOW_MS) {
    lastSweepAt = now;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    bucket.count += 1;
    if (bucket.count > MAX_MUTATIONS_PER_WINDOW) return jsonError(429, RATE_LIMITED);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
