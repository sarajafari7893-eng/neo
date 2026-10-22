/* ── NEXUS//SIGNALS v10.16 CONTROL-PLANE GATE (audit fix P0-1, 2026-09-20) ──
 * Next.js 16 proxy (replaces middleware; Node runtime).
 *
 * Threat model (audit 3-b/3-d P0-1 + P0-2): the sandbox gateway (Caddy :81) is
 * the ONLY externally reachable port and always adds `X-Forwarded-For`.
 * Requests WITHOUT that header are process-local tooling (watchdogs, dev-up,
 * backup cron, curl on the box) and stay trusted. Everything WITH the header
 * is external and must present a control credential on:
 *   - every non-GET /api/* call (mutations: advisor approve, rawcal arm,
 *     settings, terminal, backup, ai/chat, …)
 *   - the privacy-sensitive GETs (/api/healthz internals, /api/bridge/inbox)
 *
 * Accepted credentials:
 *   1. `x-nexus-key: $NEXUS_CONTROL_KEY` header  (machine callers)
 *   2. `nexus-ctl` HttpOnly cookie — HMAC-signed expiry minted by
 *      GET /api/session and auto-attached by the same-origin dashboard.
 *
 * Caddy additionally pins XTransformPort to :3003 only (see Caddyfile), which
 * removes the watchdog/bridge/liq services from the external plane entirely.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

const CTL_COOKIE = "nexus-ctl";
// GET routes that leak operator-private or host-internals when fetched from
// outside — gated exactly like mutations.
const GATED_GETS = new Set<string>(["/api/healthz", "/api/bridge/inbox"]);

function secret(): string {
  return process.env.NEXUS_CONTROL_KEY || "";
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

// loopback discriminators for XFF hops (v10.16 fix2 — see proxy() comment)
function isLoopback(h: string): boolean {
  const v = h.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    v === "127.0.0.1" ||
    v === "::1" ||
    v === "::ffff:127.0.0.1" ||
    v === "localhost" ||
    v.startsWith("127.")
  );
}

function cookieOk(token: string | undefined): boolean {
  if (!token || !secret()) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  let expect: string;
  try {
    expect = createHmac("sha256", secret()).update(exp).digest("hex");
  } catch {
    return false;
  }
  return safeEqual(sig, expect);
}

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  if (!isApi) return NextResponse.next();

  // "External" = came through the Caddy edge (:81 is the only exposed port and
  // it stamps X-Forwarded-For with the real remote host). CAVEAT (v10.16 fix2):
  // Next's server ALSO injects x-forwarded-for for direct local peers
  // (loopback), so a bare `has(xff)` misclassifies on-box tooling as external —
  // treat XFF whose entries are ALL loopback as local.
  const xff = req.headers.get("x-forwarded-for") || "";
  const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
  const isExternal =
    hops.length > 0 && !hops.every((h) => isLoopback(h));
  if (!isExternal) return NextResponse.next(); // on-box tooling stays open

  const isMutation = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  if (!isMutation && !GATED_GETS.has(pathname)) return NextResponse.next();

  const key = req.headers.get("x-nexus-key") || "";
  if (secret() && safeEqual(key, secret())) return NextResponse.next();
  if (cookieOk(req.cookies.get(CTL_COOKIE)?.value)) return NextResponse.next();

  // No .env key configured → fail CLOSED (audit: gate must never be silently off).
  return NextResponse.json(
    {
      ok: false,
      error: "CONTROL_GATE",
      hint: "mutating/sensitive API requires x-nexus-key header or a /api/session cookie (same-origin)",
    },
    { status: 401 },
  );
}

export const config = {
  matcher: "/api/:path*",
};
