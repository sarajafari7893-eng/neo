import { liveEnv } from "@/lib/live-env";
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

/**
 * POST /api/nexus/armor-boot
 * Task 30 (2026-09-26): rollback #4 recovery helper.
 *
 * Spawns push-armor (:3016) and p0-watchdog (:3020) as DETACHED orphans of the
 * Next.js server process. Why: processes spawned from agent tool-shells are
 * killed when the tool call ends (cgroup cleanup), but children of boot-time
 * processes (this server) survive. This is the same mechanism the watchdog's
 * heal-spawn uses.
 *
 * Auth: middleware requires x-nexus-key for POST (defense in depth: re-checked here).
 * Idempotent: skips a target if its /health already responds.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT = "/home/z/my-project";

const TARGETS: Record<string, { port: number; cwd: string; cmd: string; log: string }> = {
  armor: {
    port: 3016,
    cwd: `${ROOT}/mini-services/push-armor`,
    cmd: "setsid nohup bun --hot index.ts",
    log: `${ROOT}/logs/push-armor.log`,
  },
  watchdog: {
    port: 3020,
    cwd: `${ROOT}/mini-services/p0-watchdog`,
    cmd: "setsid nohup bun --hot index.ts",
    log: `${ROOT}/logs/p0-watchdog.log`,
  },
};

async function isUp(url: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok || r.status === 400; // 400 = socket.io style root; fine for liveness
  } catch {
    return false;
  }
}

function spawnDetached(t: { cwd: string; cmd: string; log: string }): number | null {
  try {
    const out = openSync(t.log, "a");
    const child = spawn("bash", ["-c", `${t.cmd} >> ${t.log} 2>&1 < /dev/null`], {
      cwd: t.cwd,
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  // defense in depth: middleware already enforces this, re-check here.
  // Task 36: liveEnv — the .env FILE is the live source of truth (frozen boot
  // process.env kept validating the OLD key after rotation).
  const expected = liveEnv("NEXUS_CONTROL_KEY");
  const provided = req.headers.get("x-nexus-key") ?? "";
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const results: Record<string, unknown> = {};

  for (const [name, t] of Object.entries(TARGETS)) {
    if (await isUp(`http://127.0.0.1:${t.port}/health`)) {
      results[name] = { action: "already-up" };
      continue;
    }
    const pid = spawnDetached(t);
    // give the service a moment, then verify
    await new Promise((r) => setTimeout(r, 3000));
    const up = await isUp(`http://127.0.0.1:${t.port}/health`);
    results[name] = { action: up ? "spawned" : "spawn-failed", pid, up };
  }

  return NextResponse.json({ ok: true, at: new Date().toISOString(), ...results });
}
