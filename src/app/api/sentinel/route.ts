// ── NEXUS//SIGNALS — /api/sentinel (GET) ─────────────────────────────────────
// Same-origin GET proxy to the NEXUS-SENTINEL deep-monitoring service (:3030).
// Read-only telemetry for the dashboard SENTINEL panel and the nexus-sentinel
// agent skill (skills/nexus-sentinel). Mutating control (run-now/backup-now)
// stays on :3030 behind the x-nexus-key gate — never proxied here.
// When the sentinel is down we return 200 + reachable:false so the dashboard
// card can render a clean degraded state instead of an error surface.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const r = await fetch("http://127.0.0.1:3030/report", {
      signal: AbortSignal.timeout(6000),
      headers: { "user-agent": "nexus-dashboard/1.0" },
      cache: "no-store",
    });
    const j = await r.json();
    return NextResponse.json(j, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json(
      { ok: false, service: "nexus-sentinel", reachable: false, error: "sentinel :3030 unreachable — layer-1 watchdog will revive it" },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}
