/**
 * NEXUS//SIGNALS — MEM-GUARD v2.0 (port 3017)
 * Operator mandate 2026-10-15 «راه‌حل مهندسی — MEM-GUARD v2 کامل و مهندسی اجرا کن»
 *
 * WHY THIS EXISTS (root-cause chain, evidence-logged 2026-10-15):
 *  1. next-server dev RSS boot-spike reaches 2.4-2.9GB on this 4GB/no-swap box even
 *     WITH the EQ-98 caps (V8 768MB + turbopackMemoryLimit 384MiB — caps constrain
 *     steady-state, not the transient compile+hydrate arena). dmesg 2026-10-15:
 *     "Out of memory: Killed process 9698 (next-server) anon-rss:2874944kB".
 *  2. Kernel OOM / platform recycle → the platform restores a STALE filesystem
 *     checkpoint (observed: git layer back to 09-27 era = engine v10.18, DB back to
 *     09-27 15:50 era — strat-pause + ~1700-row ledger gone; only PolarFS /tmp and
 *     the live WAL survived). Nothing verified freshness at boot → the box RAN STALE
 *     for hours (armor even amended the stale git chain + shipped 2 stale zips).
 *  3. p0-watchdog tick loop froze after boot (ticks frozen at 1, HTTP serving stale
 *     state) → no self-heal all morning; the app OOMed twice with nobody watching.
 *
 * MEM-GUARD v2 = independent guards in one process:
 *  ── LAYER 1 · MEMORY GUARD ──
 *     15s RSS sampling of next-server + MemAvailable ring (240 samples = 1h).
 *     Boot-spike exempt (120s grace per new app pid), then PREEMPTIVE graceful
 *     restart BEFORE the kernel kill line (~2.8GB observed): snapshot via push-armor
 *     → pause p0-watchdog (API + pause-until file) → kill app tree → prune
 *     .next/dev/cache when avail is low (647MB hydrate was the spike driver) →
 *     detached `bun run dev` spawn (package.json envelope: V8 768MB + tee -a) →
 *     health gate /api/pulse ≤120s → release watchdog → Telegram notify.
 *     Circuit breaker: ≤3 preemptive restarts/3600s → quarantine (alert-only).
*     v2.3 (Task-43): the breaker counts PREEMPTIVE RSS recycles ONLY — reactive
*     rescue spawns (app died externally: kernel OOM, platform recycle) are
*     tracked separately, because the 2026-10-18 OOM storm filled the breaker
*     with rescues and left the guard blind exactly when the preemptive recycle
*     was needed most. Quarantine now AUTO-RELEASES when the window ages out.
 *  ── LAYER 2 · FRESHNESS GUARD ──
 *     Anti-stale ledger persisted OUTSIDE the git layer on PolarFS
 *     (/tmp/my-project/mem-guard/freshness.json — survives platform recycles) and
 *  ── LAYER 4 · ROLLBACK SENTINEL (v2.2 — 2026-10-16 incident class) ──
 *     INCIDENT: platform recycle 09:27 restored a ~19-day-stale tree (engine
 *     v10.18, DB 767 rows, git history rolled to 09-26/27) WHILE the box kept
 *     running. The v2.1 date-based freshness check was BLIND because armor
 *     kept committing fresh-timestamped snapshots on top of the stale base —
 *     HEAD dates looked current while the CONTENT was 19 days old. mem-guard
 *     itself was also down (recycle killed it; nothing re-spawned it).
 *     v2.2 fixes:
 *      ① engine-version sentinel — the freshness ledger now records
 *        ENGINE_VERSION read from src/lib/engine.ts; any divergence from the
 *        ledger version = tree mutation (rollback/corruption) REGARDLESS of
 *        commit dates → same remote-recovery choreography.
 *      ② DB-stale branch (Signal count < 80% of ledger) now AUTO-HEALS via the
 *        same fetch+reset path (operator mandate 2026-10-16 «مهندسی ریکاوری
 *        و ایمن‌سازی شود») — was alert-only in v2.1. SQLite safely discards a
 *        mismatched stale WAL, so the tree-restored db+wal pair is coherent.
 *      ③ boot-spawn contract: watchdog (owned heal) + dev-up.sh both call
 *        scripts/mem-guard-up.sh — a recycle can never leave this guard dead
 *        again (the process runs plain bun, no --hot, so its code also
 *        survives a disk rollback in memory and can heal FROM memory).
 *     mirrored into .data/mem-guard/ (travels with armor pushes → offsite).
 *     Every 5min + at boot: compare HEAD vs ledger; if HEAD is OLDER than the
 *     ledger's last-known head → stale filesystem detected → verify remote tip
 *     (ls-remote with armor auth) → fetch --depth=6 + reset --hard to remote tip
 *     → Telegram notify. DB freshness: Signal count shadow — if live count < 80%
 *     of ledger value → DB-STALE alert with the newest PolarFS zip runbook
 *     (auto-swap intentionally NOT automatic in v2.0 — swap requires app downtime
 *     and is operator-visible; the alert carries the exact zip path).
 *  ── WATCHDOG SUPERVISION (the hole that burned 2026-10-15 morning) ──
 *     If p0-watchdog /status mem.at freezes >90s while HTTP still answers (tick
 *     loop frozen), mem-guard restarts the watchdog itself.
 *  ── LOG HYGIENE ──
 *     dev.log > 40MB → gzip → logs/archive/ (keep 7) → truncate (tee -a keeps it
 *     append-only; without rotation it grows unbounded).
 *  ── LAYER 3 · SCHEMA-CLIENT GUARD (v2.1 — 2026-10-15 incident class) ──
 *     Task 37 forensics: platform recycle restored a stale node_modules whose
 *     generated Prisma client predated the v11.2 beBanked* columns → EVERY
 *     signal.update with those fields threw PrismaClientValidationError → the
 *     whole lifecycle froze (no arm/TP/SL/expiry persisted) + BE_TRAIL spammed
 *     every tick, silently. Guard: every 5min + at boot + after every freshness
 *     recovery, diff the Signal model fields in prisma/schema.prisma against
 *     node_modules/.prisma/client/schema.prisma (the client's own copy).
 *     Mismatch → auto `bunx prisma generate` → re-verify → app restart via the
 *     full choreography (the running process keeps the stale client in memory —
 *     a restart is the ONLY way it picks the regenerated client up). 30min
 *     anti-thrash on the heal; restart goes through the existing breaker.
 *
 * HONESTY: mem-guard never fabricates state; every action is logged to
 * .data/mem-guard/actions.jsonl and notified. FLAT-10/engine untouched.
 */

import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, unlinkSync, statSync, readdirSync, appendFileSync } from "node:fs";
import * as path from "node:path";

const VER = "mem-guard 2.5.0"; // v2.5.0 trace-1a15ddbdbabf84a9 RAM audit: avail-gated cache prune (preemptive-always wipe manufactured its own pressure → 3.3min restart treadmill); v2.4.0: honor shared pause-until contract
const ROOT = "/home/z/my-project";
const PORT = 3019; // 3017=stable-feed (watchdog SVCS), 3018=keep-warm — 3019 is the free slot
const DIR = `${ROOT}/.data/mem-guard`;
const POLAR = "/tmp/my-project/mem-guard";
const STATE = `${DIR}/state.json`;
const ACTIONS = `${DIR}/actions.jsonl`;
const HEARTBEAT = `${DIR}/heartbeat`;
const LOCK = `${DIR}/lock.json`;
const POLAR_FRESH = `${POLAR}/freshness.json`;
const MIRROR_FRESH = `${DIR}/freshness.json`;
const WD_PAUSE_FILE = `${ROOT}/.data/p0-watchdog/pause-until`;
const REPO = "https://github.com/sarajafari7893-eng/neo.git";

const TICK_MS = 15_000;
const FRESH_EVERY_TICKS = 20; // 5min
const SAMPLE_CAP = 240; // 1h ring

// memory thresholds (MB) — RECALIBRATED 2026-10-18 live data (ChunkLoadError death-loop fix):
//   OLD 10-15 calibration caused a permanent restart loop: today's warm plateau is
//   2.29-2.35GB (v12.0 graph grew) + ambient services ~1.5GB on a 4GB no-swap sandbox
//   → avail sat at 500-570MB permanently < old AVAIL_FLOOR 600 → governor fired every
//   cycle → cold-boot spike ~2.8-2.9GB → kernel OOM → rescue → loop (17 rescues/hour).
//   kernel kill line ~2.8GB anon-rss (dmesg pid 9698: 2874944kB)
//   warm plateau (v12.0, fresh cache): 2.29-2.35GB; boot spike (chrome closed): < 2.8GB
const RSS_ACT = 2600;      // sustained → restart (full-route-compiled plateau measured 2.5GB on 10-18; kernel anon kill ≈ RSS 2.9-3.0)
const RSS_SUSTAIN_TICKS = 4;
const RSS_HARD = 2700;     // single tick (post grace) → restart now
const AVAIL_FLOOR = 300;   // with the 2.5GB app, ambient avail legitimately sits 350-500MB — bias to STAY UP; kernel OOM is the real backstop, guard rescues after
const BOOT_GRACE_MS = 180_000;
const RESTARTS_PER_HOUR = 3;
const CACHE_PRUNE_AVAIL = 900; // prune gate for the rescue path (preemptive restarts ALWAYS prune)

const KEY = (() => {
  try {
    const m = readFileSync(`${ROOT}/.env`, "utf8").match(/^NEXUS_CONTROL_KEY=(.*)$/m);
    return (m?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  } catch { return ""; }
})();

let mem: { availableMb: number; level: string; at: number } = { availableMb: -1, level: "ok", at: 0 };
let app = { pid: 0, rssMb: -1, firstSeenAt: 0, parentPids: [] as number[] };
let samples: { t: number; rss: number; avail: number }[] = [];
let highRssTicks = 0;
let lowAvailTicks = 0;
let restarting = false; // single-flight
let quarantined = false;
let quarantinedAt = 0;
let ticks = 0;
let lastFreshCheckAt = 0;
let wdFrozenSince = 0;
let schema = { lastCheckAt: 0, lastResult: "not-checked", lastHealAt: 0, missing: [] as string[] };
let pendingSchemaRestart = false; // healed at boot (app absent) → restart on first sighting
let lastRotationDay = "";
// v2.3.1 Task-46 — telegram notify rate-limits: the OOM churn produced restart
// pairs + quarantine engage/release ping-pong = ~11 TG messages/hour. The
// LOG stays complete; only the TELEGRAM mirror is rate-limited.
let lastRestartNotifyAt = 0; // restart notices ≥30min apart
let lastQuarantineNotifyAt = 0; // quarantine engage/release notices ≥60min apart
const BOOT = Date.now();
const restartTimestamps: number[] = []; // PREEMPTIVE recycles only (v2.3 breaker semantics)
const rescueTimestamps: number[] = [];  // reactive rescues (app died externally) — never feed the breaker

function tehran(): string {
  return new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "medium" }).format(new Date());
}
function nowS(): number { return Math.floor(Date.now() / 1000); }

// v2.4.0 (trace 1a15bc29d2bb2c29, Task A) — HONOR the shared pause-until contract.
// dev-up.sh (operator-driven restart, v8.4 Task-73) writes .data/p0-watchdog/
// pause-until (+120s) BEFORE it touches next-server; p0-watchdog layer-1 and
// layer-2 both honor it. mem-guard was the ONLY spawner that ignored it → the
// 2026-10-20 double-spawn race (mem-guard rescue + dev-up fresh wipe) ran two
// next-server instances on one .next dir = torn SST files = Turbopack
// "corrupted database" panic = /api/flows outage (the flow-drought incident).
// From v2.4.0: when an ACTIVE pause exists, mem-guard stands down on BOTH
// intervention paths (preemptive restart + absent-rescue) until it expires.
function selfPauseRemainingSec(): number {
  try {
    const pf = parseInt(readFileSync(WD_PAUSE_FILE, "utf8").trim(), 10);
    if (isNaN(pf)) return 0;
    const rem = pf - nowS();
    return rem > 0 ? rem : 0; // expired pauses fall through to the stale janitor below
  } catch { return 0; /* no pause file — never block on guard errors */ }
}

function log(lvl: "info" | "warn" | "crit", ev: string, det: Record<string, unknown> = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), tehran: tehran(), lvl, ev, ...det });
  try { appendFileSync(ACTIONS, line + "\n"); } catch { /* never die on logging */ }
  console.log(`[${tehran()}] ${lvl.toUpperCase()} ${ev} ${JSON.stringify(det)}`);
}

function persistState() {
  const body = {
    ver: VER, pid: process.pid, startedAt: new Date(BOOT).toISOString(), tehran: tehran(),
    uptimeSec: Math.floor((Date.now() - BOOT) / 1000), ticks,
    app: { ...app, bootGraceLeftMs: app.firstSeenAt ? Math.max(0, BOOT_GRACE_MS - (Date.now() - app.firstSeenAt)) : null },
    mem, quarantined, quarantinedAt: quarantined ? quarantinedAt : null,
    restarts1h: restartTimestamps.length,
    rescues1h: rescueTimestamps.length,
    samples: {
      n: samples.length,
      rssMin: samples.length ? Math.min(...samples.map(s => s.rss)) : null,
      rssMax: samples.length ? Math.max(...samples.map(s => s.rss)) : null,
    },
    lastFreshCheckAt: lastFreshCheckAt ? new Date(lastFreshCheckAt).toISOString() : null,
  };
  try { writeFileSync(`${STATE}.tmp`, JSON.stringify(body, null, 1)); renameSync(`${STATE}.tmp`, STATE); } catch { /* best-effort */ }
  try { writeFileSync(HEARTBEAT, String(nowS())); } catch { /* best-effort */ }
}

async function notify(text: string, lvl: "info" | "warn" | "crit" = "info") {
  log(lvl, "notify", { text: text.slice(0, 120) });
  try {
    await fetch("http://127.0.0.1:3005/api/send", {
      method: "POST", headers: { "content-type": "application/json", "x-nexus-key": KEY },
      body: JSON.stringify({ text: `🛡 MEM-GUARD v2\n${text}` }), signal: AbortSignal.timeout(8000),
    });
  } catch { /* bridge down → log only (honest) */ }
}

// ── single instance ──────────────────────────────────────────────────────────
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function acquireLock(): boolean {
  try {
    if (existsSync(LOCK)) {
      const prev = JSON.parse(readFileSync(LOCK, "utf8")) as { pid?: number };
      if (prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
        console.log(`[${tehran()}] another mem-guard alive (pid ${prev.pid}) — exiting`);
        return false;
      }
    }
  } catch { /* stale lock → take over */ }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return true;
}

// ── proc sampling ────────────────────────────────────────────────────────────
function readMemInfo(): number {
  try {
    const m = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return m ? Math.floor(parseInt(m[1], 10) / 1024) : -1;
  } catch { return -1; }
}
function readRssMb(pid: number): number {
  try {
    const s = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB/m);
    return s ? Math.floor(parseInt(s[1], 10) / 1024) : -1;
  } catch { return -1; }
}
function sh(cmd: string, timeoutS = 30): string {
  try { return Bun.spawnSync(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe", timeout: timeoutS * 1000 }).stdout.toString().trim(); }
  catch { return ""; }
}
function findApp(): { pid: number; parents: number[] } | null {
  const out = sh(`ss -tlnp 2>/dev/null | grep ':3000 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`, 10);
  const pid = parseInt(out, 10);
  if (!pid || !pidAlive(pid)) return null;
  const parents: number[] = [];
  let cur = pid;
  for (let i = 0; i < 4; i++) {
    try {
      const stat = readFileSync(`/proc/${cur}/stat`, "utf8").split(" ");
      const ppid = parseInt(stat[3], 10);
      if (!ppid || ppid <= 1) break;
      parents.push(ppid); cur = ppid;
    } catch { break; }
  }
  return { pid, parents };
}

// ── LAYER 1: restart choreography ────────────────────────────────────────────
async function armorSnapshot(reason: string): Promise<boolean> {
  try {
    const r = await fetch("http://127.0.0.1:3016/cycle", {
      method: "POST", headers: { "content-type": "application/json", "x-nexus-key": KEY },
      body: JSON.stringify({ reason: `mem-guard: ${reason}` }), signal: AbortSignal.timeout(45_000),
    });
    log(r.ok ? "info" : "warn", "armor-snapshot", { ok: r.ok, status: r.status, reason });
    return r.ok;
  } catch (e) { log("warn", "armor-snapshot-failed", { err: String(e).slice(0, 120), reason }); return false; }
}

async function pauseWatchdog(seconds: number) {
  try {
    await fetch("http://127.0.0.1:3020/pause", {
      method: "POST", headers: { "content-type": "application/json", "x-nexus-key": KEY },
      body: JSON.stringify({ seconds }), signal: AbortSignal.timeout(5000),
    });
  } catch { /* fall through to file */ }
  try { mkdirSync(path.dirname(WD_PAUSE_FILE), { recursive: true }); writeFileSync(WD_PAUSE_FILE, String(nowS() + seconds)); } catch { /* best-effort */ }
  log("info", "watchdog-paused", { seconds });
}
async function releaseWatchdog() {
  try { unlinkSync(WD_PAUSE_FILE); } catch { /* already gone */ }
  try {
    await fetch("http://127.0.0.1:3020/pause", {
      method: "POST", headers: { "content-type": "application/json", "x-nexus-key": KEY },
      body: JSON.stringify({ seconds: 1 }), signal: AbortSignal.timeout(5000),
    });
  } catch { /* best-effort */ }
  log("info", "watchdog-released", {});
}

function spawnApp(): void {
  // package.json dev = NODE_OPTIONS=--max-old-space-size=768 + tee -a dev.log (envelope + append-only logs)
  sh(`setsid bash -c 'cd ${ROOT} && exec nohup bun run dev >> ${ROOT}/logs/mem-guard-restarts.log 2>&1' < /dev/null >/dev/null 2>&1 &`, 5);
  log("info", "app-spawned", { envelope: "NODE_OPTIONS 768MB", log: "logs/mem-guard-restarts.log" });
}

function killAppTree(pid: number, parents: number[]): void {
  sh(`kill ${[pid, ...parents].join(" ")} 2>/dev/null; sleep 2; kill -9 ${[pid, ...parents].join(" ")} 2>/dev/null; true`, 15);
  log("info", "app-killed", { pid, parents });
}

function waitPortFree(timeoutMs: number): boolean {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!findApp()) return true;
    Bun.sleepSync(1000);
  }
  return false;
}

function pruneCacheIfNeeded(): boolean {
  const avail = readMemInfo();
  if (avail >= 0 && avail < CACHE_PRUNE_AVAIL) {
    const sz = sh(`du -sm ${ROOT}/.next/dev/cache 2>/dev/null | cut -f1`, 20);
    sh(`rm -rf ${ROOT}/.next/dev/cache`, 30);
    log("info", "cache-pruned", { availMb: avail, freedDiskMb: sz });
    return true;
  }
  return false;
}

async function healthGate(timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch("http://127.0.0.1:3000/api/pulse", { signal: AbortSignal.timeout(8000) });
      if (r.ok) { log("info", "app-healthy", { afterMs: Date.now() - t0 }); return true; }
    } catch { /* still booting */ }
    await Bun.sleep(5000);
  }
  return false;
}

// v2.3 — quarantine auto-release: when the preemptive breaker window ages out
// (no preemptive recycle in the last hour), the guard re-arms itself instead of
// sitting alert-only forever (the 2026-10-16→18 quarantine left the RSS
// governor dead through the whole OOM storm — Task-43 root cause).
async function maybeReleaseQuarantine(): Promise<void> {
  if (!quarantined) return;
  const now = Date.now();
  while (restartTimestamps.length && now - restartTimestamps[0] > 3_600_000) restartTimestamps.shift();
  if (restartTimestamps.length < RESTARTS_PER_HOUR) {
    quarantined = false;
    log("info", "quarantine-released", { note: "preemptive-restart window aged out — RSS governor re-armed (v2.3: rescues no longer feed this breaker)" });
    if (now - lastQuarantineNotifyAt >= 3_600_000) {
      lastQuarantineNotifyAt = now;
      await notify("✅ MEM-GUARD v2.3: قرنطینهٔ حافظه برداشته شد — نگهبان RSS دوباره مسلح است (ریسکیوهای واکنشی دیگر موجب قرنطینه نمی‌شوند).", "info");
    } else log("info", "notify-throttled", { cls: "quarantine-release" });
  }
}

async function memRestart(reason: string): Promise<void> {
  if (restarting) { log("warn", "restart-suppressed-inflight", { reason }); return; }
  // v2.4.0 pause-contract: an operator-driven dev-up restart owns the app window —
  // never race it (double-writer = SST corruption, see selfPauseRemainingSec).
  const pauseRem = selfPauseRemainingSec();
  if (pauseRem > 0) { log("info", "self-paused", { scope: "preemptive-restart", reason, remainSec: pauseRem }); return; }
  const now = Date.now();
  while (restartTimestamps.length && now - restartTimestamps[0] > 3_600_000) restartTimestamps.shift();
  await maybeReleaseQuarantine();
  if (restartTimestamps.length >= RESTARTS_PER_HOUR) {
    if (!quarantined) {
      quarantined = true; quarantinedAt = now;
      log("crit", "quarantine-engaged", { reason, restarts1h: restartTimestamps.length });
      if (now - lastQuarantineNotifyAt >= 3_600_000) {
        lastQuarantineNotifyAt = now;
        await notify(`⛔ قرنطینه: ${restartTimestamps.length} ری‌استارت در یک ساعت — حافظه مزمن است. اکشن اپراتور لازم است (علت: ${reason}).`, "crit");
      } else log("info", "notify-throttled", { cls: "quarantine-engage" });
    }
    return;
  }
  restarting = true;
  try {
    log("warn", "restart-begin", { reason, rssMb: app.rssMb, availMb: mem.availableMb });
    if (now - lastRestartNotifyAt >= 1_800_000) {
      lastRestartNotifyAt = now;
      await notify(`♻️ ری‌استارت پیش‌دستانهٔ اپ (علت: ${reason}؛ RSS ${app.rssMb}MB / avail ${mem.availableMb}MB) — اسنپ‌شات armor سپس بوت سبک…`, "warn");
    } else log("info", "notify-throttled", { cls: "restart" });
    await armorSnapshot(reason);
    await pauseWatchdog(240);
    killAppTree(app.pid, app.parentPids);
    waitPortFree(15_000);
    // v2.5.0 (trace 1a15ddbdbabf84a9 RAM audit): PREEMPTIVE-ALWAYS prune removed —
    // it manufactured the very pressure it responds to. Measured treadmill 10-21:
    // restart every ~3.3min (avail<300 sustained) → wipe .next/dev/cache → next
    // boot FULLY cold-recompiles every route (GET / = 18-21s compile each boot) →
    // compiler spike re-eats ~2GB within minutes → avail<300 again → restart…
    // The double-writer risk that once justified wiping is closed by the v2.4.0
    // pause contract (single-writer doctrine). Now: keep the Turbopack cache for
    // a LIGHT WARM BOOT and prune only when post-kill available memory is
    // genuinely tight (<600MB) — reading taken AFTER the app freed its RSS,
    // exactly the moment the old comment called "always generous".
    try {
      const pk = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
      const postKillMb = pk ? Math.round(Number(pk[1]) / 1024) : -1;
      if (postKillMb >= 0 && postKillMb < 600) {
        sh(`rm -rf ${ROOT}/.next/dev/cache`, 30);
        log("info", "cache-pruned", { mode: "avail-gated", postKillMb });
      } else {
        log("info", "cache-kept", { mode: "warm-boot", postKillMb });
      }
    } catch { /* best-effort — spawn proceeds regardless */ }
    spawnApp();
    app = { pid: 0, rssMb: -1, firstSeenAt: 0, parentPids: [] }; // reset boot grace
    highRssTicks = 0; lowAvailTicks = 0;
    const ok = await healthGate(120_000);
    restartTimestamps.push(Date.now());
    await releaseWatchdog();
    if (ok) {
      log("info", "restart-success", { reason });
      // v2.3.1: success half of the restart pair is LOG-ONLY — the operator got
      // the restart notice; a second telegram per restart was pure noise.
    } else {
      log("crit", "restart-health-failed", { reason });
      await notify("❌ اپ پس از ری‌استارت سالم نشد (120s بدون پالس 200). نیاز به بررسی دستی.", "crit");
    }
  } catch (e) {
    log("crit", "restart-error", { err: String(e).slice(0, 200), reason });
    await releaseWatchdog();
  } finally {
    restarting = false;
    persistState();
  }
}

// ── LAYER 2: freshness gate ──────────────────────────────────────────────────
function armorAuthEnv(): Record<string, string> {
  try {
    const tok = readFileSync(`${ROOT}/.env`, "utf8").match(/^GITHUB_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    if (!tok) return {};
    const b64 = Buffer.from(`x-access-token:${tok}`).toString("base64");
    return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${b64}` };
  } catch { return {}; }
}
function git(args: string[], timeoutMs = 60_000): { ok: boolean; out: string } {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd: ROOT, env: { ...process.env, ...armorAuthEnv() }, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
  } catch (e) { return { ok: false, out: String(e) }; }
}

interface Freshness {
  lastKnownHead: string; lastKnownHeadAt: string; lastKnownHeadSubject: string;
  lastKnownEngineVer: string; // v2.2 ROLLBACK SENTINEL — content truth, immune to armor commit-date masking
  lastDbSignalCount: number; lastDbMaxCreatedAt: string | null;
  lastSeenAt: string; recoveries: { at: string; from: string; to: string }[];
}
function readFresh(): Freshness | null {
  for (const p of [POLAR_FRESH, MIRROR_FRESH]) {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as Freshness; } catch { /* next */ }
  }
  return null;
}
function writeFresh(f: Freshness) {
  for (const p of [POLAR_FRESH, MIRROR_FRESH]) {
    try { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(f, null, 1)); } catch { /* best-effort */ }
  }
}
/** v2.2 ROLLBACK SENTINEL — the engine version the TREE currently carries.
 *  Commit dates lie (armor re-commits the stale base with fresh timestamps);
 *  the engine version string is content truth. */
function diskEngineVer(): string {
  try {
    const src = readFileSync(`${ROOT}/src/lib/engine.ts`, "utf8");
    const m = src.match(/ENGINE_VERSION\s*=\s*"([^"]+)"/);
    return m?.[1] ?? "";
  } catch { return ""; }
}

function dbSignalStat(): { count: number; maxCreated: string | null } {
  try {
    const { Database } = (require as any)("bun:sqlite") as { Database: new (p: string) => { exec(s: string): void; prepare(s: string): { get(...a: unknown[]): Record<string, unknown> }; close(): void } };
    const db = new Database(`${ROOT}/db/custom.db`);
    db.exec("PRAGMA busy_timeout=5000");
    const c = db.prepare("SELECT COUNT(*) c FROM Signal").get().c as number;
    const m = db.prepare("SELECT MAX(createdAt) m FROM Signal").get().m as string | null;
    db.close();
    return { count: c, maxCreated: m };
  } catch { return { count: -1, maxCreated: null }; }
}

/** v2.2 — the shared remote-recovery choreography (used by BOTH the date-based
 *  staleness path and the new engine-version sentinel + DB-stale auto-heal). */
async function recoverFromRemote(ledgerHead: string, why: string): Promise<"recovered" | "fetch-failed" | "reset-failed" | "remote-agrees"> {
  const h0 = git(["rev-parse", "HEAD"]);
  const sha = h0.ok ? h0.out.split("\n")[0].trim() : "";
  const remote = git(["ls-remote", REPO, "main"], 45_000);
  const remoteSha = remote.ok ? remote.out.split("\t")[0].trim() : "";
  if (!remoteSha || remoteSha === sha) return "remote-agrees";
  const fetched = git(["fetch", "--depth=6", "origin", remoteSha], 240_000);
  if (!fetched.ok) { await notify(`⚠️ ROLLBACK-SENTINEL (${why}): stale تشخیص داده شد ولی fetch remote ناموفق بود — دستی بررسی شود.`, "crit"); return "fetch-failed"; }
  const reset = git(["reset", "--hard", remoteSha], 60_000);
  if (!reset.ok) { await notify(`❌ ROLLBACK-SENTINEL (${why}): reset شکست خورد: ${reset.out.slice(0, 100)}`, "crit"); return "reset-failed"; }
  const fresh = readFresh();
  if (fresh) {
    fresh.recoveries.push({ at: new Date().toISOString(), from: sha.slice(0, 8), to: remoteSha.slice(0, 8) });
    if (fresh.recoveries.length > 20) fresh.recoveries = fresh.recoveries.slice(-20);
    writeFresh(fresh);
  }
  const h1 = git(["log", "-1", "--format=%cI|%s", remoteSha]);
  const headDate = h1.ok ? (h1.out.split("|")[0] ?? "") : "";
  await notify(`🧬 ROLLBACK-SENTINEL (${why}): درخت به عقب برگشته بود (${why === "engine-version" ? `موتور دیسک ${diskEngineVer() || "?"} ≠ لجر ${fresh?.lastKnownEngineVer ?? "?"}` : `HEAD ${sha.slice(0, 8)} قدیمی‌تر از لجر ${ledgerHead.slice(0, 8)}`}) — به remote ${remoteSha.slice(0, 8)} (${headDate.slice(0, 16)}) بازنشانی شد. regen کلاینت + ری‌استارت اپ در جریان.`, "warn");
  // tree reset can change prisma/schema.prisma → regenerate the client BEFORE
  // the app keeps running on it (Task 37 incident class), then restart the app
  // to load both the new code and the new client. The running app always holds
  // the OLD code in memory after a rollback → restart is unconditional.
  await schemaClientGate("post-rollback-recovery");
  if (app.pid > 0) await memRestart("rollback-sentinel: tree recovered from remote");
  else pendingSchemaRestart = true;
  log("info", "rollback-recovered", { to: remoteSha.slice(0, 8), why });
  return "recovered";
}

async function freshnessGate(): Promise<void> {
  lastFreshCheckAt = Date.now();
  const h0 = git(["rev-parse", "HEAD"]);
  if (!h0.ok) { log("warn", "fresh-head-unreadable", {}); return; }
  let sha = h0.out.split("\n")[0].trim();
  const info = git(["log", "-1", "--format=%cI|%s", sha]);
  let headDate = info.out.split("|")[0] ?? "";
  let headSubject = info.out.split("|")[1] ?? "";
  const fresh = readFresh();
  const diskVer = diskEngineVer();
  const dbStat = dbSignalStat();
  let action = "none";

  // ── v2.2 SENTINEL ①: content truth — engine version divergence = rollback,
  // even when armor's fresh-timestamped commits make HEAD look current.
  if (fresh && fresh.lastKnownEngineVer && diskVer && fresh.lastKnownEngineVer !== diskVer) {
    log("crit", "engine-version-rollback-detected", { disk: diskVer, ledger: fresh.lastKnownEngineVer });
    const r = await recoverFromRemote(fresh.lastKnownHead, "engine-version");
    if (r === "recovered") { action = "recovered-from-remote(engine-version)"; }
    else if (r === "remote-agrees") { await notify("⚠️ نسخهٔ موتور دیسک با لجر فرق دارد ولی remote هم همین نسخه را دارد — لجر به‌روزرسانی می‌شود (احتمالاً deploy عمدی).", "warn"); }
    // re-read post-recovery state
    const h1 = git(["rev-parse", "HEAD"]);
    if (h1.ok) sha = h1.out.split("\n")[0].trim();
    const i1 = git(["log", "-1", "--format=%cI|%s", sha]);
    headDate = i1.ok ? (i1.out.split("|")[0] ?? headDate) : headDate;
    headSubject = i1.ok ? (i1.out.split("|")[1] ?? headSubject) : headSubject;
  } else if (fresh && fresh.lastKnownHead && fresh.lastKnownHead !== sha) {
    // ── classic date-based staleness (kept from v2.1) ──
    const ledgerMs = Date.parse(fresh.lastKnownHeadAt);
    const headMs = Date.parse(headDate);
    if (!isNaN(ledgerMs) && !isNaN(headMs) && headMs < ledgerMs - 60_000) {
      log("warn", "stale-filesystem-detected", { head: sha.slice(0, 8), headDate, ledgerHead: fresh.lastKnownHead.slice(0, 8), ledgerDate: fresh.lastKnownHeadAt });
      const r = await recoverFromRemote(fresh.lastKnownHead, "head-date");
      if (r === "recovered") action = "recovered-from-remote";
      else if (r === "remote-agrees") action = "remote-agrees-stale";
      const h2 = git(["rev-parse", "HEAD"]);
      if (h2.ok) sha = h2.out.split("\n")[0].trim();
    }
  }

  // ── v2.2 SENTINEL ②: DB-stale AUTO-HEAL (was alert-only in v2.1 — operator
  // mandate 2026-10-16). Signal rows are never pruned by design, so a >20%
  // drop is always a rollback artifact, never housekeeping. The same tree
  // reset restores db/custom.db (+wal) from the remote; SQLite discards a
  // mismatched stale WAL on next open, so the restored pair is coherent.
  const prevCount = fresh?.lastDbSignalCount ?? -1;
  if (prevCount > 0 && dbStat.count >= 0 && dbStat.count < prevCount * 0.8 && action === "none") {
    log("crit", "db-rollback-detected", { live: dbStat.count, ledger: prevCount });
    const r = await recoverFromRemote(fresh!.lastKnownHead, "db-count");
    action = r === "recovered" ? "recovered-from-remote(db-count)" : `db-stale-${r}`;
    const after = dbSignalStat();
    if (r !== "recovered") {
      await notify(`🗄 DB-STALE: سیگنال‌های زنده ${dbStat.count} < ۸۰٪ لجر (${prevCount}) و بازیابی خودکار نشد (${r}) — آخرین zip کامل: /tmp/my-project/backups/ — دستی بررسی شود.`, "crit");
    } else {
      await notify(`🗄 بازیابی DB کامل شد: ${dbStat.count} → ${after.count} ردیف.`, "warn");
    }
  }

  const finalFresh: Freshness = {
    lastKnownHead: sha,
    lastKnownHeadAt: isNaN(Date.parse(headDate)) ? new Date().toISOString() : new Date(Date.parse(headDate)).toISOString(),
    lastKnownHeadSubject: headSubject,
    lastKnownEngineVer: diskVer || fresh?.lastKnownEngineVer || "",
    lastDbSignalCount: Math.max(dbStat.count, 0),
    lastDbMaxCreatedAt: dbStat.maxCreated,
    lastSeenAt: new Date().toISOString(),
    recoveries: fresh?.recoveries ?? [],
  };
  writeFresh(finalFresh);
  log("info", "freshness-ok", { head: sha.slice(0, 8), headDate, engineVer: diskVer, dbSignals: dbStat.count, action });
}

// ── LAYER 3: schema-client gate (v2.1 — stale-Prisma-client incident class) ──
function signalModelFields(p: string): Set<string> {
  try {
    const src = readFileSync(p, "utf8");
    const m = src.match(/model Signal \{([\s\S]*?)\n\}/);
    if (!m) return new Set();
    const out = new Set<string>();
    for (const line of m[1].split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("@@") || t.startsWith("@")) continue;
      const name = t.split(/\s+/)[0];
      if (name && /^[a-zA-Z_]\w*$/.test(name)) out.add(name);
    }
    return out;
  } catch { return new Set(); }
}

/** Diff prisma/schema.prisma vs the generated client's own schema copy.
 *  Returns true when a heal happened (client was stale, regenerate succeeded)
 *  and the running app must be restarted to load the fresh client. */
async function schemaClientGate(reason: string): Promise<boolean> {
  schema.lastCheckAt = Date.now();
  const src = signalModelFields(`${ROOT}/prisma/schema.prisma`);
  const cli = signalModelFields(`${ROOT}/node_modules/.prisma/client/schema.prisma`);
  if (src.size === 0) { schema.lastResult = "source-unreadable"; log("warn", "schema-source-unreadable", {}); return false; }
  if (cli.size === 0) { schema.lastResult = "client-unreadable"; }
  const missing = [...src].filter(f => !cli.has(f));
  const extra = [...cli].filter(f => !src.has(f));
  if (missing.length === 0 && extra.length === 0) {
    schema.lastResult = "match"; schema.missing = [];
    return false;
  }
  schema.missing = missing;
  schema.lastResult = `mismatch (missing-in-client: ${missing.slice(0, 6).join(",") || "none"} | stale-extra: ${extra.slice(0, 6).join(",") || "none"})`;
  log("crit", "schema-client-mismatch", { reason, missing: missing.slice(0, 10), extra: extra.slice(0, 10), note: "app update() with these fields throws PrismaClientValidationError → lifecycle freeze + per-tick event spam (2026-10-15 incident)" });
  if (Date.now() - schema.lastHealAt < 30 * 60_000) {
    log("warn", "schema-heal-throttled", { lastHealMinAgo: Math.round((Date.now() - schema.lastHealAt) / 60_000) });
    return false;
  }
  schema.lastHealAt = Date.now();
  sh(`cd ${ROOT} && bunx prisma generate >/dev/null 2>&1`, 240);
  const cli2 = signalModelFields(`${ROOT}/node_modules/.prisma/client/schema.prisma`);
  const stillMissing = [...src].filter(f => !cli2.has(f));
  if (stillMissing.length === 0 && cli2.size > 0) {
    schema.lastResult = "healed"; schema.missing = [];
    log("info", "schema-client-healed", { reason, regenerated: missing.length });
    if (app.pid === 0) pendingSchemaRestart = true; // boot probe: app not up yet → restart on first tick sighting
    await notify(`🧬 SCHEMA-CLIENT GUARD: کلاینت Prisma stale بود (ستون‌های ${missing.slice(0, 3).join(",")}… نبود) — بازتولید شد (${reason}). اپ برای بارگذاری کلاینت جدید ری‌استارت می‌شود.`, "warn");
    return true;
  }
  schema.lastResult = `heal-failed (${stillMissing.slice(0, 4).join(",")})`;
  await notify(`❌ SCHEMA-CLIENT: بازتولید کلاینت مشکل را حل نکرد (${stillMissing.slice(0, 3).join(",")}…) — بررسی دستی لازم است.`, "crit");
  return false;
}

// ── watchdog frozen supervision ──────────────────────────────────────────────
async function watchdogSupervise(): Promise<void> {
  try {
    const r = await fetch("http://127.0.0.1:3020/status", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(String(r.status));
    const st = await r.json() as { mem?: { at?: number } };
    const at = st.mem?.at ?? 0;
    if (at && Date.now() - at > 90_000) {
      if (!wdFrozenSince) { wdFrozenSince = Date.now(); log("warn", "watchdog-tick-frozen-suspected", { memAtAgeMs: Date.now() - at }); }
      else if (Date.now() - wdFrozenSince > 120_000) {
        wdFrozenSince = 0;
        log("crit", "watchdog-frozen-restarting", {});
        sh(`pid=$(ss -tlnp 2>/dev/null | grep ':3020 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$pid" ] && kill $pid; sleep 2; kill -9 $pid 2>/dev/null; true`, 15);
        sh(`setsid bash -c 'cd ${ROOT}/mini-services/p0-watchdog && exec nohup bun --hot index.ts >> ${ROOT}/logs/p0-watchdog-service.log 2>&1' < /dev/null >/dev/null 2>&1 &`, 5);
        await notify("🔄 p0-watchdog منجمد بود (tick loop) — توسط MEM-GUARD ری‌استارت شد.", "warn");
      }
    } else wdFrozenSince = 0;
  } catch { wdFrozenSince = 0; /* watchdog fully down → its own heal path handles; do not double-heal */ }
}

// ── log hygiene ──────────────────────────────────────────────────────────────
function logHygiene(): void {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const st = statSync(`${ROOT}/dev.log`);
    if (st.size > 40 * 1024 * 1024) {
      mkdirSync(`${ROOT}/logs/archive`, { recursive: true });
      const dest = `${ROOT}/logs/archive/dev-${day}-${nowS()}.log.gz`;
      writeFileSync(dest, Bun.gzipSync(readFileSync(`${ROOT}/dev.log`)));
      writeFileSync(`${ROOT}/dev.log`, "");
      log("info", "devlog-rotated", { bytes: st.size, dest });
    }
  } catch { /* no dev.log yet */ }
  if (day !== lastRotationDay) {
    lastRotationDay = day;
    try {
      const arch = `${ROOT}/logs/archive`;
      const files = readdirSync(arch).filter(f => f.startsWith("dev-")).sort();
      while (files.length > 7) { const f = files.shift(); if (f) { unlinkSync(`${arch}/${f}`); log("info", "archive-pruned", { f }); } }
    } catch { /* best-effort */ }
  }
}

// ── main tick (self-reaping chain — one failed tick can never kill the loop) ─
async function tick(): Promise<void> {
  ticks++;
  mem = { availableMb: readMemInfo(), level: "ok", at: Date.now() };
  mem.level = mem.availableMb < 350 ? "crit" : mem.availableMb < 600 ? "warn" : "ok";
  await maybeReleaseQuarantine(); // v2.3 — auto-release when the preemptive window ages out

  const found = findApp();
  if (found) {
    if (found.pid !== app.pid) {
      app = { pid: found.pid, rssMb: readRssMb(found.pid), firstSeenAt: Date.now(), parentPids: found.parents };
      highRssTicks = 0; lowAvailTicks = 0;
      log("info", "app-pid-seen", { pid: found.pid, parents: found.parents.slice(0, 2) });
    } else {
      app.rssMb = readRssMb(found.pid);
      app.parentPids = found.parents;
    }
    samples.push({ t: Date.now(), rss: app.rssMb, avail: mem.availableMb });
    if (samples.length > SAMPLE_CAP) samples = samples.slice(-SAMPLE_CAP);

    const bootGrace = Date.now() - app.firstSeenAt < BOOT_GRACE_MS;
    if (!bootGrace && !restarting) {
      if (app.rssMb >= RSS_HARD) highRssTicks = RSS_SUSTAIN_TICKS;
      else if (app.rssMb >= RSS_ACT) highRssTicks++; else highRssTicks = 0;
      if (mem.availableMb >= 0 && mem.availableMb < AVAIL_FLOOR && app.rssMb > 1200) lowAvailTicks++; else lowAvailTicks = 0;
      if (highRssTicks >= RSS_SUSTAIN_TICKS || lowAvailTicks >= 3) {
        const why = highRssTicks >= RSS_SUSTAIN_TICKS ? `RSS ${app.rssMb}MB ≥ ${RSS_ACT}MB sustained` : `avail ${mem.availableMb}MB < ${AVAIL_FLOOR}MB sustained`;
        await memRestart(why);
      }
    } else if (bootGrace && (app.rssMb >= RSS_HARD || (mem.availableMb >= 0 && mem.availableMb < 300))) {
      log("warn", "boot-spike-observed", { rssMb: app.rssMb, availMb: mem.availableMb, note: "grace active — observe only (kernel OOM risk window)" });
    }
  } else if (!restarting) {
    app = { pid: 0, rssMb: -1, firstSeenAt: 0, parentPids: [] };
    if (ticks % 4 === 0) { // ~1min of app-absence → rescue (watchdog primary, mem-guard secondary)
      // v2.4.0 pause-contract: during an operator-driven dev-up window the app is
      // EXPECTED to be absent — spawning here would be the second writer.
      const pauseRem = selfPauseRemainingSec();
      if (pauseRem > 0) {
        log("info", "self-paused", { scope: "absent-rescue", remainSec: pauseRem, note: "external spawner owns the app window (dev-up contract)" });
      } else {
      log("warn", "app-absent", { availMb: mem.availableMb });
      await pauseWatchdog(240);
      pruneCacheIfNeeded();
      spawnApp();
      const ok = await healthGate(120_000);
      await releaseWatchdog();
      // v2.3: rescue spawns are REACTIVE (app died externally — kernel OOM,
      // platform recycle). They must NEVER feed the PREEMPTIVE RSS breaker:
      // the 2026-10-18 OOM storm kept this guard breaker-blocked exactly when
      // the preemptive recycle was needed most (Task-43 root cause).
      rescueTimestamps.push(Date.now());
      if (rescueTimestamps.length > 20) rescueTimestamps.shift();
      log(ok ? "info" : "crit", "app-rescue-" + (ok ? "ok" : "failed"), { rescues1h: rescueTimestamps.length });
      } // v2.4.0 pause-contract else
    }
  }

  if (ticks % FRESH_EVERY_TICKS === 0) await freshnessGate();
  if (ticks % FRESH_EVERY_TICKS === 10) {
    // LAYER 3 periodic probe (offset from freshness so both never collide)
    const healed = await schemaClientGate("periodic");
    if (healed && app.pid > 0) await memRestart("schema-client healed (periodic probe)");
    else if (pendingSchemaRestart && app.pid > 0) { pendingSchemaRestart = false; await memRestart("schema-client healed (pending restart)"); }
  }
  await watchdogSupervise();
  logHygiene();
  persistState();
}

function scheduleTick() {
  setTimeout(async () => {
    try { await tick(); } catch (e) { try { log("crit", "tick-error", { err: String(e).slice(0, 200) }); } catch { /* */ } }
    scheduleTick();
  }, TICK_MS);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function keyOk(req: Request): boolean {
  const k = req.headers.get("x-nexus-key") ?? "";
  if (!KEY || !k || k.length !== KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < KEY.length; i++) diff |= k.charCodeAt(i) ^ KEY.charCodeAt(i);
  return diff === 0;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, ver: VER, pid: process.pid, uptimeSec: Math.floor((Date.now() - BOOT) / 1000) });
    if (url.pathname === "/status") {
      return Response.json({
        ok: true, ver: VER, pid: process.pid, uptimeSec: Math.floor((Date.now() - BOOT) / 1000), tehran: tehran(), ticks,
        app: { ...app, bootGraceLeftMs: app.firstSeenAt ? Math.max(0, BOOT_GRACE_MS - (Date.now() - app.firstSeenAt)) : null },
        mem, quarantined, quarantinedAt: quarantined ? quarantinedAt : null,
        restarts1h: restartTimestamps.length,
        rescues1h: rescueTimestamps.length,
        samples: { n: samples.length, rssMaxMb: samples.length ? Math.max(...samples.map(s => s.rss)) : null, availMinMb: samples.length ? Math.min(...samples.map(s => s.avail)) : null },
        freshness: { lastCheckAt: lastFreshCheckAt ? new Date(lastFreshCheckAt).toISOString() : null, ledger: readFresh() },
        schema: { ...schema, lastCheckAt: schema.lastCheckAt ? new Date(schema.lastCheckAt).toISOString() : null, lastHealAt: schema.lastHealAt ? new Date(schema.lastHealAt).toISOString() : null },
        watchdogFrozenSuspected: wdFrozenSince > 0,
        recentActions: (() => { try { return readFileSync(ACTIONS, "utf8").trim().split("\n").slice(-20).map(l => { try { return JSON.parse(l); } catch { return l; } }); } catch { return []; } })(),
      });
    }
    if (req.method === "POST" && !keyOk(req)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    if (req.method === "POST" && url.pathname === "/api/restart") {
      let reason = "manual";
      try { const b = await req.json() as { reason?: string }; if (b?.reason) reason = String(b.reason).slice(0, 80); } catch { /* default */ }
      void memRestart(reason);
      return Response.json({ ok: true, note: "restart choreography started (async)" });
    }
    if (req.method === "POST" && url.pathname === "/api/freshness-check") { await freshnessGate(); return Response.json({ ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/snapshot") { const ok = await armorSnapshot("manual-request"); return Response.json({ ok }); }
    if (req.method === "POST" && url.pathname === "/api/schema-check") {
      const healed = await schemaClientGate("manual-request");
      if (healed && app.pid > 0) void memRestart("schema-client healed (manual probe)");
      return Response.json({ ok: true, healed, schema });
    }
    return new Response("not found", { status: 404 });
  },
});

// ── boot ─────────────────────────────────────────────────────────────────────
if (!acquireLock()) process.exit(0);
mkdirSync(DIR, { recursive: true }); mkdirSync(POLAR, { recursive: true });
log("info", "boot", { ver: VER, port: PORT, pid: process.pid });
void (async () => {
  try {
    const pf = parseInt(readFileSync(WD_PAUSE_FILE, "utf8").trim(), 10);
    if (!isNaN(pf) && pf < nowS() && nowS() - pf > 600) { unlinkSync(WD_PAUSE_FILE); log("info", "stale-pause-file-removed", {}); }
  } catch { /* absent */ }
  await freshnessGate();
  const healedBoot = await schemaClientGate("boot");
  if (healedBoot && app.pid > 0) await memRestart("schema-client healed (boot probe)");
})();
scheduleTick();
