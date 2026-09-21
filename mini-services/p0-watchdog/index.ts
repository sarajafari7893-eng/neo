// NEXUS//SIGNALS — P0 WATCHDOG v1.1.0 (task ref OP-P0-WD-0909 · 4-b control gate)
// v1.1.0 (task 4-b · audit P0-1): `x-nexus-key` header (matching
//   NEXUS_CONTROL_KEY from env/.env) is now REQUIRED on POST /pause and
//   POST /probe-now (trigger endpoints). GET /health + GET /status stay open
//   (probes). Fail-closed when the key is unset; constant-time compare; the
//   key value is never echoed/logged. Pause-file flow (dev-up.sh / watchdog.sh
//   write .data/p0-watchdog/pause-until directly) is HTTP-independent and
//   unaffected. (Historical: pre-restore v1.1.0 by task 5-d added a circuit
//   breaker — that tree was reverted by the 20260919 snapshot restore.)
// ─────────────────────────────────────────────────────────────────────────────
// Process guardian for the three P0 services on the 4GB no-swap sandbox:
//   app :3000  (Next.js dev, heap 1400MB)   probe /api/pulse      expect 200
//   liq :3010  (liquidation feed)           probe /health         expect 200
//   ws  :3003  (price-ws socket.io)         probe /               expect <500 (400 = socket.io root)
//
// Contract:
//   • probe every 15s · heal after 2 consecutive failures (≈30s reaction)
//   • heal = spawn the service's own battle-tested start command (no new logic)
//   • cooldown 120s → ×2 exponential backoff → cap 900s; escalate flag after 5 failed heals
//   • fail-open: watchdog NEVER kills anything; it only spawns start scripts
//   • pause file: dev-up.sh writes .data/p0-watchdog/pause-until (+180s) so the
//     watchdog never races an operator-triggered restart (no duplicate instances)
//   • duplicate-instance guard: lockfile (pid liveness) + :3020 port bind
//   • escalation mirror: Telegram sendMessage on escalated + recovered-after-escalated
//     (env TELEGRAM_BOT_TOKEN → chat: env TELEGRAM_CHAT_ID → EngineSetting telegram.chatId;
//      rate-limited, fully fail-silent — Telegram problems never affect healing)
//   • state: .data/p0-watchdog/state.json (atomic) + actions.jsonl (1MB rotate→keep 200)
// ─────────────────────────────────────────────────────────────────────────────
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const VER = "p0-watchdog 1.2.0";
const ROOT = "/home/z/my-project";
const DIR = `${ROOT}/.data/p0-watchdog`;
const LOCK = `${DIR}/lock.json`;
const PAUSE = `${DIR}/pause-until`;
const STATE = `${DIR}/state.json`;
const ACTIONS = `${DIR}/actions.jsonl`;
const LOG_SERVICE = `${ROOT}/logs/p0-watchdog-service.log`;

const PORT = 3020;
const TICK_MS = 15_000;
const BOOT_DELAY_MS = 3_000;
const PROBE_TIMEOUT_MS = 4_000;
const FAILS_TO_ACT = 2;
const HEAL_GRACE_S = 75; // boot window granted after a heal before re-judging
const COOLDOWN_BASE_S = 120;
const COOLDOWN_MAX_S = 900;
const ESCALATE_AFTER = 5; // consecutive heal attempts while still down
const MEM_WARN_MB = 350;
const MEM_CRIT_MB = 250;

// v1.2.0 (operator order 2026-09-21): probe surface extended app+liq+ws → 6 services.
// The 2026-09-20 restore resurrected bridge :3005 / trade :3011 / sentinel :3030
// WITHOUT guardians — trade ran down for hours unnoticed. All six are now
// probe+heal covered; heal commands mirror each service's battle-tested start.
type SvcKey = "app" | "liq" | "ws" | "bridge" | "trade" | "sentinel";
type Mode = "init" | "ok" | "degraded" | "healing" | "escalated";

interface SvcCfg {
  label: string;
  url: string;
  expect: (status: number) => boolean;
  expectNote: string;
  healCmd: string; // keep in sync with scripts/dev-up.sh / mini-services conventions
}

const SVCS: Record<SvcKey, SvcCfg> = {
  app: {
    label: "app :3000",
    url: "http://127.0.0.1:3000/api/pulse",
    expect: (s) => s === 200,
    expectNote: "200",
    // dev-up.sh is itself idempotent + probe-gated; it also writes our pause file (v8.1)
    healCmd: `cd ${ROOT} && nohup bash scripts/dev-up.sh >> ${ROOT}/logs/p0-heal-app.log 2>&1 &`,
  },
  liq: {
    label: "liq :3010",
    url: "http://127.0.0.1:3010/health",
    expect: (s) => s === 200,
    expectNote: "200",
    healCmd: `cd ${ROOT} && nohup bun run mini-services/liq-service/index.ts >> ${ROOT}/logs/liq-service.log 2>&1 &`,
  },
  ws: {
    label: "ws :3003",
    url: "http://127.0.0.1:3003/",
    expect: (s) => s < 500, // 400 = expected socket.io root response
    expectNote: "<500 (400=socket.io)",
    healCmd: `cd ${ROOT}/mini-services/price-ws && nohup bun --hot index.ts >> ${ROOT}/logs/price-ws.log 2>&1 &`,
  },
  bridge: {
    label: "bridge :3005",
    url: "http://127.0.0.1:3005/health",
    expect: (s) => s === 200,
    expectNote: "200",
    healCmd: `cd ${ROOT}/mini-services/telegram-bridge && nohup bun --hot index.ts >> ${ROOT}/logs/telegram-bridge.log 2>&1 &`,
  },
  trade: {
    label: "trade :3011",
    url: "http://127.0.0.1:3011/health",
    expect: (s) => s === 200,
    expectNote: "200",
    healCmd: `cd ${ROOT} && nohup bun run mini-services/trade-service/index.ts >> ${ROOT}/logs/trade-service.log 2>&1 &`,
  },
  sentinel: {
    label: "sentinel :3030",
    url: "http://127.0.0.1:3030/health",
    expect: (s) => s === 200,
    expectNote: "200",
    healCmd: `cd ${ROOT}/mini-services/sentinel-service && nohup bun --hot index.ts >> ${ROOT}/logs/sentinel-service.log 2>&1 &`,
  },
};

interface SvcState {
  mode: Mode;
  fails: number;
  heals: number;
  lastProbeAt: number | null;
  lastOkAt: number | null;
  lastStatus: number | null;
  lastLatencyMs: number | null;
  lastDownAt: number | null;
  lastHealAt: number | null;
  healingUntil: number | null;
  nextHealAllowedAt: number | null;
  breakerAnnounced?: boolean; // v10.16: one-shot log for open-breaker state
  recoveries: number;
}

const BOOT = Date.now();
const state: Record<SvcKey, SvcState> = {
  app: freshSvc(), liq: freshSvc(), ws: freshSvc(),
  bridge: freshSvc(), trade: freshSvc(), sentinel: freshSvc(),
};
function freshSvc(): SvcState {
  return { mode: "init", fails: 0, heals: 0, lastProbeAt: null, lastOkAt: null, lastStatus: null, lastLatencyMs: null, lastDownAt: null, lastHealAt: null, healingUntil: null, nextHealAllowedAt: null, recoveries: 0 };
}

let mem = { availableMb: null as number | null, level: "ok" as "ok" | "warn" | "crit", at: Date.now() };
let pausedUntil = 0; // epoch s, cached per tick
let ticks = 0;

// ── time helpers ─────────────────────────────────────────────────────────────
const nowMs = () => Date.now();
const tehran = (d: number | Date = nowMs()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);

// ── action log (JSONL + rotate) ──────────────────────────────────────────────
function log(lvl: "info" | "warn" | "crit", ev: string, det: Record<string, unknown> = {}, svc?: SvcKey) {
  const rec = { ts: new Date().toISOString(), tehran: tehran(), lvl, svc: svc ?? null, ev, ...det };
  const line = JSON.stringify(rec);
  try {
    if (existsSync(ACTIONS)) {
      const sz = statSync(ACTIONS).size;
      if (sz > 1_000_000) { // rotate: keep last 200 lines
        const txt = readFileSync(ACTIONS, "utf8").trim().split("\n");
        writeFileSync(ACTIONS, txt.slice(-200).join("\n") + "\n");
        log("info", "log-rotated", { kept: Math.min(200, txt.length) });
      }
    }
    appendFileSync(ACTIONS, line + "\n");
  } catch { /* logging must never kill the guardian */ }
  if (lvl !== "info") console.log(`[${tehran()}] ${lvl.toUpperCase()} ${svc ? svc + " " : ""}${ev} ${JSON.stringify(det)}`);
}

// ── state persistence (atomic) ───────────────────────────────────────────────
function persistState() {
  const body = {
    ver: VER, taskRef: "OP-P0-WD-0909", pid: process.pid, startedAt: new Date(BOOT).toISOString(),
    tehran: tehran(), uptimeSec: Math.floor((nowMs() - BOOT) / 1000),
    pausedUntil: pausedUntil > nowMs() / 1000 ? pausedUntil : null,
    mem, services: state,
  };
  try {
    writeFileSync(`${STATE}.tmp`, JSON.stringify(body, null, 1));
    renameSync(`${STATE}.tmp`, STATE);
  } catch (e) { log("warn", "state-write-failed", { err: String(e) }); }
}

// ── duplicate-instance guards ────────────────────────────────────────────────
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function acquireLock(): boolean {
  try {
    if (existsSync(LOCK)) {
      const prev = JSON.parse(readFileSync(LOCK, "utf8")) as { pid?: number };
      if (prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
        console.log(`[${tehran()}] another watchdog alive (pid ${prev.pid}) — exiting`);
        return false;
      }
    }
  } catch { /* stale/corrupt lock → take over */ }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return true;
}
function releaseLock() {
  try {
    const cur = JSON.parse(readFileSync(LOCK, "utf8")) as { pid?: number };
    if (cur.pid === process.pid) writeFileSync(LOCK, JSON.stringify({ pid: null, releasedAt: new Date().toISOString() }));
  } catch { /* ignore */ }
}

// ── pause file (written by dev-up.sh / POST /pause) ──────────────────────────
function readPause(): boolean {
  try {
    const until = parseInt(readFileSync(PAUSE, "utf8").trim(), 10);
    pausedUntil = isNaN(until) ? 0 : until;
  } catch { pausedUntil = 0; }
  return pausedUntil > nowMs() / 1000;
}

// ── memory guard (observe-only — never kills) ────────────────────────────────
function memCheck() {
  try {
    const txt = readFileSync("/proc/meminfo", "utf8");
    const m = txt.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!m) return;
    const mb = Math.floor(parseInt(m[1], 10) / 1024);
    const level = mb < MEM_CRIT_MB ? "crit" : mb < MEM_WARN_MB ? "warn" : "ok";
    if (level !== mem.level) log(level === "ok" ? "info" : level === "warn" ? "warn" : "crit", `mem-${level}`, { availableMb: mb, prev: mem.level });
    mem = { availableMb: mb, level, at: nowMs() };
    // v10.16 audit: memory ACTION channel (layer-1 acts in 15s vs layer-2's 60s) —
    // under critical pressure write a 10min lease suspending the app's background
    // LLM tier (consumed by src/lib/ai.ts withZai + layer-2); clear at ≥450MB.
    try {
      const sus = "/home/z/my-project/.data/ai/background-suspend";
      if (mb < MEM_CRIT_MB) {
        mkdirSync("/home/z/my-project/.data/ai", { recursive: true });
        writeFileSync(sus, String(Math.floor(nowMs() / 1000) + 600));
      } else if (mb >= 450) {
        try { unlinkSync(sus); } catch { /* already gone */ }
      }
    } catch { /* best-effort */ }
  } catch { /* /proc missing → skip */ }
}

// ── telegram escalation mirror (fail-silent, rate-limited) ───────────────────
let lastTg = { crit: 0, recov: 0 };
const TG_MIN_GAP_MS = 10 * 60_000;
function envFromDotenv(key: string): string | null {
  try {
    const m = readFileSync(`${ROOT}/.env`, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? (m[1].trim().replace(/^["']|["']$/g, "") || null) : null;
  } catch { return null; }
}
let chatCache: { v: string | null; at: number } = { v: null, at: 0 };
function getChat(): string | null {
  if (nowMs() - chatCache.at < 300_000) return chatCache.v;
  let v = process.env.TELEGRAM_CHAT_ID ?? envFromDotenv("TELEGRAM_CHAT_ID");
  if (!v) {
    try {
      const db = new Database(`${ROOT}/db/custom.db`, { readonly: true });
      const row = db.query("SELECT value FROM EngineSetting WHERE key = 'telegram.chatId'").get() as { value?: string } | null;
      db.close();
      const raw = row?.value;
      if (raw) v = raw.replace(/^"|"$/g, "").trim() || null;
    } catch { /* db busy/unavailable → env-only */ }
  }
  chatCache = { v: v ?? null, at: nowMs() };
  return chatCache.v;
}
async function tgSend(kind: "crit" | "recov", text: string) {
  const gapOk = nowMs() - lastTg[kind] >= TG_MIN_GAP_MS;
  if (!gapOk) return;
  const token = process.env.TELEGRAM_BOT_TOKEN ?? envFromDotenv("TELEGRAM_BOT_TOKEN");
  const chat = getChat();
  if (!token || !chat) { log("info", "tg-skipped", { reason: !token ? "no-token" : "no-chat" }); return; }
  lastTg[kind] = nowMs();
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    log("info", "tg-sent", { kind, http: r.status });
  } catch (e) { log("warn", "tg-failed", { kind, err: String(e).slice(0, 120) }); }
}

// ── probe + heal ─────────────────────────────────────────────────────────────
async function probe(cfg: SvcCfg): Promise<{ up: boolean; status: number | null; ms: number }> {
  const t0 = nowMs();
  try {
    const r = await fetch(cfg.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { "user-agent": "p0-watchdog/1.0" } });
    return { up: cfg.expect(r.status), status: r.status, ms: nowMs() - t0 };
  } catch {
    return { up: false, status: null, ms: nowMs() - t0 };
  }
}
function cooldownS(heals: number): number {
  return Math.min(COOLDOWN_BASE_S * Math.pow(2, Math.max(0, heals - 1)), COOLDOWN_MAX_S);
}

// ── v10.16 audit 4-C2: rolling-hour breaker + cross-layer heal ledger ──
// Audit finding: layer-1 had NO circuit breaker — a permanently broken service
// (e.g. Unknown-field boot failure) yielded an infinite spawn loop. ≥6 heals in
// one hour on the same service = chronic fault → spawns paused 30min (alert
// only). The heal stamp files are SHARED with layer-2 (scripts/watchdog.sh):
// whichever layer healed a service last owns a 300s window — no dueling spawns.
const BREAKER_MAX_PER_HOUR = 6;
const BREAKER_COOLDOWN_MS = 30 * 60 * 1000;
const CROSS_LAYER_GUARD_MS = 300 * 1000;
const breaker: Record<string, { times: number[]; openUntil: number }> = {};
const healStampPath = (key: string) => `${DIR}/heal-${key}`;
function readHealStamp(key: string): number {
  try { return (parseInt(readFileSync(healStampPath(key), "utf8").trim(), 10) || 0) * 1000; } catch { return 0; }
}
function writeHealStamp(key: string) {
  try { writeFileSync(healStampPath(key), String(Math.floor(nowMs() / 1000))); } catch { /* best-effort */ }
}
function heal(key: SvcKey, cfg: SvcCfg, st: SvcState) {
  const br = (breaker[key] ??= { times: [], openUntil: 0 });
  const now = nowMs();
  br.times = br.times.filter((t) => now - t < 3_600_000);
  if (br.times.length >= BREAKER_MAX_PER_HOUR) {
    br.openUntil = now + BREAKER_COOLDOWN_MS;
    st.breakerAnnounced = false;
    log("crit", "breaker-tripped", { healsLastHour: br.times.length, pausedMin: 30 }, key);
    void tgSend("crit", `🛡 <b>P0-WATCHDOG · BREAKER OPEN</b>\n<code>${cfg.label}</code>: ${br.times.length} heals/hour — chronic fault, spawns paused 30min\n${tehran()} IRST`);
    return;
  }
  br.times.push(now);
  st.breakerAnnounced = false;
  st.heals += 1;
  st.lastHealAt = nowMs();
  st.mode = st.heals >= ESCALATE_AFTER ? "escalated" : "healing";
  st.healingUntil = nowMs() + HEAL_GRACE_S * 1000;
  st.nextHealAllowedAt = nowMs() + cooldownS(st.heals) * 1000;
  log(st.mode === "escalated" ? "crit" : "warn", "heal-spawn", {
    attempt: st.heals, cooldownS: cooldownS(st.heals), cmd: cfg.healCmd.split("&& ")[1]?.slice(0, 80) ?? cfg.healCmd.slice(0, 80),
  }, key);
  if (st.mode === "escalated") {
    void tgSend("crit", `🛡 <b>P0-WATCHDOG · ESCALATED</b>\n<code>${cfg.label}</code> DOWN — ${st.heals} heal attempts failed\nlast HTTP: ${st.lastStatus ?? "unreachable"} · mem ${mem.availableMb ?? "?"}MB\n${tehran()} IRST`);
  }
  try { Bun.spawn(["bash", "-c", cfg.healCmd], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); }
  catch (e) { log("crit", "heal-spawn-error", { err: String(e).slice(0, 120) }, key); }
  writeHealStamp(key); // v10.16: announce to layer-2 (300s cross-layer guard)
}

async function tick() {
  ticks += 1;
  const paused = readPause();
  for (const key of Object.keys(SVCS) as SvcKey[]) {
    const cfg = SVCS[key], st = state[key];
    const r = await probe(cfg);
    st.lastProbeAt = nowMs(); st.lastStatus = r.status; st.lastLatencyMs = r.ms;

    if (r.up) {
      st.lastOkAt = nowMs();
      if (st.mode !== "ok") {
        const wasEsc = st.mode === "escalated";
        log("info", "recovered", { via: st.heals > 0 ? `heal#${st.heals}` : "self", downtimeFrom: st.lastDownAt ? tehran(st.lastDownAt) : null, http: r.status }, key);
        if (wasEsc) void tgSend("recov", `✅ <b>P0-WATCHDOG · RECOVERED</b>\n<code>${cfg.label}</code> back UP (HTTP ${r.status}) after ${st.heals} heal attempts\n${tehran()} IRST`);
        st.mode = "ok"; st.fails = 0; st.heals = 0; st.lastDownAt = null; st.healingUntil = null; st.nextHealAllowedAt = null;
        if (breaker[key]) { breaker[key].times = []; breaker[key].openUntil = 0; } // v10.16: reset breaker on recovery
        st.recoveries += 1;
      } else st.fails = 0;
      continue;
    }

    // down path
    if (st.mode === "ok" || st.mode === "init") { st.lastDownAt = nowMs(); st.mode = "degraded"; log("warn", "down", { http: r.status, paused }, key); }
    if (paused) { st.fails = 0; st.mode = st.mode === "escalated" ? "escalated" : "degraded"; continue; } // operator-driven window: never race it
    st.fails += 1;

    if (st.mode === "healing") {
      if (st.healingUntil && nowMs() > st.healingUntil) { st.mode = "degraded"; log("warn", "heal-grace-expired", { http: r.status }, key); }
      else continue; // inside boot window — give it air
    }
    if ((st.mode === "degraded" || st.mode === "escalated") && st.fails >= FAILS_TO_ACT) {
      // v10.16: breaker-open → alert-only; cross-layer stamp <300s → defer to layer-2
      const br = breaker[key] ?? { times: [], openUntil: 0 };
      const gate = Math.max(st.nextHealAllowedAt ?? 0, br.openUntil);
      if (nowMs() < br.openUntil) {
        if (!st.breakerAnnounced) {
          log("crit", "breaker-open", { healsLastHour: br.times.length }, key);
          st.breakerAnnounced = true;
        }
      } else if (nowMs() >= gate) {
        const otherLayer = readHealStamp(key);
        if (otherLayer && nowMs() - otherLayer < CROSS_LAYER_GUARD_MS) {
          log("info", "heal-deferred-cross-layer", { by: "watchdog.sh", agoS: Math.floor((nowMs() - otherLayer) / 1000) }, key);
        } else {
          heal(key, cfg, st);
        }
      }
    }
  }
  memCheck();
  persistState();
}

// ── control API :3020 ────────────────────────────────────────────────────────
function summary() {
  const s = Object.fromEntries((Object.keys(SVCS) as SvcKey[]).map((k) => [k, state[k].mode])) as Record<SvcKey, Mode>;
  return { ok: true, ver: VER, pid: process.pid, uptimeSec: Math.floor((nowMs() - BOOT) / 1000), tehran: tehran(), services: s, paused: pausedUntil > nowMs() / 1000, pausedUntil: pausedUntil || null, mem, ticks };
}
function recentActions(n: number) {
  try {
    return readFileSync(ACTIONS, "utf8").trim().split("\n").slice(-n).map((l) => { try { return JSON.parse(l); } catch { return l; } });
  } catch { return []; }
}

// ── control gate (task 4-b · audit P0-1) ─────────────────────────────────────
// NEXUS_CONTROL_KEY: process.env first, then .env (same pattern as the token
// above). Fail-closed when unset. Never echo/log the key value.
const CONTROL_KEY = process.env.NEXUS_CONTROL_KEY ?? envFromDotenv("NEXUS_CONTROL_KEY") ?? "";
function controlOk(req: Request): boolean {
  if (!CONTROL_KEY) return false; // fail-closed
  const provided = req.headers.get("x-nexus-key") ?? "";
  if (provided.length !== CONTROL_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ CONTROL_KEY.charCodeAt(i);
  return diff === 0; // constant-time
}
const CONTROL_401 = () =>
  Response.json({ ok: false, error: "unauthorized: mutating API requires x-nexus-key header" }, { status: 401, headers: { "cache-control": "no-store" } });

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return Response.json(summary());
  if (url.pathname === "/status") {
    return Response.json({ ...summary(), config: { tickMs: TICK_MS, failsToAct: FAILS_TO_ACT, cooldownBaseS: COOLDOWN_BASE_S, cooldownMaxS: COOLDOWN_MAX_S, escalateAfter: ESCALATE_AFTER, healGraceS: HEAL_GRACE_S, memWarnMb: MEM_WARN_MB, memCritMb: MEM_CRIT_MB }, servicesDetail: state, telegram: { armed: !!(getChat() && (process.env.TELEGRAM_BOT_TOKEN ?? envFromDotenv("TELEGRAM_BOT_TOKEN"))) }, recentActions: recentActions(40) });
  }
  if (url.pathname === "/probe-now" && req.method === "POST") {
    if (!controlOk(req)) return CONTROL_401(); // trigger endpoint (4-b)
    await tick();
    return Response.json({ ok: true, ranAt: new Date().toISOString(), ...summary() });
  }
  if (url.pathname === "/pause" && req.method === "POST") {
    if (!controlOk(req)) return CONTROL_401(); // trigger endpoint (4-b)
    const b = (await req.json().catch(() => ({}))) as { sec?: number };
    const sec = Math.max(10, Math.min(3600, Number(b.sec) || 180));
    writeFileSync(PAUSE, String(Math.floor(nowMs() / 1000) + sec));
    log("info", "paused", { sec });
    return Response.json({ ok: true, pausedFor: sec });
  }
  return new Response("p0-watchdog: 404\n", { status: 404 });
}

// ── boot ─────────────────────────────────────────────────────────────────────
mkdirSync(DIR, { recursive: true });
mkdirSync(`${ROOT}/logs`, { recursive: true });
if (!acquireLock()) process.exit(0);
try {
  Bun.serve({ port: PORT, fetch: handle });
} catch (e) {
  console.log(`[${tehran()}] port ${PORT} busy (duplicate watchdog?) — exiting: ${String(e).slice(0, 100)}`);
  process.exit(0);
}
log("info", "boot", { ver: VER, pid: process.pid, port: PORT });
console.log(`[${tehran()}] ${VER} armed on :${PORT} — app:3000 ws:3003 bridge:3005 liq:3010 trade:3011 sentinel:3030`);
persistState();

process.on("SIGTERM", () => { log("info", "shutdown", { sig: "SIGTERM" }); releaseLock(); process.exit(0); });
process.on("SIGINT", () => { log("info", "shutdown", { sig: "SIGINT" }); releaseLock(); process.exit(0); });
process.on("uncaughtException", (e) => { log("crit", "uncaught", { err: String(e).slice(0, 200) }); persistState(); process.exit(1); });

// bun --hot safety: a reload must never leave the previous interval running
// (globalThis survives hot reloads → new boot reaps the old timer)
const g = globalThis as typeof globalThis & { __p0wdTimer?: ReturnType<typeof setTimeout> };
setTimeout(() => {
  if (g.__p0wdTimer) clearInterval(g.__p0wdTimer);
  g.__p0wdTimer = setInterval(() => void tick(), TICK_MS);
  void tick();
}, BOOT_DELAY_MS);
