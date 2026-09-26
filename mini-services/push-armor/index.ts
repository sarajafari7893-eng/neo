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
 */

const PORT = 3016;
const VER = "push-armor 2.0";
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

    // stage everything (state files, db, docs, code)
    const add = await git(["add", "-A"]);
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
    }
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
      const r = await cycle("manual");
      return Response.json({ ok: !r.error, trigger: "manual", ...r }, { status: r.error ? 502 : 200 });
    }

    return new Response("not found", { status: 404 });
  },
});

log(`${VER} listening on :${PORT} → github.com/sarajafari7893-eng/neo`);
