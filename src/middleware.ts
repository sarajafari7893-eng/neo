// ── NEXUS//SIGNALS — CONTROL-PLANE GATE (task 4-b · audit P0-1) ─────────────
// Audit 3-b/3-d finding: "control plane unauthenticated (57 routes)".
// This middleware closes the mutating surface of /api/*:
//   · GET / HEAD / OPTIONS → pass through immediately (probes, dashboard polls).
//   · POST / PUT / PATCH / DELETE → allowed only if
//       (a) header `x-nexus-key` === NEXUS_CONTROL_KEY (env must be non-empty),
//           OR
//       (b) an `Origin` header is present AND its parsed host equals the
//           request `Host` header (browser same-origin CSRF guard — the
//           dashboard's same-origin fetches qualify automatically).
//     otherwise → 401 JSON, no-store. The key value is NEVER echoed/logged.
//   · Mutating requests are rate-limited per-IP (x-forwarded-for first hop,
//     fallback "local"): token-bucket-lite, max 60 per rolling 60s → 429.
//
// Runtime notes: edge-safe plain TS — no node APIs beyond URL/Headers parsing;
// constant-time key compare (length leak accepted, standard practice); the
// rate-limit Map is tiny and self-sweeping so it cannot grow unbounded.
// Internal callers (watchdog probes, price-ws, sre-daily, backup canaries) are
// all GET and are unaffected by design.

import { NextRequest, NextResponse } from "next/server";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const WINDOW_MS = 60_000;
const MAX_MUTATIONS_PER_WINDOW = 60;
const UNAUTHORIZED = "unauthorized: mutating API requires x-nexus-key header";
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

export function middleware(req: NextRequest): NextResponse {
  if (!MUTATING.has(req.method.toUpperCase())) return NextResponse.next();

  // ── auth: (a) control key, or (b) same-origin browser guard ──────────────
  const expected = process.env.NEXUS_CONTROL_KEY ?? "";
  const provided = req.headers.get("x-nexus-key") ?? "";
  const keyOk = expected.length > 0 && provided.length > 0 && constantTimeEqual(provided, expected);
  if (!keyOk) {
    let sameOrigin = false;
    const origin = req.headers.get("origin");
    if (origin) {
      try {
        sameOrigin = new URL(origin).host === (req.headers.get("host") ?? "");
      } catch {
        sameOrigin = false; // malformed Origin → never trust it
      }
    }
    if (!sameOrigin) return jsonError(401, UNAUTHORIZED);
  }

  // ── rate limit mutating requests per-IP (rolling 60s window, lite) ───────
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
