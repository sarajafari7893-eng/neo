/**
 * NEXUS//SIGNALS — push-armor v2.0 (reborn 2026-09-26 after rollback #4)
 *
 * Doctrine: the ONLY real armor against platform restore is an external git remote.
 * This service commits workspace state and pushes to the operator's private repo.
 *
 * v2.0 hardening (lessons from rollback #4):
 *  - PREFLIGHT: refuses to push if .env is tracked or present in HEAD tree (secret-leak guard)
 *  - Token travels ONLY via in-memory http.extraheader env (never URL, never argv, never logs)
 *  - All outputs redacted against token substring (defense in depth)
 *  - Per-op timeout, single-flight lock, state persisted to .data/push-armor/state.json
 *
 * Endpoints: GET /health | GET /status | POST /cycle (manual trigger)
 * Auto cycle: every 10 minutes.
 *
 * v2.1 (Task 37, 2026-09-26):
 *  - POST /cycle now requires `x-nexus-key` === NEXUS_CONTROL_KEY, read LIVE
 *    from the .env file (Task 36 doctrine — rotation lands next request, no
 *    restart). Closes audit finding W1 (SECURITY-HARDENING.md). Fail-closed;
 *    constant-time compare; key never echoed.
 *  - `git add -A` retries once after 1.2s: concurrent writers (SQLite WAL,
 *    telemetry jsonl) can race staging ("confused by unstable object source
 *    data") and had wedged the 18:17 cycle.
 *
 * v2.3 (LEASH-0929b, 2026-09-29):
 *  - The 5th generation (boot 09:28Z) exposed the LAST manual step of the
 *    recovery runbook: the stale snapshot's package.json lacked the socket.io
 *    declaration, node_modules is gitignored, so price-ws died with
 *    "Cannot find package" until a human ran `bun install`.
 *  - alignWorkspace now re-syncs deps after EVERY hard-reset AND spawns the
 *    guardian-stack rebuild in the behind-branch too (the old behind-branch
 *    only reset files — services kept running stale code until the next
 *    recycle). Recycle → boot → align → install → resurrect = fully
 *    autonomous recovery, zero human steps.
 *  - Ledger durability was verified as already riding every push (db/
 *    custom.db staged by add -A since 09-20; git delta-compresses adjacent
 *    sqlite snapshots, pack only ~237MiB after 10 days; loss window ≤ 10 min).
 *
 * v2.3.1 (LEASH-0929b hotfix, 2026-09-29):
 *  - The live-fire drills exposed a WAL-tail hole: reset --hard restores the
 *    main-db blob but the stale wal blob (different commit vintage) is
 *    ignored by sqlite on open → the un-checkpointed tail (~2,066 events in
 *    the drill) evaporated. Fix A: PRAGMA wal_checkpoint(TRUNCATE) right
 *    before every `git add -A` → the staged main db ALWAYS contains the full
 *    ledger, wal blob stays ~empty. Fix B: after any hard-reset, stale
 *    db/custom.db-wal/-shm are removed before services restart.
 *  - resetAndRebuild now tees resurrect output into logs/resurrect.log
 *    (it was spawn-ignored — post-recycle forensics were blind).
 *
 * v2.3.2 (LEASH-0929b hotfix 2, 2026-09-29):
 *  - Drill C exposed the orphan-fd trap: a reset swaps db/custom.db under a
 *    RUNNING app — its Prisma fd keeps writing to the orphaned inode while
 *    the dashboard still answers 200, so the probe-gated dev-up never
 *    restarts it and the restored ledger looks frozen. Fix: after every
 *    hard-reset the app (port 3000) is killed; the spawned resurrect brings
 *    it back with a fresh Prisma fd on the restored db. Harmless in the
 *    real-recycle case (nothing survives a recycle anyway).
 *  - armor's own dev script dropped `bun --hot` (hot-reload re-runs the
 *    module top-level on the very file change alignWorkspace just made,
 *    aborting the install/resurrect chain mid-flight). Plain `bun index.ts`:
 *    the reset executor must never hot-reload.
 */

import { readFileSync } from "node:fs";

const PORT = 3016;
const VER = "push-armor 2.4.0";
const BUN_INSTALL_TIMEOUT_MS = 240_000;
const REPO_URL = "https://github.com/sarajafari7893-eng/neo.git";
const BRANCH = "main";
const AUTO_CYCLE_MS = 10 * 60 * 1000; // 10 min
const GIT_TIMEOUT_MS = 90_000;

const BOOT_AT = Date.now();
const ROOT = "/home/z/my-project";

interface CycleResult {
  at: string;
  committed: boolean;
  commitSha: string | null;
  pushed: boolean;
  skipped?: string;
  error?: string;
  durationMs: number;
}

interface State {
  cycles: number;
  pushes_ok: number;
  pushes_fail: number;
  lastCycle: CycleResult | null;
  lastOkPushAt: string | null;
  consecutivePushFails: number;
  preflightBlocked: boolean;
}

const state: State = {
  cycles: 0,
  pushes_ok: 0,
  pushes_fail: 0,
  lastCycle: null,
  lastOkPushAt: null,
  consecutivePushFails: 0,
  preflightBlocked: false,
};

// ---------- helpers ----------

function tehranTime(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date());
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${redact(msg)}`);
}

async function loadToken(): Promise<void> {
  try {
    const t = await Bun.file(`${ROOT}/.env`).text();
    const m = t.match(/^GITHUB_TOKEN=(.+)$/m);
    TOKEN = m ? m[1].trim() : "";
    if (TOKEN) log("token loaded from .env (never echoed)");
    else log("WARN: GITHUB_TOKEN missing in .env — push will fail until configured");
  } catch {
    log("WARN: .env unreadable");
  }
}

let TOKEN = "";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Task 36 doctrine: the .env FILE is the live source of truth — read fresh per
// request (control plane is low-traffic; nothing cached to go stale).
function readControlKey(): string {
  try {
    const m = readFileSync(`${ROOT}/.env`, "utf8").match(/^NEXUS_CONTROL_KEY=(.+)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

function redact(s: string): string {
  if (!s) return s;
  let out = s;
  if (TOKEN && TOKEN.length > 8) out = out.split(TOKEN).join("***REDACTED***");
  return out
    .replace(/ghp_[A-Za-z0-9_]+/g, "***REDACTED***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "***REDACTED***");
}

function saveState(): void {
  Bun.write(`${ROOT}/.data/push-armor/state.json`, JSON.stringify(state, null, 2)).catch(() => {});
}

function git(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ ok: boolean; out: string; code: number }> {
  return new Promise((resolve) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    });
    const timer = setTimeout(() => {
      try {
        proc.kill(9);
      } catch {}
    }, GIT_TIMEOUT_MS);
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
      ([so, se, code]) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, out: redact(`${so}\n${se}`.trim()), code });
      },
    );
  });
}

function authEnv(): Record<string, string> {
  if (!TOKEN) return {};
  const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
  // Token lives only inside child-process env → invisible in ps output and git error text.
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://github.com/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${b64}`,
  };
}

// ---------- LEASH-0929b: autonomous runtime rebuild ----------

// v2.3.1 Fix A: fold the WAL tail into the main db right before staging, so
// every pushed blob is a COMPLETE ledger (a reset mid-history can then never
// drop un-checkpointed events — the drill lost ~2,066 events this way).
// Same pattern as backup.sh v3.1 (busy_timeout against Prisma write races).
async function checkpointDb(): Promise<boolean> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(`${ROOT}/db/custom.db`);
    db.exec("PRAGMA busy_timeout=8000");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    return true;
  } catch (e) {
    log(`wal_checkpoint failed (non-fatal, loss bounded to wal tail): ${redact(String(e)).slice(0, 120)}`);
    return false;
  }
}

// v2.3.1 Fix B: a hard-reset restores db+wal+shm from DIFFERENT commit
// vintages — sqlite ignores a mismatched wal on open, so a stale wal blob is
// dead weight at best and confusion at worst. Clean slate before restart.
function dropStaleWalSidecars(): void {
  try {
    for (const f of ["db/custom.db-wal", "db/custom.db-shm"]) {
      Bun.spawnSync(["rm", "-f", `${ROOT}/${f}`]);
    }
    log("align: stale db wal/shm sidecars dropped");
  } catch {}
}

// v2.3.2: a reset swaps the db file under a RUNNING app — its Prisma fd then
// writes to the orphaned inode while the dashboard still answers 200, so the
// probe-gated dev-up never restarts it (ledger looks frozen). Kill the app
// after every reset; the spawned resurrect starts it fresh on the restored db.
function killAppForReconnect(): void {
  try {
    const pid = Bun.spawnSync([
      "bash",
      "-c",
      `ss -tlnp 2>/dev/null | grep ":3000 " | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2`,
    ])
      .stdout.toString()
      .trim();
    if (pid) {
      Bun.spawnSync(["kill", pid]);
      log(`align: app (port 3000 pid ${pid}) killed — fresh Prisma fd on restored db`);
    }
  } catch {}
}

// node_modules is gitignored by design — a hard-reset can swap
// package.json/bun.lock under it (5th generation: stale snapshot without the
// socket.io declaration → price-ws "Cannot find package" → every heal dead
// until a MANUAL bun install). Any reset therefore re-syncs deps itself.
async function bunInstall(trigger: string): Promise<boolean> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const proc = Bun.spawn(["bun", "install"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const timer = setTimeout(() => {
      try {
        proc.kill(9);
      } catch {}
    }, BUN_INSTALL_TIMEOUT_MS);
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
      ([so, se, code]) => {
        clearTimeout(timer);
        const ok = code === 0;
        log(
          `align(${trigger}): bun install ok=${ok} in ${Date.now() - t0}ms — ${redact(`${so}\n${se}`.trim()).slice(0, 160)}`,
        );
        resolve(ok);
      },
    );
  });
}

// reset to origin/<branch>, re-sync node_modules, rebuild the guardian stack.
// Used for BOTH reset flavors: behind (ff) and diverged (recycle signature).
// The old behind-branch only reset files — services kept running stale code
// until the next recycle. Now every reset ends in a full rebuild.
async function resetAndRebuild(trigger: string, kind: string): Promise<boolean> {
  const rs = await git(["reset", "--hard", `origin/${BRANCH}`]);
  log(`align(${trigger}): ${kind} → HARD-RESET to origin/${BRANCH} ok=${rs.ok}`);
  if (!rs.ok) return false;
  dropStaleWalSidecars();
  killAppForReconnect();
  const deps = await bunInstall(trigger);
  Bun.spawn(
    ["setsid", "bash", "-c", `exec bash ${ROOT}/scripts/resurrect.sh --no-armor >> ${ROOT}/logs/resurrect.log 2>&1`],
    {
      cwd: ROOT,
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  log(`align(${trigger}): guardian stack rebuild spawned (deps=${deps ? "ok" : "FAIL"})`);
  return true;
}

// ---------- preflight: secret-leak guard ----------

async function preflight(): Promise<{ ok: boolean; reason?: string }> {
  // 1) .env must NOT be tracked
  const tracked = await git(["ls-files", "--error-unmatch", ".env"]);
  if (tracked.ok) {
    return {
      ok: false,
      reason: "PREFLIGHT-BLOCK: .env is tracked in git index — untrack before any push!",
    };
  }
  // 2) .env must NOT exist in HEAD tree
  const inTree = await git(["ls-tree", "HEAD", ".env"]);
  if (inTree.ok && inTree.out.trim().length > 0) {
    return {
      ok: false,
      reason: "PREFLIGHT-BLOCK: .env found in HEAD tree — history scrub required before push!",
    };
  }
  // 3) remote must exist
  const rem = await git(["remote", "get-url", "origin"]);
  if (!rem.ok) return { ok: false, reason: "PREFLIGHT-BLOCK: origin remote missing" };
  return { ok: true };
}

// ---------- the cycle ----------

let running = false;

// ---------- Task 80 GIT-HYGIENE (2026-10-05 disk emergency) ----------
// Armor's 10-min db snapshots accumulate as loose git objects (~1.1GB/day at
// zlib-loose size — the root cause of the 05/10 disk emergency where .git hit
// 5.0GB and rootfs fell to 1.5GB free). INCREMENTAL repack only (no `-a`):
// two full-repack/gc attempts on 05/10 each invoked the oom-killer alongside
// the ~1.9GB next-server (lesson logged in worklog) — incremental packing of
// the loose set with a 64m delta window compresses the adjacent 10-min db
// snapshots ~8:1 at negligible memory. Bounded: ≥30min between runs, only
// when loose objects exceed ~200MB, fail-open.
let lastPackAt = 0;
async function gitHygiene(): Promise<void> {
  try {
    if (Date.now() - lastPackAt < 30 * 60_000) return;
    const cnt = await git(["count-objects", "-v"]);
    const m = /size: (\d+)/.exec(cnt.out ?? "");
    if (!m || Number(m[1]) < 200_000) return; // loose KiB < ~200MB → skip
    lastPackAt = Date.now();
    log(`git-hygiene: incremental pack of loose objects (~${(Number(m[1]) / 1024).toFixed(0)}MB)`);
    const t = Date.now();
    const r1 = await git(["-c", "pack.windowMemory=64m", "-c", "pack.threads=1", "repack", "-d", "-q", "--window=10", "--window-memory=64m"]);
    const r2 = await git(["prune-packed", "-q"]);
    log(`git-hygiene done ok=${r1.ok}/${r2.ok} in ${Date.now() - t}ms`);
  } catch (e) {
    log(`git-hygiene error: ${redact(String(e)).slice(0, 200)}`);
  }
}

async function cycle(trigger: string): Promise<CycleResult> {
  const t0 = Date.now();
  if (running) {
    return {
      at: new Date().toISOString(),
      committed: false,
      commitSha: null,
      pushed: false,
      skipped: "single-flight: previous cycle still running",
      durationMs: 0,
    };
  }
  running = true;
  const result: CycleResult = {
    at: new Date().toISOString(),
    committed: false,
    commitSha: null,
    pushed: false,
    durationMs: 0,
  };
  try {
    const pf = await preflight();
    if (!pf.ok) {
      state.preflightBlocked = true;
      result.error = pf.reason;
      log(pf.reason ?? "preflight blocked");
      return result;
    }
    state.preflightBlocked = false;

    // v2.4.0 (2026-10-15, MEM-GUARD v2 mandate): STALE-BASE GUARD — a platform
    // restore can roll the git layer back (observed 2026-10-15: HEAD back to the
    // 09-27 era = engine v10.18 while GitHub kept the full v11.6 chain). Working
    // and pushing on a stale base extends the stale chain and ships stale state
    // offsite (exactly what happened at boot 09:27 before the guard existed).
    // The freshness ledger (mem-guard writes it to PolarFS + .data) is the
    // source of truth: if HEAD's commit date is OLDER than the ledger's
    // last-known head by >120s AND the SHAs differ, skip this cycle and page
    // mem-guard's freshness gate (it can auto-recover from the remote tip).
    try {
      const freshPath = `${ROOT}/.data/mem-guard/freshness.json`;
      const freshFile = Bun.file(freshPath);
      if (await freshFile.exists()) {
        const fresh = await freshFile.json() as { lastKnownHead?: string; lastKnownHeadAt?: string };
        if (fresh?.lastKnownHead && fresh?.lastKnownHeadAt) {
          const headInfo = await git(["log", "-1", "--format=%H|%cI"]);
          const [headSha, headDate] = headInfo.out.split("|");
          const headMs = Date.parse(headDate ?? "");
          const ledgerMs = Date.parse(fresh.lastKnownHeadAt);
          if (
            headInfo.ok && !isNaN(headMs) && !isNaN(ledgerMs) &&
            headSha && headSha !== fresh.lastKnownHead &&
            headMs < ledgerMs - 120_000
          ) {
            result.skipped = `STALE-BASE-GUARD: HEAD ${headSha.slice(0, 8)} (${headDate}) is older than freshness ledger ${fresh.lastKnownHead.slice(0, 8)} (${fresh.lastKnownHeadAt}) — push withheld, paging mem-guard freshness gate`;
            log(result.skipped);
            void fetch("http://127.0.0.1:3019/api/freshness-check", {
              method: "POST",
              headers: { "content-type": "application/json", "x-nexus-key": process.env.NEXUS_CONTROL_KEY ?? "" },
              signal: AbortSignal.timeout(8000),
            }).catch(() => {});
            return result;
          }
        }
      }
    } catch { /* ledger absent/corrupt → normal cycle (mem-guard owns the gate) */ }

    // v2.3.1: fold the WAL tail into the main db BEFORE staging — the pushed
    // blob must be a complete ledger, or a future reset loses the tail.
    await checkpointDb();

    // stage everything (state files, db, docs, code)
    let add = await git(["add", "-A"]);
    if (!add.ok) {
      // v2.1: concurrent writers (SQLite WAL, telemetry jsonl) can race
      // staging — brief pause, single retry; persistent failure still
      // surfaces as a cycle error.
      await new Promise((res) => setTimeout(res, 1200));
      add = await git(["add", "-A"]);
    }
    if (!add.ok) {
      result.error = `git add failed: ${add.out.slice(0, 300)}`;
      return result;
    }

    // commit only if there is something staged
    const diff = await git(["diff", "--cached", "--quiet"]);
    if (diff.code === 1) {
      const msg = `nexus-state ${new Date().toISOString()} (armor v2)`;
      const cm = await git(["commit", "-q", "-m", msg]);
      if (!cm.ok) {
        result.error = `git commit failed: ${cm.out.slice(0, 300)}`;
        return result;
      }
      result.committed = true;
      const sha = await git(["rev-parse", "--short", "HEAD"]);
      result.commitSha = sha.ok ? sha.out.split("\n")[0] : null;
      log(`committed: ${result.commitSha}`);
    } else {
      log("nothing to commit");
    }

    // push
    // TASK-40 (2026-09-27): torn-read .env race — the 09:25 restart wave wrote
    // .env 242ms AFTER armor booted; the boot-time loadToken() read the file
    // mid-rewrite (truncate window) and cached an EMPTY token, so every push
    // failed with "could not read Username" until the next armor restart.
    // Lazy re-load on each push when the token is not yet available (live-env
    // doctrine) — a successful boot-time load is never overwritten.
    if (!TOKEN) await loadToken();
    const push = await git(["push", "origin", BRANCH], authEnv());
    if (push.ok) {
      result.pushed = true;
      state.pushes_ok += 1;
      state.consecutivePushFails = 0;
      state.lastOkPushAt = result.at;
      log(`push OK → github.com/sarajafari7893-eng/neo (masked)`);
    } else {
      state.pushes_fail += 1;
      state.consecutivePushFails += 1;
      result.error = `push failed: ${push.out.slice(0, 400)}`;
      log(result.error);
      // RECOVERY-0928: non-fast-forward ⇒ our base diverged from the durable
      // store (stale-snapshot recycle). Align once and retry this same push.
      if (/non-fast-forward|rejected|fetch first/i.test(push.out)) {
        const aligned = await alignWorkspace("push-fail");
        if (aligned) {
          const retry = await git(["push", "origin", BRANCH], authEnv());
          if (retry.ok) {
            result.pushed = true;
            state.pushes_ok += 1;
            state.consecutivePushFails = 0;
            state.lastOkPushAt = result.at;
            result.error = undefined;
            log("push OK after workspace alignment retry");
          } else {
            result.error = `push failed after alignment: ${retry.out.slice(0, 300)}`;
            log(result.error);
          }
        }
      }
    }
    // Task 80 git-hygiene — AFTER push bookkeeping so a hygiene failure can
    // never affect the durability path (rate-limited + threshold inside).
    await gitHygiene().catch(() => undefined);
    return result;
  } catch (e) {
    result.error = redact(String(e)).slice(0, 300);
    return result;
  } finally {
    result.durationMs = Date.now() - t0;
    state.cycles += 1;
    state.lastCycle = result;
    saveState();
    running = false;
    log(
      `cycle(${trigger}) done committed=${result.committed} pushed=${result.pushed} in ${result.durationMs}ms`,
    );
  }
}

// ---------- RECOVERY-0928: workspace self-alignment ----------
// The sandbox is recycled by the platform between operator sessions; the
// restored workspace can be a STALE snapshot whose git base DIVERGED from
// origin/main (proven 2026-09-27 AND 2026-09-28: armor kept 10-min commits on
// the stale base while every push died non-fast-forward — silently freezing
// all durable progress). Alignment rule:
//   local behind (ff)       → reset --hard origin/<branch>  (restore)
//   local ahead             → nothing (normal operation, push will land)
//   diverged (recycle case) → reset --hard origin/<branch> + resurrect the
//     guardian stack from THIS platform-lineage process. Local-only
//     "nexus-state" commits are disposable runtime snapshots by design.
async function alignWorkspace(trigger: string): Promise<boolean> {
  const fe = await git(["fetch", "origin", BRANCH], authEnv());
  if (!fe.ok) {
    log(`align(${trigger}): fetch failed — skip (${fe.out.slice(0, 120)})`);
    return false;
  }
  const rp = await git(["rev-parse", "--verify", `origin/${BRANCH}`]);
  if (!rp.ok) return false;
  const remoteSha = rp.out.split("\n")[0];
  const head = await git(["rev-parse", "HEAD"]);
  if (head.ok && head.out.split("\n")[0] === remoteSha) return false; // aligned
  const behind = await git(["merge-base", "--is-ancestor", "HEAD", `origin/${BRANCH}`]);
  if (behind.code === 0) {
    return resetAndRebuild(trigger, "local behind (stale-snapshot restore)");
  }
  const ahead = await git(["merge-base", "--is-ancestor", `origin/${BRANCH}`, "HEAD"]);
  if (ahead.code === 0) return false; // local ahead — normal
  // diverged: the recycle signature — rebuild from the durable store
  return resetAndRebuild(trigger, "DIVERGED");
}

// ---------- boot ----------

async function ensureRemote(): Promise<void> {
  const r = await git(["remote", "get-url", "origin"]);
  if (!r.ok) {
    await git(["remote", "add", "origin", REPO_URL]);
    log("origin remote re-added");
  }
}

await loadToken();
await ensureRemote();
// RECOVERY-0928: align BEFORE the first commit cycle so a recycled workspace
// never commits on a stale base (the 2026-09-28 divergence engine).
await alignWorkspace("boot");

setInterval(() => void cycle("auto"), AUTO_CYCLE_MS);
setTimeout(() => void cycle("boot"), 15_000); // first cycle 15s after boot

// ---------- http ----------

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      return Response.json({
        ok: true,
        ver: VER,
        port: PORT,
        pid: process.pid,
        uptimeSec: Math.floor((Date.now() - BOOT_AT) / 1000),
        tehran: tehranTime(),
        tokenConfigured: TOKEN.length > 0,
        remote: REPO_URL,
        autoCycleMin: AUTO_CYCLE_MS / 60000,
      });
    }

    if (path === "/status") {
      return Response.json({
        ok: true,
        ver: VER,
        tokenConfigured: TOKEN.length > 0,
        remote: REPO_URL,
        branch: BRANCH,
        ...state,
        tehran: tehranTime(),
      });
    }

    if (path === "/cycle" && req.method === "POST") {
      // v2.1 / W1 closure: control-key gate, live-read from .env (Task 36
      // doctrine). Fail-closed when the key is unset.
      const expected = readControlKey();
      const provided = req.headers.get("x-nexus-key") ?? "";
      if (expected.length === 0 || !constantTimeEqual(provided, expected)) {
        return Response.json(
          { error: "unauthorized: /cycle requires x-nexus-key header" },
          { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } },
        );
      }
      const r = await cycle("manual");
      return Response.json({ ok: !r.error, trigger: "manual", ...r }, { status: r.error ? 502 : 200 });
    }

    return new Response("not found", { status: 404 });
  },
});

log(`${VER} listening on :${PORT} → github.com/sarajafari7893-eng/neo`);
