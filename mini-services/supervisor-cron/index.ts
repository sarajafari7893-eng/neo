// ── NEXUS//SIGNALS — SUPERVISOR-CRON v1.0.0 (:3015) · Task 34-c ─────────────────
// Operator order (2026-09-26): «ساخت کرون جاب حرفه‌ای با پورت مستقل خارج از محیط
// داخلی سندباکس + اسکیل سوپروایزر مهندس ارشد برای بررسی و پیگیری و نظارت بر
// سیستم، هدف رسیدن به وین ریت بالاتر و افزایش EST PNL % روزانه»
//
// HISTORY: an older supervisor-cron lived on :3015 and was lost in rollback #4
// (platform snapshot restore) — see worklog Task 33 «3015 DOWN — بازسازی در 34-c».
// This is the engineered rebuild: independent port, self-persisting state,
// drift-resistant scheduling, honest telemetry only.
//
// SCOPE CONTRACT (do NOT duplicate the Next.js side):
//   · src/lib/daily-scheduler.ts already owns Tehran-day DAILY + SRE reports.
//   · THIS service owns: 10-min health sweep (+RED Telegram alerts),
//     6-hour progress report, 12-hour senior-supervisor LLM review,
//     3-hour sandbox snapshot ring (scripts/backup.sh — re-owned in v1.2.0
//     after the Task-34 rebuild lost the platform-cron backup job; ring was
//     found stale 2026-09-26: newest 15:10, the 18:10 slot never fired).
//
// JOB SCHEDULE (drift-resistant: nextRunAt advances from the SCHEDULED time,
// never from completion time; single-flight per job — a slow run never stacks):
//   sweep    · every 10 min  · probe app:3000 /api/healthz (fallback /api/pulse),
//                              liq:3010, trade:3011, armor:3016, watchdog:3020,
//                              sentinel:3030 /health + /report verdict
//                              → GREEN/AMBER/RED by own rules:
//                                any service down = AMBER · app down or
//                                sentinel verdict RED = RED
//                              → RED ⇒ Telegram alert (bridge :3005 /send),
//                                rate-limit 1 alert / 30 min per anomaly class
//   keepwarm · every 5 min   · v1.5.0 Task-56 internal heartbeat: /api/healthz
//                              (+ pulse fallback) → persisted OK/COLD ledger
//                              (bootAt · gitSha · coldStreak) on /health;
//                              NEVER restarts/heals (Job-411262 doctrine) —
//                              the external tier (operator platform cron)
//                              remains the only anti-recycle layer
//   progress · every 6 h     · Persian terminal-style progress report via bridge
//   backup   · every 3 h     · snapshot ring: zip + wal_checkpoint + AES-256 .enc
//                              + Telegram off-site tiers (scripts/backup.sh)
//   review   · every 12 h    · sentinel-deep.sh --quick (10min cap, 6000 chars)
//                              + compact telemetry JSON → LLM (senior supervisor,
//                              nexus-sentinel doctrine) → structured JSON review
//                              persisted + condensed Telegram push
//
// SAFETY: no secrets ever logged/echoed (NEXUS_CONTROL_KEY fail-closed,
// constant-time). Jobs are try/catch-wrapped — a throwing job logs and
// continues; the cron must never crash. State survives restarts via
// .data/supervisor-cron/state.json (atomic tmp+rename). bun --hot timer reaping
// via globalThis (same lesson as p0-watchdog).
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import ZAI from "z-ai-web-dev-sdk";

const VER = "supervisor-cron 1.6.0"; // v1.6.0 trace-1a15f7d945d27ead: toobit exec-bridge :3021 joins the senior sweep — health probe + /doctrine violation feed (AMBER paper / crit live)
const ROOT = "/home/z/my-project";
const DIR = `${ROOT}/.data/supervisor-cron`;
const STATE = `${DIR}/state.json`;
const REVIEW = `${DIR}/latest-review.json`;
const LOG = `${ROOT}/logs/supervisor-cron.log`;

const PORT = 3015;
const SWEEP_MS = 10 * 60_000;
const PROGRESS_MS = 6 * 60 * 60_000;
const REVIEW_MS = 12 * 60 * 60_000;
const WATCH_MS = 10 * 60_000;
const WATCH_MAX_RUNS = 3; // 30-minute one-shot mission (3 × 10-min ticks)
const BACKUP_MS = 3 * 60 * 60_000;      // v1.2.0: snapshot ring cadence (was platform-cron)
const BACKUP_FIRST_MS = 3 * 60_000;     // first owned snapshot shortly after boot (re-anchor stale ring)
const BACKUP_TIMEOUT_MS = 12 * 60_000;  // hard cap (zip+encrypt+upload historically ≈2-4min)
const BOOT_DELAY_MS = 12_000; // first sweep shortly after boot (watchdog grace)
const FETCH_TIMEOUT_MS = 6_000;
const DEEP_TIMEOUT_MS = 10 * 60_000;
const DEEP_TRUNCATE = 6_000;
const LLM_TIMEOUT_MS = 180_000;
const ALERT_GAP_MS = 30 * 60_000; // per anomaly class
const DATA_STALE_MIN = 15;        // RECOVERY-0929: SignalEvent age cap (operator's 15-min freshness review order)
const WS_CRIT_STREAK = 2;         // ws down for N consecutive sweeps (20 min) ⇒ crit (else warn)
const HISTORY_MAX = 50;
const DIGEST_MS = 2 * 60 * 60_000; // TASK-48 (IRAN-VPS-0929): Persian signal digest every 2h — the operator's phone IS the terminal (VPS unaffordable)
const DIGEST_MAX_NEW = 6;         // max new-signal lines per digest (compact)
const KEEPWARM_MS = 5 * 60_000;   // TASK-56: internal heartbeat every 5 min (Job-411262 cadence) — healthz lineage evidence + cold-streak accounting

// Task 56 JOB ROSTER: keepwarm is the 7th job.
type JobId = "sweep" | "progress" | "review" | "watch" | "backup" | "digest" | "keepwarm";

// ── env (lazy, mtime-cached — same stale-env lesson as bridge v1.2.1) ────────
const ENV_PATH = `${ROOT}/.env`;
let dotenvCache: { mtimeMs: number; values: Map<string, string> } | null = null;
function envGet(key: string): string {
  // Task 36: .env FILE first (live source of truth, mtime-cached) — the boot
  // process.env is frozen and inherited stale by heal-spawn chains (proven:
  // old key kept validating after rotation). process.env is fallback only.
  try {
    const st = statSafe(ENV_PATH);
    if (st && (!dotenvCache || dotenvCache.mtimeMs !== st.mtimeMs)) {
      const values = new Map<string, string>();
      for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && m[1] && m[2]) values.set(m[1], m[2].trim().replace(/^["']|["']$/g, ""));
      }
      dotenvCache = { mtimeMs: st.mtimeMs, values };
    }
  } catch { dotenvCache = null; }
  const fromFile = dotenvCache?.values.get(key);
  if (fromFile && fromFile.length > 0) return fromFile;
  const fromProc = process.env[key];
  return fromProc && fromProc.length > 0 ? fromProc : "";
}
function statSafe(p: string) { try { return statSync(p); } catch { return null; } }

function controlOk(req: Request): boolean {
  const KEY = envGet("NEXUS_CONTROL_KEY");
  if (!KEY) return false; // fail-closed
  const provided = req.headers.get("x-nexus-key") ?? "";
  if (provided.length !== KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ KEY.charCodeAt(i);
  return diff === 0; // constant-time — value never echoed/logged
}

// ── logging (console → stdout → nohup redirect; JSONL appendFile) ────────────
const tehran = (d: number | Date = Date.now()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);
function log(lvl: "info" | "warn" | "crit", ev: string, det: Record<string, unknown> = {}) {
  const line = `[${tehran()}] ${lvl.toUpperCase()} cron ${ev} ${JSON.stringify(det)}`;
  if (lvl !== "info") console.log(line);
  else console.log(`[${tehran()}] INFO cron ${ev} ${JSON.stringify(det)}`);
  try { appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), tehran: tehran(), lvl, ev, ...det }) + "\n"); } catch { /* never crash on logs */ }
}

// ── state (persisted, atomic) ────────────────────────────────────────────────
interface JobState {
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null; // ok | error | skipped-running
  lastDurationMs: number | null;
  lastError: string | null;
  runs: number;
  failures: number;
}
interface HistoryEntry { id: JobId; at: number; status: string; durationMs: number; detail: string }
const BOOT = Date.now();
const state = {
  ver: VER,
  pid: process.pid,
  startedAt: new Date(BOOT).toISOString(),
  updatedAt: new Date(BOOT).toISOString(),
  jobs: {
    sweep: freshJob(BOOT + BOOT_DELAY_MS),
    progress: freshJob(BOOT + BOOT_DELAY_MS + PROGRESS_MS),
    review: freshJob(BOOT + BOOT_DELAY_MS + REVIEW_MS),
    watch: freshJob(BOOT + BOOT_DELAY_MS + WATCH_MS),
    backup: freshJob(BOOT + BOOT_DELAY_MS + BACKUP_FIRST_MS),
    digest: freshJob(BOOT + BOOT_DELAY_MS + 2 * 60_000), // first digest 2min after boot — post-recycle recovery proof lands on the operator's phone fast
    keepwarm: freshJob(BOOT + 60_000), // Task 56: first heartbeat 60s after boot — instant lineage evidence on every generation
  } as Record<JobId, JobState>,
  lastSweep: null as null | { at: string; verdict: string; reason: string; services: Record<string, { up: boolean; status: number | null; ms: number }>; anomalies: Array<{ class: string; sev: string; msg: string }>; data?: { lastEventAgeMin: number | null }; streaks?: { wsDown: number; stale: number } },
  lastReview: null as null | { at: string; status: string; verdict: string | null },
  lastProgress: null as null | { at: string; ok: boolean },
  lastDigest: null as null | { at: string; ok: boolean; newN: number },
  // Task 56 keepwarm: persisted heartbeat evidence (Job-411262 semantics)
  lastKeepwarm: null as null | { at: string; ok: boolean; ms: number | null; bootAt: string | null; gitSha: string | null; coldStreak: number },
  coldStreak: 0,
  alertLedger: {} as Record<string, number>,
  wsDownStreak: 0,
  staleStreak: 0,
  history: [] as HistoryEntry[],
  watchRuns: [] as Array<Record<string, unknown>>,
  lastWatch: null as null | { at: string; run: number; done: boolean; summary: string },
};
function freshJob(nextRunAt: number): JobState {
  return { lastRunAt: null, nextRunAt, lastStatus: null, lastDurationMs: null, lastError: null, runs: 0, failures: 0 };
}
function persistState() {
  state.updatedAt = new Date().toISOString();
  try {
    writeFileSync(`${STATE}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${STATE}.tmp`, STATE);
  } catch (e) { log("warn", "state-write-failed", { err: String(e).slice(0, 120) }); }
}
function loadState() {
  try {
    if (!existsSync(STATE)) return;
    const prev = JSON.parse(readFileSync(STATE, "utf8")) as typeof state;
    // keep persisted schedule when fresh enough; else reschedule from boot
    for (const id of ["sweep", "progress", "review", "watch", "backup", "keepwarm"] as JobId[]) {
      const p = prev.jobs?.[id];
      if (p) {
        state.jobs[id] = { ...freshJob(state.jobs[id].nextRunAt ?? 0), ...p };
        if (!state.jobs[id].nextRunAt || state.jobs[id].nextRunAt! < BOOT - 24 * 3600_000) {
          state.jobs[id].nextRunAt = BOOT + 30_000; // stale >24h → catch-up run soon after boot
        }
      }
    }
    if (Array.isArray(prev.history)) state.history = prev.history.slice(-HISTORY_MAX);
    if (Array.isArray((prev as unknown as { watchRuns?: unknown[] }).watchRuns)) state.watchRuns = (prev as unknown as { watchRuns: Array<Record<string, unknown>> }).watchRuns.slice(0, 12);
    const prevWatch = (prev as unknown as { lastWatch?: typeof state.lastWatch }).lastWatch;
    if (prevWatch) state.lastWatch = prevWatch;
    if (prev.alertLedger) state.alertLedger = prev.alertLedger;
    const prevStreaks = prev as unknown as { wsDownStreak?: number; staleStreak?: number };
    if (typeof prevStreaks.wsDownStreak === "number") state.wsDownStreak = prevStreaks.wsDownStreak;
    if (typeof prevStreaks.staleStreak === "number") state.staleStreak = prevStreaks.staleStreak;
    if (prev.lastSweep) state.lastSweep = prev.lastSweep;
    if (prev.lastReview) state.lastReview = prev.lastReview;
    if (prev.lastProgress) state.lastProgress = prev.lastProgress;
    if (prev.lastDigest) state.lastDigest = prev.lastDigest;
    const prevKw = (prev as unknown as { lastKeepwarm?: typeof state.lastKeepwarm }).lastKeepwarm;
    if (prevKw) state.lastKeepwarm = prevKw;
    const prevCold = (prev as unknown as { coldStreak?: number }).coldStreak;
    if (typeof prevCold === "number") state.coldStreak = prevCold;
    log("info", "state-restored", { jobs: Object.keys(prev.jobs ?? {}).length, history: state.history.length });
  } catch (e) { log("warn", "state-restore-failed", { err: String(e).slice(0, 120) }); }
}
function pushHistory(h: HistoryEntry) {
  state.history.push(h);
  if (state.history.length > HISTORY_MAX) state.history.splice(0, state.history.length - HISTORY_MAX);
}

// ── fetch helpers (honest nulls — never invent) ──────────────────────────────
async function fetchJson(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ ok: boolean; status: number | null; data: unknown; err?: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "supervisor-cron/1.0" } });
    const data = (await r.json().catch(() => null)) as unknown;
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: null, data: null, err: String(e).slice(0, 120) };
  }
}
function readJsonFile(p: string): unknown | null {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// ── telegram bridge (POST :3005/send with x-nexus-key; fail-silent) ─────────
async function bridgeSend(text: string): Promise<{ ok: boolean; status?: number; err?: string }> {
  const KEY = envGet("NEXUS_CONTROL_KEY");
  if (!KEY) return { ok: false, err: "no-control-key" };
  try {
    const r = await fetch("http://127.0.0.1:3005/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-nexus-key": KEY },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 120) };
  }
}
function alertAllowed(cls: string): boolean {
  const last = state.alertLedger[cls] ?? 0;
  return Date.now() - last >= ALERT_GAP_MS;
}
function alertSent(cls: string) { state.alertLedger[cls] = Date.now(); }

// ═════════════════════════════════ JOB: sweep ════════════════════════════════
interface SweepProbe { key: string; label: string; up: boolean; status: number | null; ms: number; note?: string }
async function probe(label: string, url: string, expect: (s: number) => boolean): Promise<SweepProbe> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "supervisor-cron/1.0" } });
    return { key: label.split(" ")[0], label, up: expect(r.status), status: r.status, ms: Date.now() - t0 };
  } catch {
    return { key: label.split(" ")[0], label, up: false, status: null, ms: Date.now() - t0 };
  }
}

// ── RECOVERY-0929: data-freshness probe (the 20-hour silent stall guard) ─────
// History: on 2026-09-27 ~16:36Z the pipeline died (price-ws crash + undeclared
// socket.io dependency made every heal futile) while every service probe stayed
// green — the ledger froze ~20h until the next recycle. Probe the LEDGER itself
// (readonly, one aggregate query per sweep — Prisma owns all writes).
function eventFreshness(): { ageMin: number | null; lastAt: string | null; err?: string } {
  try {
    const db = new Database(`${ROOT}/db/custom.db`, { readonly: true });
    db.exec("PRAGMA busy_timeout=2500");
    const row = db.query("SELECT MAX(createdAt) mx, COUNT(*) n FROM SignalEvent").get() as { mx: number | string | null; n: number } | null;
    db.close();
    const mx = row?.mx != null ? Number(row.mx) : null;
    if (!mx || !Number.isFinite(mx)) return { ageMin: null, lastAt: null, err: "no-rows" };
    return { ageMin: Math.round((Date.now() - mx) / 60_000), lastAt: new Date(mx).toISOString() };
  } catch (e) {
    return { ageMin: null, lastAt: null, err: String(e).slice(0, 100) };
  }
}

async function jobSweep(): Promise<{ verdict: string; reason: string; anomalies: Array<{ class: string; sev: string; msg: string }> }> {
  const probes: SweepProbe[] = [];
  // app :3000 — /api/healthz first (exists, verified 34-c); /api/pulse as
  // secondary confirmation before declaring the app down (compile hiccups happen)
  const appHz = await probe("app :3000", "http://127.0.0.1:3000/api/healthz", (s) => s === 200);
  if (appHz.up) probes.push(appHz);
  else {
    const appPulse = await probe("app :3000", "http://127.0.0.1:3000/api/pulse", (s) => s === 200);
    appPulse.note = `healthz=${appHz.status ?? "err"} → pulse fallback`;
    probes.push(appPulse);
  }
  probes.push(await probe("liq :3010", "http://127.0.0.1:3010/health", (s) => s === 200));
  probes.push(await probe("trade :3011", "http://127.0.0.1:3011/health", (s) => s === 200));
  probes.push(await probe("armor :3016", "http://127.0.0.1:3016/health", (s) => s === 200));
  probes.push(await probe("watchdog :3020", "http://127.0.0.1:3020/health", (s) => s === 200));
  probes.push(await probe("sentinel :3030", "http://127.0.0.1:3030/health", (s) => s === 200));
  // RECOVERY-0929: ws/bridge were invisible to the sweep — the 2026-09-27 stall
  // (ws down, feed frozen ~20h) never raised an alert because :3003 was never probed.
  probes.push(await probe("ws :3003", "http://127.0.0.1:3003/", (s) => s === 400 || s === 200)); // socket.io answers 400 on plain GET = ALIVE
  probes.push(await probe("bridge :3005", "http://127.0.0.1:3005/health", (s) => s === 200));
  // v1.3.0 DOCTRINE SUPERVISOR (trace 1a15f7d945d27ead): toobit exec-bridge :3021
  // joins the senior sweep — health probe + /doctrine violation feed below.
  const tbtProbe = await probe("tbt :3021", "http://127.0.0.1:3021/health", (s) => s === 200);
  probes.push(tbtProbe);

  // sentinel verdict field
  let verdict = "UNKNOWN";
  const rep = await fetchJson("http://127.0.0.1:3030/report", 8_000);
  if (rep.ok && rep.data && typeof rep.data === "object" && "verdict" in (rep.data as Record<string, unknown>)) {
    verdict = String((rep.data as Record<string, unknown>).verdict ?? "UNKNOWN");
  }

  const anomalies: Array<{ class: string; sev: string; msg: string }> = [];
  const app = probes.find((p) => p.key === "app")!;
  for (const p of probes) {
    if (!p.up) {
      const isApp = p.key === "app";
      anomalies.push({
        class: isApp ? "app-down" : `svc-down:${p.key}`,
        sev: isApp ? "crit" : "warn",
        msg: `${p.label} DOWN (HTTP ${p.status ?? "unreachable"})${p.note ? ` · ${p.note}` : ""}`,
      });
    }
  }
  if (verdict === "RED") anomalies.push({ class: "sentinel-red", sev: "crit", msg: `sentinel :3030 verdict RED` });
  else if (verdict === "AMBER") anomalies.push({ class: "sentinel-amber", sev: "warn", msg: `sentinel :3030 verdict AMBER` });

  // ── v1.3.0: TOOBIT EXEC-BRIDGE doctrine feed (پیگیری و دکترین) ─────────
  // Only consulted when the bridge is up (svc-down already covers the other
  // case). Violations are AMBER in PAPER, crit in LIVE (real money at risk).
  if (tbtProbe.up) {
    const tbtDoc = await fetchJson("http://127.0.0.1:3021/doctrine", 6_000);
    if (!tbtDoc.ok || !tbtDoc.data || typeof tbtDoc.data !== "object") {
      anomalies.push({ class: "tbt-doctrine-unreachable", sev: "warn", msg: "toobit-bridge :3021 /doctrine unreachable while health is up — doctrine supervisor degraded" });
      log("warn", "tbt-doctrine-unreachable", { err: tbtDoc.err });
    } else {
      const dd = tbtDoc.data as { mode?: string; doctrine?: { violationsN?: number; lastViolation?: { kind?: string; detail?: string } | null; skipBy?: Record<string, number> } | null };
      const vn = Number(dd.doctrine?.violationsN ?? 0);
      if (vn > 0) {
        const last = dd.doctrine?.lastViolation;
        anomalies.push({
          class: "tbt-doctrine-violation",
          sev: dd.mode === "LIVE" ? "crit" : "warn",
          msg: `toobit-bridge doctrine: ${vn} violation(s) — last=${last?.kind ?? "?"}: ${String(last?.detail ?? "").slice(0, 140)}`,
        });
        log("warn", "tbt-doctrine-violations", { n: vn, last: last?.kind });
      }
    }
  }

  // ── RECOVERY-0929: data freshness + streak escalation + heal nudge ─────────
  const wsProbe = probes.find((p) => p.key === "ws");
  const fresh = eventFreshness();
  state.wsDownStreak = wsProbe && !wsProbe.up ? state.wsDownStreak + 1 : 0;
  const stale = fresh.ageMin == null || fresh.ageMin > DATA_STALE_MIN;
  state.staleStreak = stale ? state.staleStreak + 1 : 0;
  if (stale) {
    anomalies.push({
      class: "data-stale",
      sev: "crit", // the ledger itself is frozen — always RED-worthy
      msg: `data-stale: newest SignalEvent ${fresh.ageMin == null ? "UNREADABLE" : `${fresh.ageMin}min`} old (cap ${DATA_STALE_MIN}min)${fresh.err ? ` · ${fresh.err}` : ""}${fresh.lastAt ? ` · last=${fresh.lastAt}` : ""}`,
    });
  }
  if (wsProbe && !wsProbe.up) {
    anomalies.push({
      class: "ws-down",
      sev: state.wsDownStreak >= WS_CRIT_STREAK ? "crit" : "warn",
      msg: `ws :3003 DOWN ×${state.wsDownStreak} sweeps (feed dead ⇒ pipeline starves)`,
    });
  }
  // heal nudge: wake the layer-1 prober immediately (its own cooldown still applies)
  if ((wsProbe && !wsProbe.up) || stale) {
    try {
      await fetch("http://127.0.0.1:3020/probe-now", { method: "POST", signal: AbortSignal.timeout(4_000), headers: { "user-agent": "supervisor-cron/1.3" } });
      log("info", "heal-nudge-sent", { wsDown: !!(wsProbe && !wsProbe.up), stale });
    } catch (e) { log("warn", "heal-nudge-failed", { err: String(e).slice(0, 80) }); }
  }

  // classification rules (own, per 34-c contract)
  let myVerdict = "GREEN";
  let reason = "all services up · sentinel not RED";
  if (anomalies.some((a) => a.class === "app-down")) { myVerdict = "RED"; reason = "app :3000 down"; }
  else if (anomalies.some((a) => a.class === "sentinel-red")) { myVerdict = "RED"; reason = "sentinel verdict RED"; }
  else if (anomalies.some((a) => a.class === "data-stale")) { myVerdict = "RED"; reason = "signal ledger stale — pipeline frozen"; }
  else if (anomalies.length > 0) { myVerdict = "AMBER"; reason = anomalies.map((a) => a.msg).join(" · ").slice(0, 300); }

  state.lastSweep = {
    at: new Date().toISOString(),
    verdict: myVerdict,
    reason,
    services: Object.fromEntries(probes.map((p) => [p.key, { up: p.up, status: p.status, ms: p.ms }])),
    anomalies,
    data: { lastEventAgeMin: fresh.ageMin },
    streaks: { wsDown: state.wsDownStreak, stale: state.staleStreak },
  };

  // RED ⇒ short Telegram alert, rate-limited 1/30min per anomaly class
  if (myVerdict === "RED") {
    for (const a of anomalies) {
      if (a.sev !== "crit") continue; // RED classes only
      if (!alertAllowed(a.class)) { log("info", "alert-rate-limited", { class: a.class }); continue; }
      const txt = `🚨 <b>NEXUS · SUPERVISOR-CRON RED</b>\n<code>${a.msg}</code>\nبررسی کامل: GET :3015/status\n${tehran()} IRST`;
      const r = await bridgeSend(txt);
      if (r.ok) alertSent(a.class);
      log(r.ok ? "warn" : "info", r.ok ? "red-alert-sent" : "red-alert-failed", { class: a.class, http: r.status ?? r.err });
    }
  }
  return { verdict: myVerdict, reason, anomalies };
}

// ═════════════════════════════ JOB: progress ═════════════════════════════════
interface WinWindow { n: number; wins: number; winRatePct: number; pnlUsd: number }
function windowsFromSignals(signals: Array<Record<string, unknown>>): { h24: WinWindow; d7: WinWindow } {
  const now = Date.now();
  const blank = (): WinWindow => ({ n: 0, wins: 0, winRatePct: 0, pnlUsd: 0 });
  const h24 = blank(), d7 = blank();
  for (const s of signals) {
    const closedAt = Date.parse(String(s.closedAt ?? ""));
    if (!Number.isFinite(closedAt)) continue;
    // Task 86 FIX: Signal.status is TP1/TP2/TP3/SL/EXPIRED/CLOSED (never the
    // literal "SETTLED") — the old filter matched nothing, so the 6h report's
    // 24h/7d windows were permanently 0% (n=0) while the book was settling.
    const st = String(s.status ?? "");
    if (!["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"].includes(st)) continue;
    // pnlUsd = pnlPercent × marginUsd / 100 (same accounting as the dashboard ledger);
    // win = pnlPercent > 0 (same as stats.ts wins/losses)
    const pnlPct = Number(s.pnlPercent ?? 0);
    const pnlUsd = (pnlPct * Number(s.marginUsd ?? 0)) / 100;
    const win = pnlPct > 0;
    if (now - closedAt <= 24 * 3600_000) { h24.n++; if (win) h24.wins++; h24.pnlUsd += pnlUsd; }
    if (now - closedAt <= 7 * 24 * 3600_000) { d7.n++; if (win) d7.wins++; d7.pnlUsd += pnlUsd; }
  }
  const wr = (w: WinWindow) => (w.n > 0 ? Math.round((w.wins / w.n) * 1000) / 10 : 0);
  h24.winRatePct = wr(h24); d7.winRatePct = wr(d7);
  return { h24, d7 };
}

async function jobProgress(): Promise<{ ok: boolean; detail: string }> {
  const lines: string[] = [];
  const pulse = await fetchJson("http://127.0.0.1:3000/api/pulse", 15_000);
  const rawcal = await fetchJson("http://127.0.0.1:3000/api/rawcal", 8_000);
  const futures = await fetchJson("http://127.0.0.1:3000/api/futures", 8_000);
  const trade = await fetchJson("http://127.0.0.1:3011/health", 6_000);
  const shadow = readJsonFile(`${ROOT}/.data/shadow-veto-latest.json`) as Record<string, unknown> | null;
  const hb = (() => { try { return parseInt(readFileSync(`${ROOT}/.data/rawcal-run-heartbeat.txt`, "utf8").trim(), 10); } catch { return 0; } })();
  const hbAgeH = hb ? Math.round(((Date.now() / 1000) - hb) / 360) / 10 : null;

  lines.push(`⏱ <b>NEXUS · گزارش ۶ ساعته سوپروایزر</b>`);
  lines.push(`<code>${tehran()} IRST</code>`);

  // win rate / pnl
  if (pulse.ok && pulse.data && typeof pulse.data === "object") {
    const d = pulse.data as Record<string, unknown>;
    const stats = (d.stats ?? {}) as Record<string, unknown>;
    const signals = Array.isArray(d.signals) ? d.signals as Array<Record<string, unknown>> : [];
    const w = windowsFromSignals(signals);
    const acc = (stats.account ?? {}) as Record<string, unknown>;
    const balance = Number(acc.balance ?? 0);
    const pnl24 = Number(stats.pnl24hUsd ?? 0);
    const estPct24 = balance > 0 ? Math.round((pnl24 / balance) * 1000) / 10 : null;
    lines.push(`▸ <b>وین‌ریت</b> — کل: <code>${Number(stats.winRate ?? 0)}%</code> (n=${Number(stats.totalSignals ?? 0)})`);
    lines.push(`  · ۲۴س: <code>${w.h24.winRatePct}%</code> (n=${w.h24.n}) · ۷روز: <code>${w.d7.winRatePct}%</code> (n=${w.d7.n})`);
    lines.push(`  · PNL ۲۴س: <code>${pnl24 >= 0 ? "+" : ""}${pnl24.toFixed(2)}$</code> · EST PNL%≈ <code>${estPct24 ?? "?"}%</code> (بر پایه بالانس ${balance.toFixed(2)}$)`);
    lines.push(`  · اکوییتی کل: <code>${Number(stats.totalPnlUsd ?? 0).toFixed(2)}$</code> · بالانس: <code>${balance.toFixed(2)}$</code> · فی‌ها: <code>${Number(acc.feesPaid ?? 0).toFixed(2)}$</code>`);
  } else { lines.push(`▸ pulse در دسترس نبود — بخش وین‌ریت گزارش نمی‌شود (صادق‌ماندن بهتر از ساختن است)`); }

  // RAW-CAL
  if (rawcal.ok && rawcal.data && typeof rawcal.data === "object") {
    const rc = rawcal.data as Record<string, unknown>;
    const pace = (rc.pace ?? {}) as Record<string, unknown>;
    const armed = Boolean(rc.armed);
    lines.push(`▸ <b>RAW-CAL</b> — armed: <code>${armed ? "YES" : "NO"}</code> · settledE2: <code>${Number(pace.settledE2 ?? rc.settledN ?? 0)}</code>/target <code>${Number(rc.target ?? 0)}</code> · needed: <code>${Number(pace.needed ?? 0)}</code>`);
    if (!armed) lines.push(`  · disarmReason: <code>${String(rc.disarmReason ?? "?").slice(0, 90)}</code>`);
    lines.push(`  · settleRate3h: <code>${Number(pace.settleRate3hPerH ?? 0).toFixed(2)}/h</code> · openRaw: <code>${Number(pace.openRaw ?? rc.openRaw ?? 0)}</code> · heartbeat: <code>${hbAgeH !== null ? hbAgeH + "h" : "نامشخص"}</code>`);
  } else lines.push(`▸ RAW-CAL خوانده نشد`);

  // shadow-veto arms
  if (shadow && typeof shadow === "object") {
    const stats = (shadow.stats ?? {}) as Record<string, unknown>;
    const arms = Array.isArray(shadow.arms) ? shadow.arms as Array<Record<string, unknown>> : [];
    lines.push(`▸ <b>SHADOW-VETO</b> — passSide: <code>${Number(stats.passSide ?? 0)}</code>/${Number(stats.total ?? 0)} · veto: <code>${Number(stats.vetoCount ?? 0)}</code> · recent24h n=<code>${Number((stats.recent24h as Record<string, unknown> | undefined)?.n ?? 0)}</code>`);
    for (const a of arms.slice(0, 6)) {
      lines.push(`  · ${String(a.id)}: <code>${Number(a.n ?? 0)}/${Number(a.target ?? 0)}</code> (${Number(a.fillPct ?? 0).toFixed(0)}%) WR <code>${Number(a.winRatePct ?? 0).toFixed(0)}%</code>${a.starved ? " ⚠STARVED" : ""}`);
    }
  } else lines.push(`▸ shadow-veto-latest.json خوانده نشد`);

  // futures taxonomy + fapi ban evidence (indirect — honest labeling)
  if (futures.ok && futures.data && typeof futures.data === "object") {
    const f = futures.data as Record<string, unknown>;
    const edge = (f.edge ?? {}) as Record<string, unknown>;
    const mat = (edge.maturity ?? {}) as Record<string, unknown>;
    const counts = (f.counts ?? {}) as Record<string, unknown>;
    const bf = (edge.bestFilter ?? {}) as Record<string, unknown>;
    lines.push(`▸ <b>FUTURES TAXONOMY</b> — store: <code>${Number(mat.settled ?? 0)}/${Number(mat.target ?? 0)}</code> (${Number(mat.progressPct ?? 0).toFixed(1)}%) · ردیف ۲۴س: <code>${Number(counts.last24h ?? 0)}</code> (سالم ≈576/۲۴س)`);
    if (bf.filter) lines.push(`  · bestFilter: <code>${String(bf.filter).slice(0, 60)}</code> (n=${Number(bf.n ?? 0)}, ${String(bf.confidence ?? "?")})`);
    const restErr = Number((trade.data as Record<string, unknown> | undefined)?.restErrors ?? NaN);
    const fuelNote = Number.isFinite(restErr) ? ` · trade restErrors=${restErr}` : "";
    lines.push(`  · fapi بن/گرسنگی (شواهد غیرمستقیم): ردیف۲۴س + restErrors${fuelNote}`);
  } else lines.push(`▸ futures taxonomy خوانده نشد`);

  // services summary (from own last sweep)
  if (state.lastSweep) {
    const svc = Object.entries(state.lastSweep.services).map(([k, v]) => `${k}:${v.up ? "UP" : "DOWN"}`).join(" · ");
    lines.push(`▸ <b>سرویس‌ها</b> — <code>${svc}</code> · sweep verdict: <code>${state.lastSweep.verdict}</code>`);
  }

  const txt = lines.join("\n");
  const r = await bridgeSend(txt);
  state.lastProgress = { at: new Date().toISOString(), ok: r.ok };
  log(r.ok ? "info" : "warn", r.ok ? "progress-sent" : "progress-send-failed", { lines: lines.length, http: r.status ?? r.err });
  return { ok: r.ok, detail: r.ok ? `sent ${lines.length} lines` : `bridge ${r.status ?? r.err}` };
}

// ═════════════════════════════ JOB: review ═══════════════════════════════════
const SENIOR_SUPERVISOR_PROMPT = `تو «مهندس ارشد سوپروایزر» سیستم NEXUS//SIGNALS هستی — یک ترمینال سیگنال کریپتویی (Next.js 16 + Prisma/SQLite + ۵ میکروسرویس bun + پل تلگرام) در سندباکس ۴GB بدون سواپ.

حکم کاری (skill nexus-sentinel):
- WATCH: تلمتری سلامت را صادقانه بخوان. HUNT: ریسک باگ و رگرسیون را در همان تلمتری ببین. GROW: مأموریت تو بالا بردن WIN RATE و EST PNL% روزانه است — بدون شکستن قرارداد صداقت.
- قرارداد صداقت (غیرقابل‌مذاکره): هرگز edge از خودت نساز؛ اجرای زنده DISABLED است و باید بماند؛ گیت‌های شواهد را رعایت کن (ارتقای استراتژی نیازمند ≥300 معامله OOS + بوت‌استراپ CI-LB>0 است؛ verdict فعلی پروتکل اعتبارسنجی = FAIL/n کم است و این باید صادقانه در تحلیل بماند)؛ تو فقط OBSERVER با دسترسی خواندنی هستی — هیچ اقدام تغییردهنده‌ای پیشنهاد نکن که داده‌های تسویه/داوری را دستکاری کند؛ باز-برازش روی دفتر سانسورشده ممنوع.
- خروجی باید «فقط JSON» باشد، بدون هیچ متن اضافه، به زبان فارسی، با این شکل:
{"verdict":"GREEN|AMBER|RED",
 "summary":"یک جمله",
 "findings":[{"sev":"P0|P1|P2","area":"...","evidence":"فقط از داده‌ی داده‌شده، با عدد/فیلد مشخص","impact":"اثر بر وین‌ریت یا PNL یا پایداری"}],
 "top_actions":[{"action":"...","expected_effect_on_winrate_or_pnl":"...","effort":"S|M|L","risk":"..."}]}
- دقیقاً ۳ مورد در top_actions؛ هر یافته باید به یک فیلد واقعی از تلمتری ارجاع دهد (اگر داده کافی نیست، بنویس «شواهد ناکافی» — ساختن ممنوع).`;

function truncate(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n) + `\n…[truncated ${s.length - n} chars]`; }

function compactRawcal(data: unknown): Record<string, unknown> {
  const rc = (data ?? {}) as Record<string, unknown>;
  const pace = (rc.pace ?? {}) as Record<string, unknown>;
  const quality = (rc.quality ?? {}) as Record<string, unknown>;
  return {
    armed: rc.armed, target: rc.target, settledN: rc.settledN, openRaw: rc.openRaw, rawWinRatePct: rc.rawWinRatePct,
    disarmReason: String(rc.disarmReason ?? "").slice(0, 120),
    paceSettledE2: pace.settledE2, paceSettleRate3h: pace.settleRate3hPerH, paceNeeded: pace.needed,
    qualityInformativePct: quality.informativePct, qualityHealthyPct: quality.healthyPct, qualityGate: quality.gate,
  };
}

async function runDeepScript(): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (v: string) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const proc = Bun.spawn(["bash", "/home/z/my-project/skills/nexus-sentinel/scripts/sentinel-deep.sh", "--quick"], {
        cwd: ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const timer = setTimeout(() => { try { proc.kill(9); } catch { /* */ } done(truncate(out || "(timeout, no output)", DEEP_TRUNCATE)); }, DEEP_TIMEOUT_MS);
      void (async () => {
        try {
          const text = await new Response(proc.stdout as ReadableStream).text();
          const err = await new Response(proc.stderr as ReadableStream).text();
          out = text + (err ? `\n[stderr]\n${err}` : "");
          await proc.exited;
          done(truncate(out || "(empty output)", DEEP_TRUNCATE));
        } catch (e) { done(truncate(out || `reader-error: ${String(e).slice(0, 100)}`, DEEP_TRUNCATE)); }
        finally { clearTimeout(timer); }
      })();
    } catch (e) { done(`spawn-error: ${String(e).slice(0, 150)}`); }
  });
}

async function callLlmReview(telemetryJson: string): Promise<{ status: "ok" | "llm_unavailable" | "llm_bad_output"; review: unknown; raw: string; err?: string }> {
  // v1.0 resilience: the platform LLM 429s under load (verified 34-c — even a
  // minimal pong failed). One retry after 90s: worst case ≈180+90+180s, well
  // inside the 12h cadence; the honest llm_unavailable path stays the last resort.
  let attempt = 0;
  let last: Awaited<ReturnType<typeof llmOnce>> | null = null;
  while (attempt < 2) {
    attempt += 1;
    last = await llmOnce(telemetryJson);
    if (last.status !== "llm_unavailable") return last;
    if (last.err?.includes("429") && attempt < 2) {
      log("warn", "llm-429-retry", { inS: 90 });
      await new Promise((r) => setTimeout(r, 90_000));
    } else break;
  }
  return last ?? { status: "llm_unavailable", review: null, raw: "", err: "unreachable" };
}

async function llmOnce(telemetryJson: string): Promise<{ status: "ok" | "llm_unavailable" | "llm_bad_output"; review: unknown; raw: string; err?: string }> {
  try {
    // SELFHOST-0929: open-source decoupling — LLM_PROVIDER=openai routes the
    // senior-supervisor review through any OpenAI-compatible backend (Ollama,
    // vLLM, OpenRouter, ...); default keeps the sandbox platform SDK.
    const zai = await (async () => {
      if ((process.env.LLM_PROVIDER ?? "") === "openai") {
        const baseUrl = (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "");
        if (!baseUrl) throw new Error("LLM_PROVIDER=openai requires LLM_BASE_URL");
        const apiKey = process.env.LLM_API_KEY ?? "";
        const model = process.env.LLM_MODEL ?? "llama3.1";
        return {
          chat: { completions: { async create(opts: { messages: Array<{ role: string; content: string }>; thinking?: { type: string } }) {
            const body: Record<string, unknown> = { model, messages: opts.messages };
            if (opts.thinking?.type === "enabled") body.reasoning_effort = "medium";
            const res = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(LLM_TIMEOUT_MS + 30_000),
            });
            if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
          } } },
        };
      }
      return ZAI.create();
    })();
    const completion = (await Promise.race([
      zai.chat.completions.create({
        messages: [
          { role: "system", content: SENIOR_SUPERVISOR_PROMPT },
          { role: "user", content: `تلمتری زنده‌ی سیستم (فقط از این داده استنتاج کن):\n${telemetryJson}` },
        ],
        thinking: { type: "enabled" },
      }),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`llm timeout after ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS);
        t.unref?.();
      }),
    ])) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = completion.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) return { status: "llm_unavailable", review: null, raw, err: "empty completion" };
    // robust JSON extraction (strip code fences / prose)
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { status: "llm_bad_output", review: null, raw, err: "no JSON object in output" };
    try {
      const parsed = JSON.parse(m[0]) as unknown;
      if (!parsed || typeof parsed !== "object" || !("verdict" in (parsed as Record<string, unknown>))) {
        return { status: "llm_bad_output", review: null, raw, err: "JSON lacks verdict" };
      }
      return { status: "ok", review: parsed, raw };
    } catch (e) {
      return { status: "llm_bad_output", review: null, raw, err: `json parse: ${String(e).slice(0, 100)}` };
    }
  } catch (e) {
    return { status: "llm_unavailable", review: null, raw: "", err: String(e).slice(0, 200) };
  }
}

async function jobReview(): Promise<{ status: string }> {
  // (a) deterministic deep sweep
  const deep = await runDeepScript();
  log("info", "deep-script-done", { chars: deep.length });

  // (b) compact telemetry assembly — every field honestly sourced
  const [pulse, rawcal, futures, trade, oos] = await Promise.all([
    fetchJson("http://127.0.0.1:3000/api/pulse", 15_000),
    fetchJson("http://127.0.0.1:3000/api/rawcal", 8_000),
    fetchJson("http://127.0.0.1:3000/api/futures", 8_000),
    fetchJson("http://127.0.0.1:3011/health", 6_000),
    fetchJson("http://127.0.0.1:3000/api/oos-tracker", 8_000), // v11.6 EQ-97 — live OOS progress replaces the static FAIL line
  ]);
  const sent = await fetchJson("http://127.0.0.1:3030/report", 8_000);
  const shadow = readJsonFile(`${ROOT}/.data/shadow-veto-latest.json`) as Record<string, unknown> | null;
  const arms = Array.isArray((shadow as Record<string, unknown> | null)?.arms) ? ((shadow as Record<string, unknown>).arms as Array<Record<string, unknown>>).map((a) => ({ id: a.id, n: a.n, target: a.target, fillPct: a.fillPct, winRatePct: a.winRatePct, starved: a.starved })) : [];

  let pulseStats: Record<string, unknown> = {};
  if (pulse.ok && pulse.data && typeof pulse.data === "object") {
    const s = (pulse.data as Record<string, unknown>).stats as Record<string, unknown> | undefined;
    const sig = Array.isArray((pulse.data as Record<string, unknown>).signals) ? (pulse.data as Record<string, unknown>).signals as Array<Record<string, unknown>> : [];
    const w = windowsFromSignals(sig);
    pulseStats = {
      winRate: s?.winRate, totalSignals: s?.totalSignals, wins: s?.wins, losses: s?.losses,
      pnl24hUsd: s?.pnl24hUsd, totalPnlUsd: s?.totalPnlUsd, avgPnlPercent: s?.avgPnlPercent, streak: s?.streak,
      account: s?.account,
      window24h: { n: w.h24.n, wins: w.h24.wins, winRatePct: w.h24.winRatePct, pnlUsd: Math.round(w.h24.pnlUsd * 100) / 100 },
      window7d: { n: w.d7.n, wins: w.d7.wins, winRatePct: w.d7.winRatePct, pnlUsd: Math.round(w.d7.pnlUsd * 100) / 100 },
      byStrategy: s?.byStrategy,
      equityCurveTail: Array.isArray(s?.equityCurve) ? (s!.equityCurve as unknown[]).slice(-8) : [],
    };
  }
  const rawcalCompact = rawcal.ok && rawcal.data && typeof rawcal.data === "object"
    ? compactRawcal(rawcal.data)
    : { error: "unavailable" };
  const fut = futures.ok && futures.data && typeof futures.data === "object" ? futures.data as Record<string, unknown> : null;
  const edge = (fut?.edge ?? {}) as Record<string, unknown>;
  const futuresCompact = fut ? {
    maturity: edge.maturity, bestFilter: edge.bestFilter, counts: fut.counts,
    tape: (fut.services as Record<string, Record<string, unknown>> | undefined)?.tape,
    taxonomyBackfill: fut.backfill,
  } : { error: "unavailable" };
  const sentinelCompact = sent.ok && sent.data && typeof sent.data === "object"
    ? {
        verdict: (sent.data as Record<string, unknown>).verdict,
        anomalies: (sent.data as Record<string, unknown>).anomalies,
        mem: (sent.data as Record<string, unknown>).mem,
        disk: (sent.data as Record<string, unknown>).disk,
        backup: (sent.data as Record<string, unknown>).backup,
        rawcal: (sent.data as Record<string, unknown>).rawcal,
      }
    : { error: "unavailable" };

  // v11.6 EQ-97 — the validation line is now MEASURED, not static: live OOS
  // numbers from /api/oos-tracker (protocol §2/§9 bars), honest fallback if
  // the app is briefly down.
  const oosT = (oos.ok && oos.data && typeof oos.data === "object" ? oos.data : null) as
    | { totalOosN?: number; totalTarget?: number; totalFillPct?: number; weakStrategies?: string[]; etaDaysToBar?: number | null; verdict?: string; settlePacePerDay14d?: number }
    | null;
  const strategyValidationStatus = oosT && typeof oosT.totalOosN === "number"
    ? `PROMOTE gate = ${oosT.verdict ?? "FAIL-OPEN-GAPS"} — OOS ${oosT.totalOosN}/${oosT.totalTarget ?? 300} (${oosT.totalFillPct ?? 0}%) · weak per-strategy (<60): ${oosT.weakStrategies?.length ? oosT.weakStrategies.join(",") : "none"} · pace ${oosT.settlePacePerDay14d ?? "?"}/day · ETA ${oosT.etaDaysToBar != null ? `${oosT.etaDaysToBar}d` : "n/a"} (protocol STRATEGY-VALIDATION-PROTOCOL.md; sample-size leg only) — recommend only evidence-respecting actions`
    : "PROMOTE gate = FAIL (insufficient OOS n; re-validation protocol in STRATEGY-VALIDATION-PROTOCOL.md) — recommend only evidence-respecting actions";

  const telemetry = {
    generatedAt: new Date().toISOString(),
    liveExecution: "DISABLED (paper/research-only; SUPPRESSED engine path — honesty contract)",
    strategyValidationStatus,
    sentinel: sentinelCompact,
    deepSweepQuick: deep,
    pulseStats,
    rawcal: rawcalCompact,
    shadowVetoArms: arms,
    shadowVetoStats: (shadow as Record<string, unknown> | null)?.stats ?? null,
    futures: futuresCompact,
    tradeService: trade.ok ? trade.data : { error: "unavailable" },
    lastSweepAnomalies: state.lastSweep?.anomalies ?? [],
    lastReviewAt: state.lastReview?.at ?? null,
  };

  // (c) LLM — senior supervisor doctrine
  const llm = await callLlmReview(JSON.stringify(telemetry, null, 1));

  // (d) persist FULL review + condensed Telegram push (honest on failure)
  const reviewDoc = {
    at: new Date().toISOString(),
    tehran: tehran(),
    status: llm.status,
    err: llm.err ?? null,
    review: llm.review,
    telemetrySnapshot: telemetry,
    deepSweepChars: deep.length,
  };
  try {
    writeFileSync(`${REVIEW}.tmp`, JSON.stringify(reviewDoc, null, 1));
    renameSync(`${REVIEW}.tmp`, REVIEW);
  } catch (e) { log("warn", "review-write-failed", { err: String(e).slice(0, 120) }); }

  state.lastReview = { at: reviewDoc.at, status: llm.status, verdict: llm.status === "ok" ? String((llm.review as Record<string, unknown>).verdict ?? null) : null };

  if (llm.status === "ok") {
    const rv = llm.review as Record<string, unknown>;
    const findings = Array.isArray(rv.findings) ? rv.findings as Array<Record<string, unknown>> : [];
    const actions = Array.isArray(rv.top_actions) ? rv.top_actions as Array<Record<string, unknown>> : [];
    const lines = [`🧠 <b>NEXUS · بازبینی مهندس ارشد</b>`, `<code>${tehran()} IRST</code>`, `▸ وردیکت: <b>${String(rv.verdict)}</b> — ${String(rv.summary ?? "").slice(0, 160)}`];
    for (const f of findings.slice(0, 5)) lines.push(`  · [${String(f.sev)}] ${String(f.area)}: ${String(f.evidence ?? "").slice(0, 110)}`);
    lines.push(`▸ <b>۳ اقدام اولویت‌دار:</b>`);
    actions.slice(0, 3).forEach((a, i) => lines.push(`  ${i + 1}. ${String(a.action).slice(0, 140)}\n     اثر: ${String(a.expected_effect_on_winrate_or_pnl ?? "").slice(0, 110)} · تلاش ${String(a.effort)} · ریسک ${String(a.risk ?? "?").slice(0, 60)}`));
    lines.push(`▸ جزئیات کامل: GET :3015/status`);
    const r = await bridgeSend(lines.join("\n"));
    log(r.ok ? "info" : "warn", r.ok ? "review-sent" : "review-send-failed", { status: llm.status, http: r.status ?? r.err });
  } else {
    log("warn", "review-llm-unavailable", { status: llm.status, err: llm.err });
    // honest operator note — sweep data still persisted (telemetrySnapshot above).
    // v1.2.1 (Task 41): rate-limited to one note per 12h — during the LLM-429
    // storm every catch-up review fired this note into Telegram (~every 3min).
    const LEDGER_GAP = 12 * 3600_000;
    const lastNote = state.alertLedger["review-llm-unavailable"] ?? 0;
    if (Date.now() - lastNote >= LEDGER_GAP) {
      state.alertLedger["review-llm-unavailable"] = Date.now();
      persistState();
      await bridgeSend(`⚠️ <b>NEXUS · بازبینی مهندس ارشد</b>\nLLM در دسترس نبود (status: <code>${llm.status}</code>) — تلمتری sweep ذخیره شد؛ بازبینی بعدی ۱۲س دیگر.\n${llm.err ? `<code>${String(llm.err).slice(0, 100)}</code>` : ""}`);
    } else {
      log("info", "review-note-rate-limited", { sinceMs: Date.now() - lastNote });
    }
  }
  return { status: llm.status };
}

// ═══════════════ JOB: watch (Task 36 · one-shot mission) ═══════════════
// Operator order 2026-09-26: «پیشنهاد ماموریت بعدی با چرخش کلید کنترل را کامل و
// مهندسی انجام بده» — the sentinel-proposed 30-minute engineered watch:
//   · FUTURES TAXONOMY sampler keeps landing LIVE rows on the tri-exchange
//     fuel (fapi → SPOT-MIRROR) — freshness window 35 min per tick (v14.0 Binance-only)
//   · shadow-veto arms fill toward the 30-sample veto threshold (honest n,
//     no invented data)
//   · app/ws/sentinel health each tick
// 3 ticks = 30 min → final Persian summary persisted to watch-report.json and
// pushed to Telegram ONCE. Manual POST /run {job:"watch"} re-arms a fresh
// mission after completion. Read-only on the DB (bun:sqlite readonly).
const DB_PATH = `${ROOT}/db/custom.db`;
interface WatchRow { symbol: string; ts: number; source: string; price: number | null }
function readTaxonomyRows(): { latest: WatchRow[]; fresh35m: number; err?: string } {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    db.exec("PRAGMA busy_timeout=2500");
    const rows = db.query(`SELECT "symbol","ts","source","price" FROM "FuturesSnapshot" ORDER BY "ts" DESC LIMIT 6`).all() as Array<Record<string, unknown>>;
    const cutoff = Date.now() - 35 * 60_000;
    const cnt = db.query(`SELECT COUNT(*) AS n FROM "FuturesSnapshot" WHERE "ts" >= ?`).get(cutoff) as { n: number | bigint } | undefined;
    db.close();
    const latest = rows.map((r) => ({ symbol: String(r.symbol), ts: Number(r.ts), source: String(r.source), price: r.price == null ? null : Number(r.price) }));
    return { latest, fresh35m: Number(cnt?.n ?? 0) };
  } catch (e) {
    return { latest: [], fresh35m: 0, err: String(e).slice(0, 120) };
  }
}

async function jobWatch(): Promise<{ ok: boolean; detail: string }> {
  const run = state.watchRuns.length + 1;
  const tax = readTaxonomyRows();
  const shadow = readJsonFile(`${ROOT}/.data/shadow-veto-latest.json`) as { arms?: Array<Record<string, unknown>> } | null;
  const arms = (shadow?.arms ?? []).map((a, i) => ({
    id: String(a.id ?? i),
    label: String(a.label ?? a.id ?? i),
    n: Number(a.n ?? 0),
    target: Number(a.target ?? 0),
    fillPct: Number(a.fillPct ?? 0),
    starved: Boolean(a.starved),
  }));
  const appHz = await probe("app :3000", "http://127.0.0.1:3000/api/healthz", (s) => s === 200);
  const wsProbe = await probe("ws :3003", "http://127.0.0.1:3003/", (s) => s === 400 || s === 200); // socket.io answers 400 on plain GET = ALIVE
  const rep = await fetchJson("http://127.0.0.1:3030/report", 8_000);
  const verdict = rep.ok && rep.data && typeof rep.data === "object" ? String((rep.data as Record<string, unknown>).verdict ?? "UNKNOWN") : "UNKNOWN";

  const latestAgeMin = tax.latest.length ? Math.round((Date.now() - Math.max(...tax.latest.map((r) => r.ts))) / 60_000) : null;
  const record = {
    run,
    at: new Date().toISOString(),
    tehran: tehran(),
    taxonomy: { fresh35m: tax.fresh35m, latestAgeMin, err: tax.err ?? null, latest: tax.latest.slice(0, 3) },
    arms,
    services: { app: appHz.up, ws: wsProbe.up, sentinelVerdict: verdict },
  };
  state.watchRuns.push(record);

  const done = run >= WATCH_MAX_RUNS;
  let summary = `run ${run}/${WATCH_MAX_RUNS}: taxonomy fresh35m=${tax.fresh35m} latestAge=${latestAgeMin ?? "null"}min · arms ${arms.map((a) => `${a.id} ${a.n}/${a.target}`).join(", ")} · app=${appHz.up} ws=${wsProbe.up} verdict=${verdict}`;

  if (done) {
    const first = state.watchRuns[0] as typeof record;
    const last = record;
    const armsDelta = arms.map((a) => {
      const before = (first.arms as typeof arms).find((x) => x.id === a.id);
      return `${a.id}: ${before?.n ?? 0}→${a.n}/${a.target}`;
    }).join(" · ");
    const freshTotal = Math.max(...state.watchRuns.map((r) => Number((r as typeof record).taxonomy.fresh35m)));
    summary = `mission complete · taxonomy rows/35min ${first.taxonomy.fresh35m}→${last.taxonomy.fresh35m} (max ${freshTotal}) · arms Δ ${armsDelta} · verdict ${String(first.services.sentinelVerdict)}→${last.services.sentinelVerdict}`;
    state.lastWatch = { at: new Date().toISOString(), run, done: true, summary };
    const doc = { at: state.lastWatch.at, tehran: tehran(), mission: "30-minute live-fuel & arms watch (Task 36)", runs: state.watchRuns, summary };
    try {
      writeFileSync(`${DIR}/watch-report.json.tmp`, JSON.stringify(doc, null, 1));
      renameSync(`${DIR}/watch-report.json.tmp`, `${DIR}/watch-report.json`);
    } catch (e) { log("warn", "watch-write-failed", { err: String(e).slice(0, 120) }); }
    const lines = [
      `📡 <b>NEXUS · گزارش ماموریت رصد ۳۰دقیقه‌ای</b>`,
      `<code>${tehran()} IRST</code>`,
      `▸ TAXONOMY: ردیف زنده در پنجره ۳۵دقیقه‌ای: <b>${last.taxonomy.fresh35m}</b> · کهنه‌ترین ردیف ${last.taxonomy.latestAgeMin ?? "—"} دقیقه پیش`,
      `▸ بازوهای shadow-veto: <code>${armsDelta}</code>`,
      `▸ سرویس‌ها: app=${last.services.app ? "OK" : "DOWN"} · ws=${last.services.ws ? "OK" : "DOWN"} · sentinel=${last.services.sentinelVerdict}`,
      `▸ جزئیات کامل: GET :3015/status و .data/supervisor-cron/watch-report.json`,
    ];
    const r = await bridgeSend(lines.join("\n"));
    log(r.ok ? "info" : "warn", r.ok ? "watch-report-sent" : "watch-report-send-failed", { http: r.status ?? r.err });
  } else {
    state.lastWatch = { at: new Date().toISOString(), run, done: false, summary };
  }
  return { ok: true, detail: summary.slice(0, 200) };
}

// ═════════════════════════════ RUNNER (single-flight + drift-resistant) ══════
const running = new Set<JobId>();
async function runJob(id: JobId, trigger: "schedule" | "manual"): Promise<{ ok: boolean; status: string; detail?: string }> {
  if (running.has(id)) {
    log("info", "single-flight-skip", { job: id, trigger });
    return { ok: false, status: "already-running" };
  }
  running.add(id);
  const t0 = Date.now();
  let status = "ok";
  let detail = "";
  try {
    if (id === "sweep") {
      const r = await jobSweep();
      detail = `${r.verdict}: ${r.reason.slice(0, 120)}`;
      if (r.verdict === "UNKNOWN") status = "error";
    } else if (id === "progress") {
      const r = await jobProgress();
      status = r.ok ? "ok" : "error";
      detail = r.detail;
    } else if (id === "watch") {
      const r = await jobWatch();
      status = r.ok ? "ok" : "error";
      detail = r.detail;
    } else if (id === "backup") {
      const r = await jobBackup();
      status = r.ok ? "ok" : "error";
      detail = r.detail;
    } else if (id === "digest") {
      const r = await jobDigest();
      status = r.ok ? "ok" : "error";
      detail = r.detail;
    } else if (id === "keepwarm") {
      const r = await jobKeepwarm();
      status = r.ok ? "ok" : "error"; // cold heartbeat = honest failure telemetry
      detail = r.detail;
    } else {
      const r = await jobReview();
      detail = `llm=${r.status}`;
    }
  } catch (e) {
    status = "error";
    detail = String(e).slice(0, 200);
    log("crit", "job-threw", { job: id, err: detail }); // never crash — logged and continued
  } finally {
    running.delete(id);
    const dur = Date.now() - t0;
    const js = state.jobs[id];
    js.lastRunAt = t0;
    js.lastStatus = status;
    js.lastDurationMs = dur;
    js.lastError = status === "error" ? detail : null;
    js.runs += 1;
    if (status === "error") js.failures += 1;
    pushHistory({ id, at: t0, status, durationMs: dur, detail: detail.slice(0, 200) });
    persistState();
    log(status === "ok" ? "info" : "warn", "job-done", { job: id, trigger, status, durMs: dur, detail: detail.slice(0, 100) });
  }
  return { ok: status === "ok", status, detail };
}

// drift-resistant scheduler: timers fire AT the scheduled time; the NEXT run is
// scheduled from the previous scheduled time (not from completion).
// Catch-up: sweep skips missed slots (10-min cadence self-heals); an overdue
// progress/review report runs shortly (catch-up semantics like daily-scheduler)
// instead of silently waiting another full interval.
function intervalFor(id: JobId): number {
  return id === "sweep" ? SWEEP_MS : id === "progress" ? PROGRESS_MS : id === "watch" ? WATCH_MS : id === "backup" ? BACKUP_MS : id === "digest" ? DIGEST_MS : id === "keepwarm" ? KEEPWARM_MS : REVIEW_MS;
}
function scheduleNext(id: JobId) {
  // one-shot mission finished → do not reschedule (manual /run re-arms)
  if (id === "watch" && state.watchRuns.length >= WATCH_MAX_RUNS) return;
  const interval = intervalFor(id);
  const js = state.jobs[id];
  const now = Date.now();
  let next = js.nextRunAt ?? now + interval;
  if (next <= now) {
    if (id === "sweep" || id === "keepwarm") { while (next <= now) next += interval; } // 5-10min cadences self-heal missed slots
    else if (js.lastRunAt && js.lastRunAt >= next) {
      // v1.2.0 BUGFIX (operator report «هر ۱ دقیقه به تلگرام پیام می‌فرستد»):
      // the catch-up run already happened (lastRunAt at-or-after the stale
      // slot — timer fires exactly AT the slot, so equality is the common
      // case) → anchor the next slot at lastRun+interval instead of re-
      // catching-up every 90s. The old code never advanced the anchor, so one
      // missed slot degenerated into a 90-second send-loop for 6h reports.
      next = js.lastRunAt + interval;
      while (next <= now) next += interval;
    } else if (now - next > interval / 2) {
      // v1.2.1 (Task 41): stale missed slot — the report's window is long gone,
      // and after a long downtime this branch used to fire a "catch-up" send
      // on every restart. Re-anchor silently instead: a 5h-overdue 6h report
      // carries no news; the next one comes on schedule.
      log("info", "catch-up-skipped-stale", { job: id, overdueMs: now - next });
      next = now + interval;
    } else {
      next = now + 90_000; // first catch-up for a genuinely missed report → run shortly
    }
  }
  js.nextRunAt = next;
  const delay = Math.max(0, next - now);
  const g = globalThis as typeof globalThis & { __scTimers?: Map<string, ReturnType<typeof setTimeout>> };
  g.__scTimers ??= new Map();
  const prev = g.__scTimers.get(id);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => { void runJob(id, "schedule").catch(() => { /* never */ }).finally(() => scheduleNext(id)); }, delay);
  t.unref?.();
  g.__scTimers.set(id, t);
}

// ═════════════════════════ JOB: backup (v1.2.0) ═══════════════════════════
// Restores the 3-hourly sandbox snapshot under OUR ownership: the old
// platform-cron job died with a platform reset and the Task-34 rebuild of
// this service never re-owned it → ring went stale (found 2026-09-26).
// scripts/backup.sh is battle-tested (zip + wal_checkpoint + AES-256 .enc +
// Telegram off-site tiers + RECOVERY-INDEX) and reads its own .env secrets.
async function jobBackup(): Promise<{ ok: boolean; detail: string }> {
  const t0 = Date.now();
  const proc = Bun.spawn(["bash", `${ROOT}/scripts/backup.sh`], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(9); } catch { /* */ } }, BACKUP_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const tail = `${out}\n${err}`.trim().split("\n").slice(-6).join(" | ").slice(0, 280);
  if (timedOut) return { ok: false, detail: `timeout after ${BACKUP_TIMEOUT_MS / 60000}min: ${tail}` };
  if (code !== 0) return { ok: false, detail: `exit ${code}: ${tail}` };
  return { ok: true, detail: `snapshot ok in ${Math.round((Date.now() - t0) / 1000)}s: ${tail}` };
}

// ═══════════════════════ JOB: digest (v1.4.0 · TASK-48) ═══════════════════
// Operator order 2026-09-29: «هزینه‌های VPS خیلی بالاست… کمکم کن همینجا ازش
// استفاده کنم» — the sandbox stays free, so the operator's TELEGRAM becomes
// the terminal: every 2h a compact Persian digest built ONLY from real ledger
// rows (readonly sqlite — Prisma owns writes; honest nulls, never invented).
// First digest fires 2min after every boot = post-recycle recovery proof.
function fmtPrice(v: number): string {
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(1) : a >= 100 ? v.toFixed(2) : a >= 1 ? v.toFixed(4) : v.toFixed(6);
}
async function jobDigest(): Promise<{ ok: boolean; detail: string }> {
  const since = Date.now() - DIGEST_MS;
  let db: Database | null = null;
  try {
    db = new Database(`${ROOT}/db/custom.db`, { readonly: true });
    db.exec("PRAGMA busy_timeout=2500");
    const newCount = (db.query("SELECT COUNT(*) n FROM Signal WHERE createdAt >= ?").get(since) as { n: number }).n;
    const newSignals = db
      .query("SELECT serial, symbol, direction, entryPrice, tp1, stopLoss, confidence FROM Signal WHERE createdAt >= ? ORDER BY createdAt DESC LIMIT ?")
      .all(since, DIGEST_MAX_NEW) as Array<{ serial: number; symbol: string; direction: string; entryPrice: number; tp1: number; stopLoss: number; confidence: number }>;
    const settled = db
      .query("SELECT status, COUNT(*) n, ROUND(AVG(pnlPercent),2) avgPnl FROM Signal WHERE qualityFlag IS NULL AND closedAt >= ? GROUP BY status")
      .all(since) as Array<{ status: string; n: number; avgPnl: number }>;
    const week = db
      .query("SELECT COUNT(*) n, ROUND(AVG(pnlPercent),2) meanPnl, SUM(CASE WHEN pnlPercent > 0 THEN 1 ELSE 0 END) wins FROM Signal WHERE qualityFlag IS NULL AND closedAt >= ?")
      .get(Date.now() - 7 * 864e5) as { n: number; meanPnl: number | null; wins: number | null };
    const active = (db.query("SELECT COUNT(*) n FROM Signal WHERE status = 'ACTIVE'").get() as { n: number }).n;
    db.close();
    db = null;

    const L: string[] = [];
    L.push("📊 <b>NEXUS · گزیدهٔ سیگنال‌ها</b>");
    L.push(`<i>${tehran()} IRST · پنجرهٔ ۲ ساعت</i>`);
    L.push("");
    L.push(`🆕 سیگنال جدید: <b>${newCount}</b> · فعال الان: <b>${active}</b>`);
    for (const s of newSignals) {
      const arrow = s.direction === "LONG" ? "🟢" : "🔴";
      L.push(`• <b>NX-${String(s.serial).padStart(4, "0")}</b> ${s.symbol} ${arrow}${s.direction} · ورود <code>${fmtPrice(s.entryPrice)}</code> · TP1 <code>${fmtPrice(s.tp1)}</code> · SL <code>${fmtPrice(s.stopLoss)}</code> · اطمینان ${s.confidence}%`);
    }
    if (newCount > DIGEST_MAX_NEW) L.push(`• … و ${newCount - DIGEST_MAX_NEW} سیگنال دیگر`);
    L.push("");
    if (settled.length > 0) {
      const order = ["TP3", "TP2", "TP1", "SL", "EXPIRED"];
      const parts = order
        .filter((k) => settled.some((r) => r.status === k))
        .map((k) => {
          const r = settled.find((x) => x.status === k)!;
          return `${k}×${r.n} (${r.avgPnl >= 0 ? "+" : ""}${r.avgPnl}%)`;
        });
      L.push(`🏁 ستل ۲ ساعت: ${parts.join(" · ")}`);
    } else {
      L.push("🏁 ستل ۲ ساعت: موردی بسته نشد");
    }
    if (week && week.n > 0 && week.meanPnl != null) {
      const wr = week.wins != null ? Math.round((week.wins / week.n) * 100) : null;
      L.push(`📈 هفتهٔ اخیر: ${week.n} ستل‌شده · میانگین ${week.meanPnl >= 0 ? "+" : ""}${week.meanPnl}٪${wr != null ? ` · برد ${wr}٪` : ""}`);
    }
    const sv = state.lastSweep;
    if (sv) L.push(`${sv.verdict === "GREEN" ? "🟢" : sv.verdict === "AMBER" ? "🟡" : "🔴"} سیستم: ${sv.verdict} · آخرین داده ${sv.data?.lastEventAgeMin ?? "—"} دقیقه پیش`);
    // v11.0 STABLEFLOW (operator mandate 2026-09-30: «تمام فازها را کامل و
    // مهندسی اجرا کن»): Persian stablecoin-regime line straight from the
    // stable-feed board file. Honest skip when absent or stale (>40min) —
    // the digest never invents data.
    try {
      const b = JSON.parse(readFileSync(`${ROOT}/.data/stable-feed/board.json`, "utf8")) as {
        at: number; totalMcapUsd: number | null; totalDelta24hPct: number | null; regime: string; regimeReason: string; maxPegDevPct: number | null;
      };
      if (b.at && Date.now() - b.at < 40 * 60_000 && b.totalMcapUsd) {
        const fa = b.regime === "RISK-ON" ? "ریسک‌پذیر 🟢" : b.regime === "RISK-OFF" ? "ریسک‌گریز 🔴" : "خنثی ⚪";
        const d24 = b.totalDelta24hPct === null ? "—" : `${b.totalDelta24hPct >= 0 ? "+" : ""}${b.totalDelta24hPct.toFixed(2)}٪`;
        const peg = b.maxPegDevPct === null ? "" : ` · پیگ ${Math.abs(b.maxPegDevPct) < 0.5 ? "سالم ✅" : `⚠️ ${b.maxPegDevPct.toFixed(2)}٪`}`;
        L.push(`🌊 استیبل‌کوین‌ها: کل <b>${(b.totalMcapUsd / 1e9).toFixed(1)}B$</b> · ۲۴ساعته ${d24} · رژیم نقدینگی: ${fa}${peg}`);
      }
    } catch { /* no board yet — honest skip */ }
    L.push("");
    L.push("⚠️ سیگنال مشاوره است نه تضمین — فقط با سرمایه‌ای که از دست دادنش زندگی‌ات را نمی‌شکند.");
    const r = await bridgeSend(L.join("\n"));
    state.lastDigest = { at: new Date().toISOString(), ok: r.ok, newN: newCount };
    return { ok: r.ok, detail: `digest new=${newCount} settled=${settled.length} bridge=${r.ok ? "ok" : String(r.err ?? r.status)}` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 160) };
  } finally {
    try { db?.close(); } catch { /* never */ }
  }
}

// ═══════════════════════ JOB: keepwarm (v1.5.0 · TASK-56) ═══════════════
// Operator order: «کرون‌جاب keep-warm و … را کامل و مهندسی انجام بده».
// Two-tier keep-warm doctrine (SANDBOX-COLD-0930 post-mortem):
//   · TIER-1 INTERNAL (this job, every 5 min): self-ping /api/healthz (+
//     /api/pulse fallback) and PERSIST the lineage evidence (bootAt · gitSha ·
//     coldStreak). warm-loop :3012 already drives the engine via 5s pulses —
//     this job adds what it lacks: Job-411262 heartbeat semantics with an
//     auditable OK/COLD ledger in state.json, visible on /health.
//   · TIER-2 EXTERNAL (operator-registered platform cron, Job 411262 model):
//     an OUTSIDE heartbeat every 5 min against the public /api/healthz — the
//     ONLY tier that prevents platform idle-recycle (internal traffic never
//     counts; proven: warm-loop pulsed every 5s and the box still recycled).
//     Kit: scripts/keep-warm.sh + the exact spec in the Task-56 reply.
// HARD RULES (Job-411262 doctrine): the heartbeat NEVER restarts, NEVER
// heals, NEVER mutates — it hits one endpoint and writes one honest line.
// A cold app belongs to p0-watchdog; keepwarm only counts the streak.
async function jobKeepwarm(): Promise<{ ok: boolean; detail: string }> {
  const t0 = Date.now();
  const hit = await fetchJson("http://127.0.0.1:3000/api/healthz", 8_000);
  const ms = Date.now() - t0;
  let ok = false;
  let bootAt: string | null = null;
  let gitSha: string | null = null;
  const d = (hit.data ?? null) as { bootAt?: string; gitSha?: string } | null;
  if (hit.ok && d && typeof d.bootAt === "string") {
    ok = true;
    bootAt = d.bootAt;
    gitSha = typeof d.gitSha === "string" ? d.gitSha.slice(0, 7) : null;
  } else {
    // fallback lane: pulse touches the DB — only tried when healthz failed
    const p = await fetchJson("http://127.0.0.1:3000/api/pulse", 12_000);
    if (p.ok) ok = true;
  }
  state.coldStreak = ok ? 0 : state.coldStreak + 1;
  state.lastKeepwarm = { at: new Date().toISOString(), ok, ms, bootAt, gitSha, coldStreak: state.coldStreak };
  if (!ok) {
    log("warn", "keepwarm-cold", { ms, coldStreak: state.coldStreak });
    if (state.coldStreak === 3) log("crit", "keepwarm-cold-streak", { note: "app cold ≥15min — p0-watchdog owns healing; keepwarm never restarts (Job-411262 doctrine)" });
    return { ok: false, detail: `HEARTBEAT COLD app:3000 ${ms}ms streak=${state.coldStreak}` };
  }
  return { ok: true, detail: `HEARTBEAT OK ${ms}ms boot=${(bootAt ?? "?").slice(11, 19)}Z sha=${gitSha ?? "?"}` };
}

// ── HTTP surface ─────────────────────────────────────────────────────────────
function jobSummary(): Array<Record<string, unknown>> {
  return (["keepwarm", "sweep", "progress", "review", "watch", "backup", "digest"] as JobId[]).map((id) => {
    const js = state.jobs[id];
    return { id, lastRunAt: js.lastRunAt, nextRunAt: js.nextRunAt, lastStatus: js.lastStatus, lastDurationMs: js.lastDurationMs, intervalMin: id === "keepwarm" ? 5 : id === "sweep" || id === "watch" ? 10 : id === "backup" ? 180 : id === "digest" ? 120 : id === "progress" ? 360 : 720, runs: js.runs, failures: js.failures };
  });
}
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/health") {
    return Response.json({
      ok: true, service: "supervisor-cron", ver: VER, pid: process.pid,
      uptimeSec: Math.floor((Date.now() - BOOT) / 1000), tehran: tehran(),
      jobs: jobSummary(),
      lastReviewAt: state.lastReview?.at ?? null,
      lastSweepVerdict: state.lastSweep?.verdict ?? null,
      lastKeepwarm: state.lastKeepwarm,
    }, { headers: { "cache-control": "no-store" } });
  }
  if (p === "/status") {
    return Response.json({
      ok: true, service: "supervisor-cron", ver: VER, pid: process.pid,
      uptimeSec: Math.floor((Date.now() - BOOT) / 1000), tehran: tehran(),
      jobs: jobSummary(),
      lastSweep: state.lastSweep,
      lastWatch: state.lastWatch,
      watchRuns: state.watchRuns.slice(-6),
      lastReview: state.lastReview ? (() => { try { const d = JSON.parse(readFileSync(REVIEW, "utf8")) as Record<string, unknown>; return { at: d.at, status: d.status, err: d.err, review: d.review }; } catch { return { ...state.lastReview, review: null, note: "review-file-unreadable" }; } })() : null,
      lastProgress: state.lastProgress,
      alertLedger: state.alertLedger,
      running: [...running],
      history: state.history.slice(-HISTORY_MAX),
    }, { headers: { "cache-control": "no-store" } });
  }
  if (p === "/run" && req.method === "POST") {
    if (!controlOk(req)) return Response.json({ ok: false, error: "unauthorized: mutating API requires x-nexus-key header" }, { status: 401, headers: { "cache-control": "no-store" } });
    const body = (await req.json().catch(() => ({}))) as { job?: string };
    const job = body.job as JobId | undefined;
    if (job !== "sweep" && job !== "progress" && job !== "review" && job !== "watch" && job !== "backup" && job !== "digest" && job !== "keepwarm") {
      return Response.json({ ok: false, error: 'body {job: "sweep"|"progress"|"review"|"watch"|"backup"|"keepwarm"} required' }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    // watch mission re-arm: a manual run after completion starts a fresh mission
    if (job === "watch" && state.watchRuns.length >= WATCH_MAX_RUNS) {
      state.watchRuns = [];
      state.lastWatch = null;
      log("info", "watch-rearmed", { by: "manual" });
    }
    const r = await runJob(job, "manual");
    if (r.ok) {
      // a successful manual run re-anchors the schedule from now (operator override)
      const ms = intervalFor(job);
      state.jobs[job].nextRunAt = Date.now() + ms;
      scheduleNext(job);
      persistState();
    }
    return Response.json({ ok: r.ok, job, status: r.status, detail: r.detail, jobs: jobSummary() }, { status: r.status === "already-running" ? 409 : 200, headers: { "cache-control": "no-store" } });
  }
  return new Response("supervisor-cron: 404\n", { status: 404 });
}

// ── boot ─────────────────────────────────────────────────────────────────────
mkdirSync(DIR, { recursive: true });
mkdirSync(`${ROOT}/logs`, { recursive: true });
// singleton guard (pid lockfile; bun --hot keeps the same pid → keeps the lock)
const LOCK = `${DIR}/lock.json`;
try {
  const prev = JSON.parse(readFileSync(LOCK, "utf8")) as { pid?: number };
  if (prev?.pid && prev.pid !== process.pid) {
    try { process.kill(prev.pid, 0); console.log(`[${tehran()}] another supervisor-cron alive (pid ${prev.pid}) — exiting`); process.exit(0); }
    catch { /* stale lock — take over */ }
  }
} catch { /* first boot */ }
writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: state.startedAt }));

try {
  Bun.serve({ port: PORT, fetch: (req) => handle(req).catch((e) => { log("crit", "handler-error", { err: String(e).slice(0, 150) }); return new Response("internal\n", { status: 500 }); }) });
} catch (e) {
  console.log(`[${tehran()}] port ${PORT} busy — exiting: ${String(e).slice(0, 100)}`);
  process.exit(0);
}
loadState();
persistState();
log("info", "boot", { ver: VER, pid: process.pid, port: PORT });
console.log(`[${tehran()}] ${VER} armed on :${PORT} — keepwarm 5m · sweep 10m · progress 6h · review 12h · watch 10m×3 · backup 3h · digest 2h (DAILY/SRE owned by Next daily-scheduler, not duplicated)`);
for (const id of ["keepwarm", "sweep", "progress", "review", "watch", "backup", "digest"] as JobId[]) scheduleNext(id);

process.on("SIGTERM", () => { log("info", "shutdown", { sig: "SIGTERM" }); try { writeFileSync(LOCK, JSON.stringify({ pid: null, releasedAt: new Date().toISOString() })); } catch { /* */ } process.exit(0); });
process.on("SIGINT", () => { log("info", "shutdown", { sig: "SIGINT" }); process.exit(0); });
// cron must never crash: log + persist + stay alive (watchdog is the backstop)
process.on("uncaughtException", (e) => { log("crit", "uncaught", { err: String(e).slice(0, 200) }); persistState(); });
process.on("unhandledRejection", (e) => { log("crit", "unhandled-rejection", { err: String(e).slice(0, 200) }); persistState(); });
