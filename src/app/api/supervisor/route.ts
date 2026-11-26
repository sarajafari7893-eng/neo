import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/supervisor — SANDBOX HEARTBEAT compat endpoint (operator order
 * 2026-09-30). The operator's keep-warm cron template probes
 * `localhost:81/api/supervisor` and requires HTTP 200 + version/uptime fields.
 * The single source of truth is p0-watchdog :3020/status — this route mirrors
 * it verbatim. Honest liveness: if the watchdog is unreachable this returns
 * 503 so the cron template's COLD branch (`HEARTBEAT COLD`) fires naturally.
 */
const WD_URL = "http://127.0.0.1:3020/status";

export async function GET() {
  try {
    const r = await fetch(WD_URL, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, cold: true, reason: `watchdog status ${r.status}` },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const d = (await r.json()) as Record<string, unknown>;
    return NextResponse.json(d, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { ok: false, cold: true, reason: "p0-watchdog unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
