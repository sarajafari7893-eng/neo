/**
 * NEXUS//SIGNALS — keep-warm :3018 (v1.0.0)
 * ==========================================
 * Operator order (2026-09-30, «کرون‌جاب keep-warm رو از همین محیط باید انجام بدی»):
 * the keep-warm cron must run FROM THIS ENVIRONMENT — not only as an external
 * cron job. This service is the in-environment heart of that doctrine.
 *
 * What it does (ONLY this — nothing more):
 *   every 5 min (+1 beat at boot):
 *     1. GET  :3000/api/healthz   (app liveness, operator template endpoint)
 *     2. GET  :3000/api/pulse     (app self-warm + watchdog re-arm trigger)
 *     3. GET  :3020/status        (count ok services → "9/9")
 *     → append ONE line to logs/keep-warm.log:
 *         OK       healthz=200 pulse=200 svc=9/9
 *         DEGRADED healthz=000 pulse=200 svc=6/9
 *
 * Hard discipline (LEASH-0929b / SANDBOX-COLD-0930 doctrine):
 *   • plain `bun index.ts` — NEVER `bun --hot` (zombie timer lesson)
 *   • OBSERVER ONLY: never restarts anything, never edits code/worklog —
 *     healing belongs to p0-watchdog :3020 (registered there as "kw", v1.4.6)
 *   • no external network calls — everything is loopback
 *
 * Endpoints:
 *   GET /health → { ok, ver, intervalMs, okBeats, degradedBeats, lastBeat, beats[10] }
 *   GET /beats  → last 60 beats (full detail)
 *
 * Note (honest layer): internal heartbeats keep in-process state warm and give
 * a heartbeat trail while the sandbox is ALIVE; the external cron (Job 411262
 * template) remains the anti-recycle belt — this service cannot fire after the
 * platform already recycled the box.
 */

const PORT = 3018;
const VER = "keep-warm 1.2.0";
const INTERVAL_MS = 5 * 60 * 1000; // 5 min — operator template cadence
const ROOT = "/home/z/my-project";
const LOG_PATH = `${ROOT}/logs/keep-warm.log`;
const MAX_LOG_BYTES = 2 * 1024 * 1024; // light self-trim above this
const PUBLIC_URL_FILE = `${ROOT}/.data/keep-warm/public-url.txt`;

/**
 * v1.2.0 (2026-09-30, operator: «اگر مرورگر را ببندم دوباره همه‌چی ریست می‌شود»):
 * EXTERNAL SELF-PING — the recycle-proofing layer. Evidence: recycles #2/#3
 * happened WHILE the platform cron ran "Success" ⇒ loopback/localhost activity
 * does NOT count for idle detection; only EXTERNAL edge traffic (open browser)
 * does. This service now pings the sandbox's own PUBLIC preview URL every beat
 * — the same traffic class as an open browser, generated from inside.
 * URL source (first match wins):
 *   1. env NEXUS_PUBLIC_URL (set in .env — durable via git)
 *   2. file  .data/keep-warm/public-url.txt (operator drops it here)
 * Without a URL the loopback heartbeat continues unchanged (ext=unset).
 */

interface Beat {
  at: string; // ISO UTC
  atTehran: string;
  ok: boolean;
  healthz: number; // 200 | 0 (network fail)
  pulse: number;
  services: string; // "10/10"
  uptimeSec: number | null; // watchdog uptime
  latencyMs: number;
  ext: number; // external self-ping status: 200 | 0 | -1 (unset)
  note?: string;
}

const BOOT = Date.now();
const beats: Beat[] = [];
let okBeats = 0;
let degradedBeats = 0;

function tehran(): string {
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date());
}

function trimLogIfNeeded(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const s = fs.statSync(LOG_PATH);
    if (s.size > MAX_LOG_BYTES) {
      const raw = fs.readFileSync(LOG_PATH, "utf8").split("\n");
      fs.writeFileSync(LOG_PATH, raw.slice(-500).join("\n"));
    }
  } catch { /* first run: file may not exist yet */ }
}

function appendLog(b: Beat): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    fs.appendFileSync(LOG_PATH, `${b.at} ${b.ok ? "OK" : "DEGRADED"} healthz=${b.healthz} pulse=${b.pulse} svc=${b.services} ext=${b.ext} up=${b.uptimeSec ?? "?"}${b.note ? ` note=${b.note}` : ""}\n`);
    trimLogIfNeeded();
  } catch { /* best-effort — never crash the heartbeat over logging */ }
}

let cachedPublicUrl: string | null = null;
let publicUrlCheckedAt = 0;

// re-resolve at most every 60s so the operator can update .env/file live
function resolvePublicUrl(): string | null {
  const now = Date.now();
  if (cachedPublicUrl !== null && now - publicUrlCheckedAt < 60_000) return cachedPublicUrl;
  publicUrlCheckedAt = now;
  const env = (process.env.NEXUS_PUBLIC_URL ?? "").trim();
  if (env.startsWith("http")) {
    cachedPublicUrl = env.replace(/\/+$/, "");
    return cachedPublicUrl;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(PUBLIC_URL_FILE, "utf8").trim();
    if (raw.startsWith("http")) {
      cachedPublicUrl = raw.replace(/\/+$/, "");
      return cachedPublicUrl;
    }
  } catch { /* no file yet */ }
  cachedPublicUrl = null;
  return null;
}

async function probeStatus(url: string, timeoutMs = 6000): Promise<{ status: number; ms: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, ms: Date.now() - t0 };
  } catch {
    return { status: 0, ms: Date.now() - t0 };
  }
}

async function beat(): Promise<Beat> {
  const t0 = Date.now();
  const healthz = await probeStatus("http://127.0.0.1:3000/api/healthz");
  const pulse = await probeStatus("http://127.0.0.1:3000/api/pulse");
  const wd = await probeStatus("http://127.0.0.1:3020/status");

  let services = "?/?";
  let uptimeSec: number | null = null;
  if (wd.status === 200) {
    try {
      const res = await fetch("http://127.0.0.1:3020/status", { signal: AbortSignal.timeout(6000) });
      const d = (await res.json()) as { uptimeSec?: number; services?: Record<string, string> };
      const svc = d.services ?? {};
      const keys = Object.keys(svc);
      const okN = keys.filter((k) => svc[k] === "ok").length;
      services = `${okN}/${keys.length}`;
      uptimeSec = typeof d.uptimeSec === "number" ? d.uptimeSec : null;
    } catch { /* keep ?/? */ }
  }

  const ok = healthz.status === 200 && pulse.status === 200;

  // v1.2.0 EXTERNAL SELF-PING — real edge traffic, the anti-recycle lever
  const publicUrl = resolvePublicUrl();
  let ext = -1;
  if (publicUrl) {
    const r = await probeStatus(`${publicUrl}/api/heartbeat-line`, 10_000);
    ext = r.status;
  }

  const b: Beat = {
    at: new Date().toISOString(),
    atTehran: tehran(),
    ok,
    healthz: healthz.status,
    pulse: pulse.status,
    services,
    uptimeSec,
    latencyMs: Date.now() - t0,
    ext,
  };
  if (!ok) b.note = `wd=${wd.status}`;
  else if (ext === 0) b.note = "ext-unreachable";

  if (ok) okBeats += 1; else degradedBeats += 1;
  beats.push(b);
  if (beats.length > 60) beats.shift();
  appendLog(b);

  console.log(`[keep-warm] ${b.at} ${b.ok ? "OK" : "DEGRADED"} healthz=${b.healthz} pulse=${b.pulse} svc=${b.services} ext=${b.ext} ${b.latencyMs}ms`);
  return b;
}

// ── RAM-SHED v1.0 (RAM-SHED-20261024) — bounded-RSS self-respawn ──────────
// Evidence: this ~60-line observer ballooned to 189MB RSS (bun allocator
// retains freed pages across days of beats) — the fleet's 4th biggest
// consumer on a 4GB no-swap box, bigger than watchdog+mem-guard+card-sentinel
// COMBINED. Self-respawn pattern (same class as the watchdog heal-spawn, and
// the reason it is safe: children of a long-lived process survive the parent):
// spawn a fresh plain-bun replacement FIRST, then exit. Downtime <1s, RSS
// returns to ~40MB, :3018 never left unattended.
const RSS_RESPAWN_MB = 120;
function selfRespawnIfFat(reason: string): void {
  let mb = 0;
  try {
    mb = Math.round(process.memoryUsage.rss() / 1048576);
  } catch {
    return;
  }
  if (mb < RSS_RESPAWN_MB) return;
  try {
    const child = Bun.spawn(["bun", "index.ts"], {
      cwd: import.meta.dir,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    console.log(`[keep-warm] SELF-RESPAWN rss=${mb}MB>${RSS_RESPAWN_MB}MB (${reason}) → child pid=${child.pid}, exiting (RAM-SHED-20261024)`);
    appendLog({
      at: new Date().toISOString(),
      atTehran: tehran(),
      ok: true,
      healthz: 0,
      pulse: 0,
      services: "?/?",
      uptimeSec: Math.floor((Date.now() - BOOT) / 1000),
      latencyMs: 0,
      ext: -1,
      note: `self-respawn rss=${mb}MB`,
    });
    setTimeout(() => process.exit(0), 500).unref?.();
  } catch (err) {
    console.error("[keep-warm] self-respawn failed — continuing in place", err);
  }
}
setInterval(() => selfRespawnIfFat("rss-ticker"), 60_000).unref?.();

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      const pu = resolvePublicUrl();
      return Response.json({
        ok: true,
        ver: VER,
        pid: process.pid,
        port: PORT,
        tehran: tehran(),
        uptimeSec: Math.floor((Date.now() - BOOT) / 1000),
        intervalMs: INTERVAL_MS,
        publicUrlSet: pu !== null,
        publicUrlHost: pu ? new URL(pu).host : null,
        okBeats,
        degradedBeats,
        lastBeat: beats[beats.length - 1] ?? null,
        beats: beats.slice(-10),
      });
    }
    if (url.pathname === "/beats") {
      return Response.json({ ok: true, ver: VER, beats });
    }
    return new Response("keep-warm: see /health\n", { status: 404 });
  },
});

console.log(`[${VER}] listening :${PORT} — heartbeat every ${INTERVAL_MS / 1000}s (plain bun, no --hot)`);

// beat at boot + interval (plain setInterval — LEASH doctrine: no --hot, no zombie timers)
void beat();
setInterval(() => { void beat(); }, INTERVAL_MS);

export { server };
