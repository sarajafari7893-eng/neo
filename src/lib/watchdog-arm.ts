// ── FlowRadar Neo — P0 watchdog SELF-ARM hook (server-only) ─────────────
// The v6.2/R29 lesson that motivated this module: a built-but-dormant
// watchdog is no watchdog — a guardian that silently dies stays dead. The
// heartbeat is the most reliable recurring signal on this box (frontend 8s
// poll + external keep-alive cron), so it carries the arming duty for BOTH
// layers of the two-layer P0 contract (OP-P0-WD-0909 × OP-P0-WD-V3):
//   · Layer 1 (fast heal, 15s) = bun p0-watchdog :3020 — owns auto-restart
//     of app+liq+ws; armed via scripts/watchdog-up.sh (idempotent: lockfile
//     pid-liveness + :3020 port bind inside).
//   · Layer 2 (slow fallback, 60s) = scripts/watchdog.sh v3.1 — app heal
//     when layer-1 is paused/dead (shared pause honored) + P3 supervisor-
//     of-the-supervisor (revives layer-1) + RSS/mem alerts + CLI.
// Defense in depth: layer-2's P3 block ALSO revives layer-1, so the two
// layers guard each other and this hook guards both. Fail-safe by contract:
// never throws into the pulse path, throttled to one pass/minute, spawns
// detached so guardians outlive app restarts.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const L1_LOCK = "/home/z/my-project/.data/p0-watchdog/lock.json";
const L1_UP = "/home/z/my-project/scripts/watchdog-up.sh";
const L2_PIDF = "/home/z/my-project/.data/watchdog/pid";
const L2_SH = "/home/z/my-project/scripts/watchdog.sh";

let lastAttempt = 0;

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // liveness probe only
    return true;
  } catch {
    return false; // ESRCH → dead/stale → re-arm
  }
}

function pidFromJson(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    const m = readFileSync(path, "utf8").match(/"pid":\s*(\d+)/);
    return m ? parseInt(m[1]!, 10) : 0;
  } catch {
    return 0;
  }
}

function pidFromFile(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    return parseInt(readFileSync(path, "utf8").trim(), 10);
  } catch {
    return 0;
  }
}

/** Fire-and-forget arming pass — call from hot paths (pulse). ~1ms when both
 * guardians are healthy (two file reads per minute at most). */
export function ensureP0Watchdog(): void {
  try {
    const now = Date.now();
    if (now - lastAttempt < 60_000) return;
    lastAttempt = now;

    // Layer 1 first: the fast-heal authority
    if (!pidAlive(pidFromJson(L1_LOCK))) {
      const c1 = spawn("bash", [L1_UP], {
        cwd: "/home/z/my-project",
        detached: true,
        stdio: "ignore",
      });
      c1.unref();
      console.log("[watchdog-arm] layer-1 p0-watchdog re-armed via pulse (pid", c1.pid ?? "?", ")");
      return; // one spawn per pass — re-evaluate both layers next minute
    }

    // Layer 2: fallback healer + supervisor-of-the-supervisor
    if (!pidAlive(pidFromFile(L2_PIDF))) {
      mkdirSync("/home/z/my-project/.data/watchdog", { recursive: true });
      const c2 = spawn("bash", [L2_SH, "--loop"], {
        cwd: "/home/z/my-project",
        detached: true,
        stdio: "ignore",
      });
      c2.unref();
      console.log("[watchdog-arm] layer-2 watchdog v3.1 re-armed via pulse (pid", c2.pid ?? "?", ")");
    }
  } catch (err) {
    // fail-open by contract: arming must never break the heartbeat
    console.warn("[watchdog-arm] ensure failed (fail-open):", err);
  }
}
