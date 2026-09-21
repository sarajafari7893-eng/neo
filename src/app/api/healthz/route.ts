import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";

export const dynamic = "force-dynamic";

function memAvailableMB(): number | null {
  try {
    const m = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
    return m ? Math.round(parseInt(m[1]!, 10) / 1024) : null;
  } catch {
    return null;
  }
}

interface P0WatchdogStatus {
  running: boolean;
  pid: number | null;
  appMode: string | null;
  appFails: number | null;
  pausedUntil: number | null;
  authority: string;
}

/**
 * CONVERGENCE 2026-09-09 (OP-P0-WD-0909 × OP-P0-WD-V3): the bun p0-watchdog
 * service (:3020) is the single P0 healing authority. This endpoint mirrors
 * its liveness (lock.json pid) + app-healing state (state.json) so operators
 * and external monitors get one-glance truth. Fail-open on missing files.
 */
function p0WatchdogStatus(): P0WatchdogStatus {
  const out: P0WatchdogStatus = {
    running: false,
    pid: null,
    appMode: null,
    appFails: null,
    pausedUntil: null,
    authority: "bun p0-watchdog :3020 (OP-P0-WD-0909)",
  };
  try {
    const lockf = "/home/z/my-project/.data/p0-watchdog/lock.json";
    if (existsSync(lockf)) {
      const m = readFileSync(lockf, "utf8").match(/"pid":\s*(\d+)/);
      const pid = m ? parseInt(m[1]!, 10) : NaN;
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // liveness probe only
          out.running = true;
          out.pid = pid;
        } catch {
          out.running = false;
        }
      }
    }
    const st = JSON.parse(readFileSync("/home/z/my-project/.data/p0-watchdog/state.json", "utf8")) as {
      pausedUntil?: unknown;
      services?: { app?: { mode?: unknown; fails?: unknown } };
    };
    out.pausedUntil = typeof st.pausedUntil === "number" ? st.pausedUntil : null;
    out.appMode = typeof st.services?.app?.mode === "string" ? st.services.app.mode : null;
    out.appFails = typeof st.services?.app?.fails === "number" ? st.services.app.fails : null;
  } catch {
    // fail-open: a status endpoint must never 500 over missing state files
  }
  return out;
}

function layer2Status(): { running: boolean; pid: number | null } {
  const out = { running: false, pid: null as number | null };
  try {
    const pidf = "/home/z/my-project/.data/watchdog/pid";
    if (existsSync(pidf)) {
      const pid = parseInt(readFileSync(pidf, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          out.running = true;
          out.pid = pid;
        } catch {
          out.running = false;
        }
      }
    }
  } catch {
    // fail-open
  }
  return out;
}

/**
 * GET /api/healthz — P0 ops endpoint (watchdog companion, R29 plan).
 * Read-only, zero side effects; does NOT drive the engine tick (unlike
 * /api/pulse) so aggressive external monitors cannot perturb the engine.
 * Exposes process heap/RSS, true MemAvailable, and BOTH watchdog layers
 * (layer-1 bun :3020 state mirror + layer-2 bash v3.1 liveness).
 */
export async function GET() {
  const mem = process.memoryUsage();
  return NextResponse.json(
    {
      ok: true,
      ts: Date.now(),
      uptimeSec: Math.round(process.uptime()),
      rssMB: Math.round(mem.rss / 1048576),
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      memAvailableMB: memAvailableMB(),
      watchdogLayer1: p0WatchdogStatus(),
      watchdogLayer2: layer2Status(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
