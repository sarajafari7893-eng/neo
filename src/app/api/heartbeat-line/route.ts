import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/heartbeat-line — KEEP-WARM-EXTERNAL relay (operator order 2026-09-30:
 * «کرون جاب در این محیط چت پیام ارسال کند»).
 *
 * The platform cron job (zai-web) runs but its heartbeat never appeared in the
 * chat — because the job only curled endpoints silently (or is bound to another
 * account's chat). This endpoint closes the gap from the SYSTEM side: it returns
 * ONE ready-to-paste plain-text line. The cron agent's whole job becomes:
 *   1. fetch this URL (short timeout)
 *   2. reply in the chat with EXACTLY the returned line
 *
 * Contract:
 *   • always 200 (a heartbeat must never error — the LINE carries the state)
 *   • always text/plain, single line, no-store, fast (<3s hard cap)
 *   • states: OK / DEGRADED (services down) / COLD (watchdog unreachable)
 *   • fail-open: internal fetch errors degrade the line, never throw
 */

const WD_URL = "http://127.0.0.1:3020/status";

interface WdStatus {
  ver?: string;
  uptimeSec?: number;
  services?: Record<string, string>;
}

async function readWatchdog(): Promise<WdStatus | null> {
  try {
    const res = await fetch(WD_URL, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as WdStatus;
  } catch {
    return null;
  }
}

export async function GET() {
  const wd = await readWatchdog();
  const appUpSec = Math.round(process.uptime());

  let line: string;
  if (!wd) {
    // watchdog unreachable — the app itself answering IS the liveness proof
    line = `HEARTBEAT COLD · p0-watchdog unreachable · app alive uptime ${Math.floor(appUpSec / 60)}m`;
  } else {
    const svc = wd.services ?? {};
    const keys = Object.keys(svc);
    const okKeys = keys.filter((k) => svc[k] === "ok");
    const down = keys.filter((k) => svc[k] !== "ok");
    const wdUpMin = typeof wd.uptimeSec === "number" ? Math.floor(wd.uptimeSec / 60) : null;
    if (keys.length > 0 && down.length === 0) {
      line = `HEARTBEAT OK · NEXUS ${okKeys.length}/${keys.length} services · ${wd.ver ?? "watchdog"} · watchdog uptime ${wdUpMin ?? "?"}m`;
    } else {
      line = `HEARTBEAT DEGRADED · NEXUS ${okKeys.length}/${keys.length} services · down: ${down.slice(0, 4).join(", ") || "?"}`;
    }
  }

  return new NextResponse(line + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
