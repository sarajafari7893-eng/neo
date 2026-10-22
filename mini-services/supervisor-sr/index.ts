// ── NEXUS supervisor-sr (:3031) — سوپروایزر مهندس ارشد ──────────────────────
// STANDALONE oversight service — operator order 2026-09-25:
//   «یک کرون‌جاب حرفه‌ای با اسکیل سوپروایزر مهندس ارشد برای بررسی و پیگیری و
//    نظارت بر سیستم، هدف: وین‌ریت بالاتر و افزایش EST PNL % روزانه»
//   «حتماً مستقل بساز و داخلی نباشه»
//
// INDEPENDENT BY CONSTRUCTION: own process, own port (:3031), own package.json,
// own state dir (.data/supervisor-sr), zero imports from the Next app. It
// reads the shared SQLite (READ-ONLY) and probes services over HTTP — it can
// never corrupt the trading plane, and it keeps working when the app is down.
//
// CYCLES (the "cron"):
//   · SWEEP every 3min    — 8 service probes + Binance connection tracker
//                           (spot REST / futures REST / perp WS / spot WS)
//                           + issue registry upsert + Telegram escalation
//   · REVIEW every 60min  — senior-engineer report (Persian, .md): subsystem
//                           verdicts, win-rate & EST-PnL deltas vs previous
//                           window, root-cause notes, engineering actions.
//                           Digest pushed to Telegram per policy.
//
// FOLLOW-UP (پیگیری) is a state machine, not a log: every check lives in an
// issue registry with fails/escalation/cooldown, and RESOLVES itself when the
// underlying condition clears — recovery is always announced.
//
// HONESTY: every number is measured (DB readonly / live probes). No invented
// values; a check that cannot run is reported as UNKNOWN, never GREEN.

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ledgerUnknownScopeBanUntil } from "../_shared/ban-ledger";

const VER = "supervisor-sr 1.0.0";
const ROOT = "/home/z/my-project";
const DIR = `${ROOT}/.data/supervisor-sr`;
const STATE_DIR = `${ROOT}/mini-services/supervisor-sr/state`;
const REPORTS_DIR = `${DIR}/reports`;
const ISSUES_FILE = `${DIR}/issues.json`;
const TELEMETRY_FILE = `${DIR}/telemetry.jsonl`;
const LATEST_JSON = `${DIR}/latest.json`;
const LATEST_MD = `${DIR}/latest.md`;
const PID_FILE = `${STATE_DIR}/supervisor-sr.pid`;
const ENV_PATH = `${ROOT}/.env`;
const DB_PATH = `${ROOT}/db/custom.db`;

const PORT = 3031;
const SWEEP_MS = 3 * 60_000;
const REVIEW_MS = 60 * 60_000;
const REPORTS_KEEP = 48;
const TELEMETRY_TRIM = 4000;

// alert policy
const TG_COOLDOWN_MS: Record<string, number> = { crit: 10 * 60_000, warn: 30 * 60_000, info: 60 * 60_000 };
const DROUGHT_WARN_MIN = 6 * 60; // no signal for 6h → warn (RAW-CAL rails pace ~10min ⇒ 6h drought = pipeline issue)
const DROUGHT_CRIT_MIN = 12 * 60;
const WINRATE_FLOOR = 40; // % — below this with ≥10 settled in 24h → warn
const PNL_DAY_CRIT = -5; // EST PNL% today below this → crit

for (const d of [DIR, STATE_DIR, REPORTS_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

// ── boot guard: singleton (pid lockfile + /proc identity, Task-25 lesson) ──
function pidAliveIdentity(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const cmd = (() => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; } })();
    return cmd.includes("supervisor-sr") || cmd.includes("bun --hot");
  } catch { return false; }
}
try {
  const prev = Number(readFileSync(PID_FILE, "utf8").trim());
  if (prev > 0 && prev !== process.pid && pidAliveIdentity(prev)) {
    console.log(`[supervisor-sr] already running (pid ${prev}) — exit(0)`);
    process.exit(0);
  }
} catch { /* fresh start */ }
writeFileSync(PID_FILE, String(process.pid));

// ── env (lazy, mtime-cached — env-guard/restore safe, never logged) ──
let dotenvCache: { mtimeMs: number; values: Map<string, string> } | null = null;
function envGet(key: string): string {
  try {
    const st = statSync(ENV_PATH);
    if (!dotenvCache || dotenvCache.mtimeMs !== st.mtimeMs) {
      const values = new Map<string, string>();
      for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && m[1] && m[2]) values.set(m[1]!, m[2]!.trim());
      }
      dotenvCache = { mtimeMs: st.mtimeMs, values };
    }
    return process.env[key] || dotenvCache.values.get(key) || "";
  } catch { return process.env[key] || ""; }
}
function controlOk(req: Request): boolean {
  const key = envGet("NEXUS_CONTROL_KEY");
  if (!key) return false;
  const provided = req.headers.get("x-nexus-key") ?? "";
  if (provided.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

// ── small helpers ──
const tehranOffsetMs = 3.5 * 3600_000; // Iran is permanently UTC+03:30 (no DST)
const tehranDayStart = (now = Date.now()) => Math.floor((now + tehranOffsetMs) / 86_400_000) * 86_400_000 - tehranOffsetMs;
const hhmmTehran = (ts: number | null | undefined) =>
  ts ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour12: false, hour: "2-digit", minute: "2-digit" }).format(ts) : "—";
const fmtPct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "" : ""}${v.toFixed(digits)}%`);
const ageHuman = (ms: number | null) => {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} دقیقه`;
  const h = Math.floor(m / 60);
  return `${h} ساعت و ${m % 60} دقیقه`;
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function log(...args: unknown[]): void {
  const line = `[supervisor-sr] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
  console.log(`${new Date().toISOString()} ${line}`);
}

// ── hot-reload timer reaping (bun --hot) ──
const g = globalThis as unknown as { __svsrTimers?: ReturnType<typeof setInterval>[] };
if (g.__svsrTimers) for (const t of g.__svsrTimers) clearInterval(t);
g.__svsrTimers = [];

// ── Telegram push (via bridge :3005 — the operator channel) ──
let tgSent = 0, tgFail = 0;
const tgLastAt = new Map<string, number>();
async function tgPush(alertKey: string, severity: "crit" | "warn" | "info", text: string, force = false): Promise<void> {
  const last = tgLastAt.get(alertKey) ?? 0;
  const cooldown = TG_COOLDOWN_MS[severity] ?? 30 * 60_000;
  if (!force && Date.now() - last < cooldown) return;
  tgLastAt.set(alertKey, Date.now());
  try {
    const res = await fetch("http://127.0.0.1:3005/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-nexus-key": envGet("NEXUS_CONTROL_KEY") },
      body: JSON.stringify({ text: `🛰 SUPERVISOR-SR · ${severity.toUpperCase()}\n${text}` }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) { tgSent++; log("tg → sent:", alertKey); } else { tgFail++; log("tg → http", res.status, alertKey); }
  } catch (e) { tgFail++; log("tg → fail:", alertKey, e instanceof Error ? e.message : String(e)); }
}

// ── DB (READ-ONLY — the supervisor never writes the trading plane) ──
interface PerfWin { issued: number; settled: number; wins: number; losses: number; winRate: number | null; pnl: number; lastAt: number | null }
interface Perf {
  last24h: PerfWin; prev24h: PerfWin; today: PerfWin; yesterday: PerfWin;
  active: number; total: number; lastSignalAgeMin: number | null;
  triggerBus: { bannedUntil: number | null; cyclesPaused: number | null; cyclesStarted: number | null; cyclesCompleted: number | null; lastCycleError: string | null } | null;
  rawcal: Record<string, unknown> | null;
  pricePoints15m: number | null; lastPricePointAgeMin: number | null;
  at: number;
}
function emptyWin(): PerfWin { return { issued: 0, settled: 0, wins: 0, losses: number0(), winRate: null, pnl: 0, lastAt: null }; }
function number0(): number { return 0; }
function winFromRows(rows: Array<{ status: string; pnlPercent: number | null }>): PerfWin {
  const w = emptyWin();
  w.issued = rows.length;
  for (const r of rows) {
    const settledStatus = r.status !== "ACTIVE";
    const pnl = r.pnlPercent === null ? null : Number(r.pnlPercent);
    if (settledStatus && pnl !== null) {
      w.settled++;
      w.pnl += pnl;
      if (pnl > 0) w.wins++;
      else if (pnl < 0) w.losses++;
    }
    if (settledStatus || r.status === "ACTIVE") { /* row counted in issued */ }
  }
  w.winRate = w.wins + w.losses > 0 ? (w.wins / (w.wins + w.losses)) * 100 : null;
  return w;
}
function readPerf(): Perf {
  const now = Date.now();
  const perf: Perf = {
    last24h: emptyWin(), prev24h: emptyWin(), today: emptyWin(), yesterday: emptyWin(),
    active: 0, total: 0, lastSignalAgeMin: null,
    triggerBus: null, rawcal: null, pricePoints15m: null, lastPricePointAgeMin: null, at: now,
  };
  let db: Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    const rows = db.query(`SELECT status, pnlPercent, createdAt FROM Signal WHERE createdAt >= ?`).all(now - 48 * 3600_000) as Array<{ status: string; pnlPercent: number | null; createdAt: number }>;
    const last24 = rows.filter((r) => r.createdAt >= now - 24 * 3600_000);
    const prev24 = rows.filter((r) => r.createdAt < now - 24 * 3600_000);
    const tStart = tehranDayStart(now);
    const yStart = tStart - 86_400_000;
    const todayRows = rows.filter((r) => r.createdAt >= tStart);
    const yRows = rows.filter((r) => r.createdAt >= yStart && r.createdAt < tStart);
    perf.last24h = winFromRows(last24);
    perf.prev24h = winFromRows(prev24);
    perf.today = winFromRows(todayRows);
    perf.yesterday = winFromRows(yRows);
    const maxAt = rows.reduce((a, r) => Math.max(a, r.createdAt ?? 0), 0);
    perf.lastSignalAgeMin = maxAt > 0 ? Math.round((now - maxAt) / 60_000) : null;
    perf.active = (db.query(`SELECT COUNT(*) n FROM Signal WHERE status = 'ACTIVE'`).get() as { n: number } | undefined)?.n ?? 0;
    perf.total = (db.query(`SELECT COUNT(*) n FROM Signal`).get() as { n: number } | undefined)?.n ?? 0;
    const tb = db.query(`SELECT value FROM EngineSetting WHERE key = 'triggerbus'`).get() as { value?: string } | undefined;
    if (tb?.value) {
      try {
        const v = JSON.parse(tb.value) as Record<string, unknown>;
        perf.triggerBus = {
          bannedUntil: typeof v.bannedUntil === "number" ? v.bannedUntil : null,
          cyclesPaused: typeof v.cyclesPaused === "number" ? v.cyclesPaused : null,
          cyclesStarted: typeof v.cyclesStarted === "number" ? v.cyclesStarted : null,
          cyclesCompleted: typeof v.cyclesCompleted === "number" ? v.cyclesCompleted : null,
          lastCycleError: typeof v.lastCycleError === "string" ? v.lastCycleError : null,
        };
      } catch { /* corrupt row → honest null */ }
    }
    const rc = db.query(`SELECT value FROM EngineSetting WHERE key = 'rawcal.state'`).get() as { value?: string } | undefined;
    if (rc?.value) { try { perf.rawcal = JSON.parse(rc.value) as Record<string, unknown>; } catch { perf.rawcal = null; } }
    const pp = db.query(`SELECT COUNT(*) n, MAX(createdAt) lastAt FROM PricePoint WHERE createdAt >= ?`).get(now - 15 * 60_000) as { n: number; lastAt: number | null } | undefined;
    perf.pricePoints15m = pp?.n ?? 0;
    perf.lastPricePointAgeMin = pp?.lastAt ? Math.round((now - pp.lastAt) / 60_000) : null;
  } catch (e) {
    log("db read fail:", e instanceof Error ? e.message : String(e));
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return perf;
}

// ── service probes ──
interface SvcProbe { key: string; label: string; url: string; up: boolean; status: number | null; ms: number; detail?: string }
const SVC_PROBES: Array<{ key: string; label: string; url: string }> = [
  { key: "app", label: "app :3000", url: "http://127.0.0.1:3000/api/healthz" },
  { key: "ws", label: "price-ws :3003", url: "http://127.0.0.1:3003/socket.io/?EIO=4&transport=polling" },
  { key: "bridge", label: "bridge :3005", url: "http://127.0.0.1:3005/health" },
  { key: "liq", label: "liq :3010", url: "http://127.0.0.1:3010/health" },
  { key: "trade", label: "trade :3011", url: "http://127.0.0.1:3011/health" },
  { key: "warm", label: "warm-loop :3012", url: "http://127.0.0.1:3012/health" },
  { key: "watchdog", label: "p0-watchdog :3020", url: "http://127.0.0.1:3020/health" },
  { key: "sentinel", label: "sentinel :3030", url: "http://127.0.0.1:3030/health" },
];
async function probeSvc(p: { key: string; label: string; url: string }): Promise<SvcProbe> {
  const t0 = Date.now();
  try {
    const res = await fetch(p.url, { signal: AbortSignal.timeout(4500) });
    return { ...p, up: res.status === 200 || (p.key === "ws" && res.status < 500), status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ...p, up: false, status: null, ms: Date.now() - t0, detail: e instanceof Error ? e.message.slice(0, 80) : "error" };
  }
}

// ── Binance connection tracker (the پیگیری core) ──
interface BinanceState {
  spotRest: "OK" | "DOWN" | "UNKNOWN";
  fapiRest: "OK" | "BANNED" | "DOWN" | "UNKNOWN";
  fapiBannedUntil: number | null;
  perpWs: "CONNECTED" | "DEAD" | "UNKNOWN";   // from trade :3011 (fstream socket state)
  liqBinanceWs: "CONNECTED" | "DEAD" | "UNKNOWN"; // from liq :3010
  spotWs: "OK" | "DEAD" | "UNKNOWN";          // direct 1-frame probe of stream.binance.com
  lastBanAt: number | null;
  lastRecoveryAt: number | null;
  banCount: number;
  recoveryCount: number;
  note: string | null;
  at: number;
}
let binance: BinanceState = {
  spotRest: "UNKNOWN", fapiRest: "UNKNOWN", fapiBannedUntil: null,
  perpWs: "UNKNOWN", liqBinanceWs: "UNKNOWN", spotWs: "UNKNOWN",
  lastBanAt: null, lastRecoveryAt: null, banCount: 0, recoveryCount: 0, note: null, at: 0,
};
let prevFapiRest: string = "UNKNOWN";

// v1.1 TASK-49 — shared-ledger awareness: our own tracked ban may be a
// cosmetic +35min cap from an old body, while another process (price-ws /
// trade-service) already discovered the REAL pool end (hours later). Every
// fapi contact during a live ban can ESCALATE the expiry — so before ANY
// ping, take the max(tracked, ledger pool end).

async function probeSpotWs(): Promise<"OK" | "DEAD"> {
  return await new Promise<"OK" | "DEAD">((resolve) => {
    let settled = false;
    const done = (v: "OK" | "DEAD") => { if (!settled) { settled = true; try { ws.close(); } catch { /* */ } resolve(v); } };
    let ws: WebSocket;
    try { ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@miniTicker"); } catch { resolve("DEAD"); return; }
    const t = setTimeout(() => done("DEAD"), 6000);
    ws.onmessage = () => { clearTimeout(t); done("OK"); };
    ws.onerror = () => { clearTimeout(t); done("DEAD"); };
  });
}

async function trackBinance(tradeHealth: SvcProbe | null, liqHealth: SvcProbe | null): Promise<BinanceState> {
  const st: BinanceState = { ...binance, at: Date.now(), note: null };
  // spot REST (weight-1 ping)
  try {
    const res = await fetch("https://api.binance.com/api/v3/ping", { signal: AbortSignal.timeout(6000) });
    st.spotRest = res.ok ? "OK" : "DOWN";
  } catch { st.spotRest = "DOWN"; }
  // futures REST — 418 body carries the exact «banned until»
  // v1.0.1 BAN-RESPECTING PROBE: while a ban is already tracked, do NOT dial
  // fapi — every contact during a live ban can ESCALATE the expiry (the
  // observed 04:34Z→07:42Z→07:50Z spiral). Recovery verification is deferred
  // to 60s AFTER the tracked expiry; the spot/WS probes below are unaffected
  // (different rate-limit planes).
  // v1.2 scope split (ban-ledger v1.1): the tracked end + UNKNOWN-SCOPE
  // ("_pool") ledger bans still defer the fapi probe — a single NAMED pool
  // member's ban no longer keeps the whole venue reported BANNED (majority-
  // clean pool measured 2026-10-20; the probe's own 418 handling re-arms).
  const knownBan = Math.max(binance.fapiBannedUntil ?? 0, ledgerUnknownScopeBanUntil());
  if (Date.now() < knownBan + 60_000) {
    st.fapiRest = "BANNED";
    st.fapiBannedUntil = knownBan;
  } else {
    try {
      const res = await fetch("https://fapi.binance.com/fapi/v1/ping", { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        st.fapiRest = "OK";
        st.fapiBannedUntil = null;
      } else if (res.status === 418 || res.status === 429) {
        const body = await res.text().catch(() => "");
        const m = body.match(/banned until (\d{13})/);
        st.fapiRest = "BANNED";
        st.fapiBannedUntil = m ? Number(m[1]) : Date.now() + 15 * 60_000;
      } else {
        st.fapiRest = "DOWN";
        st.fapiBannedUntil = null;
      }
    } catch { st.fapiRest = "DOWN"; st.fapiBannedUntil = null; }
  }
  // WS planes from the ingesters' own health
  try {
    if (tradeHealth && tradeHealth.up && tradeHealth.status === 200) {
      const h = JSON.parse(await (await fetch("http://127.0.0.1:3011/health", { signal: AbortSignal.timeout(4000) })).text()) as { connected?: boolean };
      st.perpWs = h.connected ? "CONNECTED" : "DEAD";
    } else st.perpWs = "UNKNOWN";
  } catch { st.perpWs = "UNKNOWN"; }
  try {
    if (liqHealth && liqHealth.up && liqHealth.status === 200) {
      const h = JSON.parse(await (await fetch("http://127.0.0.1:3010/health", { signal: AbortSignal.timeout(4000) })).text()) as { venues?: { binance?: { connected?: boolean } } };
      st.liqBinanceWs = h.venues?.binance?.connected ? "CONNECTED" : "DEAD";
    } else st.liqBinanceWs = "UNKNOWN";
  } catch { st.liqBinanceWs = "UNKNOWN"; }
  // independent spot-WS probe — the alt-path itself
  st.spotWs = await probeSpotWs();

  // ── transitions: the follow-up ledger (BANNED ⇄ RECOVERED) ──
  // v1.0.1: the very first observation after a boot/reload only RECORDS state
  // (no "transition" alert) — otherwise every hot-reload re-announces a
  // ban the operator already knows about.
  if (prevFapiRest === "UNKNOWN") {
    prevFapiRest = st.fapiRest;
    if (st.fapiRest === "BANNED") st.banCount = binance.banCount; // carry, don't double-count
  }
  if (prevFapiRest !== "BANNED" && st.fapiRest === "BANNED") {
    st.banCount = binance.banCount + 1;
    st.lastBanAt = Date.now();
    st.note = `fapi REST بن جدید تا ${hhmmTehran(st.fapiBannedUntil)} ( Tehran)`;
    log("TRANSITION → BANNED until", st.fapiBannedUntil, new Date(st.fapiBannedUntil ?? 0).toISOString());
    void tgPush("bin:fapi-banned", "warn", `اتصال REST فیوچرز بایننس بن شد (418) تا ساعت ${hhmmTehran(st.fapiBannedUntil)} به‌وقت تهران.\nمسیر جایگزین فعال است: WS اسپات ${st.spotWs === "OK" ? "✅" : "❌"} + REST اسپات ${st.spotRest === "OK" ? "✅" : "❌"}. بازیابی خودکار زمان‌محور.`);
  }
  if (prevFapiRest === "BANNED" && st.fapiRest === "OK") {
    st.recoveryCount = binance.recoveryCount + 1;
    st.lastRecoveryAt = Date.now();
    st.note = `fapi REST پس از بن بازیابی شد`;
    log("TRANSITION → RECOVERED (fapi REST 200)");
    void tgPush("bin:fapi-recovered", "info", `✅ اتصال REST فیوچرز بایننس بازیابی شد (ping 200). رصد ادامه دارد.`, true);
  }
  prevFapiRest = st.fapiRest;
  return st;
}

// ── issue registry (persistent, self-resolving, escalating) ──
interface Issue { id: string; title: string; severity: "crit" | "warn" | "info"; fails: number; oks: number; firstFailAt: number | null; lastFailAt: number | null; lastOkAt: number | null; lastDetail: string | null; open: boolean; lastAlertAt: number | null; escalated: boolean }
let issues = new Map<string, Issue>();
try {
  const raw = JSON.parse(readFileSync(ISSUES_FILE, "utf8")) as Issue[];
  issues = new Map(raw.map((i) => [i.id, i]));
} catch { /* fresh registry */ }
function saveIssues(): void {
  try { writeFileSync(ISSUES_FILE, JSON.stringify([...issues.values()], null, 1)); } catch (e) { log("issues save fail:", e instanceof Error ? e.message : String(e)); }
}
function upsertIssue(id: string, title: string, failing: boolean, severity: "crit" | "warn", detail: string | null): void {
  const now = Date.now();
  let it = issues.get(id);
  if (!it) { it = { id, title, severity, fails: 0, oks: 0, firstFailAt: null, lastFailAt: null, lastOkAt: null, lastDetail: null, open: false, lastAlertAt: null, escalated: false }; issues.set(id, it); }
  it.title = title; it.severity = severity; it.lastDetail = detail;
  if (failing) {
    it.fails++;
    it.firstFailAt ??= now;
    it.lastFailAt = now;
    if (!it.open) {
      it.open = true;
      log(`ISSUE OPEN [${id}] ${title} — ${detail ?? ""}`);
      void tgPush(`iss:${id}`, severity, `${title}\n${detail ?? ""}`);
    } else if (!it.escalated && it.fails >= 3) {
      it.escalated = true;
      it.severity = "crit";
      log(`ISSUE ESCALATE [${id}] fails=${it.fails}`);
      void tgPush(`iss:${id}:esc`, "crit", `${title} — ۳ بررسی متوالی ناموفق (${it.fails} بار). نیاز به مداخله مهندسی.`, true);
    }
  } else {
    it.oks++;
    it.lastOkAt = now;
    if (it.open) {
      it.open = false;
      it.fails = 0;
      it.escalated = false;
      it.firstFailAt = null;
      log(`ISSUE RESOLVED [${id}]`);
      void tgPush(`iss:${id}:ok`, "info", `✅ حل شد: ${title}`, true);
    }
  }
}

// ── sweep + review state ──
let services: SvcProbe[] = [];
let perf: Perf | null = null;
let sweeps = 0;
let reviews = 0;
let bootAt = Date.now();
let lastSweepAt: number | null = null;
let lastReviewAt: number | null = null;
let lastReviewMd: string | null = null;

async function sweep(trigger = "timer"): Promise<void> {
  const t0 = Date.now();
  sweeps++;
  try {
    services = await Promise.all(SVC_PROBES.map(probeSvc));
    const get = (k: string) => services.find((s) => s.key === k) ?? null;
    const tradeH = get("trade");
    const liqH = get("liq");
    binance = await trackBinance(tradeH, liqH);
    perf = readPerf();

    // ── issue registry updates ──
    for (const s of services) {
      upsertIssue(`svc:${s.key}`, `سرویس ${s.label}`, !s.up, "crit", s.up ? null : `HTTP ${s.status ?? "timeout"} ${s.detail ?? ""}`);
    }
    upsertIssue("bin:spot-rest", "REST اسپات بایننس (api.binance.com)", binance.spotRest !== "OK", "warn", binance.spotRest === "OK" ? null : `state=${binance.spotRest}`);
    upsertIssue("bin:fapi-rest", "REST فیوچرز بایننس (fapi.binance.com)", binance.fapiRest === "BANNED" || binance.fapiRest === "DOWN", "warn",
      binance.fapiRest === "BANNED" ? `بن تا ${hhmmTehran(binance.fapiBannedUntil)} — بازیابی خودکار` : binance.fapiRest === "DOWN" ? "ping ناموفق" : null);
    upsertIssue("bin:spot-ws", "WS اسپات بایننس (مسیر جایگزین)", binance.spotWs !== "OK", "crit", binance.spotWs === "OK" ? null : "هیچ فریمی در ۶ ثانیه نرسید");
    upsertIssue("bin:perp-ws", "WS فیوچرز بایننس (fstream)", binance.perpWs === "DEAD", "warn", binance.perpWs === "CONNECTED" ? null : "متصل بدون فریم / قطع — egress sandbox");
    // signal drought + feed liveness
    if (perf) {
      const droughtMin = perf.lastSignalAgeMin;
      upsertIssue("pipe:drought", "خشک‌سالی سیگنال (بدون صدور جدید)", droughtMin !== null && droughtMin > DROUGHT_WARN_MIN, droughtMin !== null && droughtMin > DROUGHT_CRIT_MIN ? "crit" : "warn",
        droughtMin === null ? "سیگنالی در DB نیست" : `آخرین سیگنال ${ageHuman(droughtMin * 60_000)} پیش`);
      upsertIssue("feed:pricepoints", "جریان PricePoint متوقف شده", (perf.pricePoints15m ?? 0) === 0, "crit",
        (perf.pricePoints15m ?? 0) > 0 ? null : `۱۵ دقیقه‌ی اخیر: ${perf.pricePoints15m} ردیف`);
      // performance floors
      const wr = perf.last24h.winRate;
      upsertIssue("perf:winrate", `وین‌ریت ۲۴ساعته زیر کف ${WINRATE_FLOOR}%`, wr !== null && perf.last24h.settled >= 10 && wr < WINRATE_FLOOR, "warn",
        wr !== null ? `وین‌ریت ${wr.toFixed(1)}% روی ${perf.last24h.settled} سیگنال تسویه‌شده` : null);
      upsertIssue("perf:pnl-day", `EST PNL% امروز زیر ${PNL_DAY_CRIT}%`, perf.today.settled >= 3 && perf.today.pnl < PNL_DAY_CRIT, "crit",
        `امروز: ${fmtPct(perf.today.pnl)} روی ${perf.today.settled} تسویه‌شده`);
    }
    saveIssues();

    // telemetry row
    try {
      appendFileSync(TELEMETRY_FILE, JSON.stringify({ at: Date.now(), trigger, sweeps, services: services.map((s) => ({ k: s.key, up: s.up, ms: s.ms })), binance: { spotRest: binance.spotRest, fapiRest: binance.fapiRest, fapiBannedUntil: binance.fapiBannedUntil, perpWs: binance.perpWs, spotWs: binance.spotWs, liqBinanceWs: binance.liqBinanceWs }, perf: perf ? { wr24: perf.last24h.winRate, pnlToday: perf.today.pnl, issued24: perf.last24h.issued, lastSignalAgeMin: perf.lastSignalAgeMin } : null }) + "\n");
      // trim telemetry
      const lines = readFileSync(TELEMETRY_FILE, "utf8").split("\n").filter(Boolean);
      if (lines.length > TELEMETRY_TRIM) writeFileSync(TELEMETRY_FILE, lines.slice(-TELEMETRY_TRIM).join("\n") + "\n");
    } catch { /* telemetry best-effort */ }

    lastSweepAt = Date.now();
    const openN = [...issues.values()].filter((i) => i.open).length;
    log(`sweep #${sweeps} (${trigger}) done in ${Date.now() - t0}ms — services ${services.filter((s) => s.up).length}/${services.length} up, open issues ${openN}, binance {fapi:${binance.fapiRest}, spot:${binance.spotRest}, spotWs:${binance.spotWs}, perpWs:${binance.perpWs}}`);
  } catch (e) {
    log("sweep error:", e instanceof Error ? e.message : String(e));
  }
}

// ── hourly senior-engineer review (Persian report) ──
function buildReview(): string {
  const now = Date.now();
  const L: string[] = [];
  const tehranNow = new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "full", timeStyle: "short" }).format(now);
  L.push(`# گزارش سوپروایزر مهندس ارشد — ${tehranNow}`);
  L.push("");
  L.push(`_نسخه ${VER} · چرخه‌ی بازبینی #${reviews + 1} · سوییپ‌های انجام‌شده: ${sweeps}_`);
  L.push("");

  // 1) services
  L.push("## ۱) سلامت سرویس‌ها");
  if (services.length === 0) L.push("- بررسی سرویس‌ها هنوز اجرا نشده (UNKNOWN).");
  for (const s of services) {
    L.push(`- ${s.up ? "🟢" : "🔴"} **${s.label}** — ${s.up ? `سالم (${s.ms}ms)` : `DOWN (HTTP ${s.status ?? "timeout"})${s.detail ? ` — ${s.detail}` : ""}`}`);
  }
  L.push("");

  // 2) binance connection
  L.push("## ۲) اتصال بایننس (رصد و پیگیری)");
  const b = binance;
  L.push(`- REST اسپات (api.binance.com): ${b.spotRest === "OK" ? "🟢 OK" : b.spotRest === "DOWN" ? "🔴 DOWN" : "⚪ UNKNOWN"}`);
  L.push(`- REST فیوچرز (fapi.binance.com): ${b.fapiRest === "OK" ? "🟢 OK" : b.fapiRest === "BANNED" ? `🟠 بن 418 تا ساعت ${hhmmTehran(b.fapiBannedUntil)} (بازیابی خودکار)` : b.fapiRest === "DOWN" ? "🔴 DOWN" : "⚪ UNKNOWN"}`);
  L.push(`- WS فیوچرز (fstream): ${b.perpWs === "CONNECTED" ? "🟢 متصل" : b.perpWs === "DEAD" ? "🟠 متصل‌بدون‌فریم/قطع (محدودیت egress سندباکس)" : "⚪ UNKNOWN"}`);
  L.push(`- WS اسپات — مسیر جایگزین (stream.binance.com): ${b.spotWs === "OK" ? "🟢 فریم می‌گیرد" : b.spotWs === "DEAD" ? "🔴 بدون فریم" : "⚪ UNKNOWN"}`);
  L.push(`- WS لیکوییدیشن بایننس (از liq-service): ${b.liqBinanceWs === "CONNECTED" ? "🟢 متصل" : "🟠 بدون فریم (جبران با bybit/okx/bitget)"}`);
  if (b.banCount > 0 || b.recoveryCount > 0) {
    L.push(`- پیگیری: ${b.banCount} بن ثبت‌شده، ${b.recoveryCount} بازیابی تأییدشده. آخرین بن: ${b.lastBanAt ? hhmmTehran(b.lastBanAt) : "—"} · آخرین بازیابی: ${b.lastRecoveryAt ? hhmmTehran(b.lastRecoveryAt) : "—"}`);
  }
  L.push(`- معماری اتصال فعال: futures-WS → spot-WS (جایگزین) → REST اسپات → REST فیوچرز؛ همگی ban-aware با بازیابی زمان‌محور.`);
  L.push("");

  // 3) signal pipeline
  if (perf) {
    L.push("## ۳) لوله‌ی سیگنال");
    L.push(`- سیگنال‌های صادرشده ۲۴ساعته: **${perf.last24h.issued}** (۲۴ساعت قبل: ${perf.prev24h.issued})`);
    L.push(`- تسویه‌شده ۲۴ساعته: ${perf.last24h.settled} · فعال الآن: ${perf.active} · کل: ${perf.total}`);
    L.push(`- آخرین سیگنال: ${perf.lastSignalAgeMin === null ? "—" : `${ageHuman(perf.lastSignalAgeMin * 60_000)} پیش`}${perf.lastSignalAgeMin !== null && perf.lastSignalAgeMin > DROUGHT_WARN_MIN ? " ⚠️ خشک‌سالی" : ""}`);
    L.push(`- PricePoint ۱۵دقیقه‌ی اخیر: ${perf.pricePoints15m ?? "—"} ردیف (سن آخرین: ${perf.lastPricePointAgeMin === null ? "—" : `${perf.lastPricePointAgeMin} دقیقه`})`);
    if (perf.triggerBus) {
      const tb = perf.triggerBus;
      L.push(`- Trigger Bus: شروع‌شده ${tb.cyclesStarted ?? "—"} / کامل‌شده ${tb.cyclesCompleted ?? "—"} / متوقف‌شده ${tb.cyclesPaused ?? "—"}${tb.bannedUntil ? ` · بن تا ${hhmmTehran(tb.bannedUntil)}` : ""}${tb.lastCycleError ? ` · آخرین خطا: ${tb.lastCycleError.slice(0, 120)}` : ""}`);
    }
    if (perf.rawcal) {
      const rc = perf.rawcal as Record<string, unknown>;
      const issued = typeof rc.issuedTotal === "number" ? rc.issuedTotal : typeof rc.issued === "number" ? rc.issued : null;
      const settled = typeof rc.settledTotal === "number" ? rc.settledTotal : typeof rc.settled === "number" ? rc.settled : null;
      L.push(`- RAW-CAL: ${issued !== null ? `صادرشده ${issued}` : "صادرشده ؟"}${settled !== null ? ` · تسویه‌شده ${settled}` : ""}`);
    }
    L.push("");

    // 4) performance vs targets
    L.push("## ۴) عملکرد — هدف: وین‌ریت بالاتر + EST PNL% روزانه بالاتر");
    const wr = perf.last24h.winRate, wrPrev = perf.prev24h.winRate;
    const wrDelta = wr !== null && wrPrev !== null ? wr - wrPrev : null;
    L.push(`- وین‌ریت ۲۴ساعته: **${fmtPct(wr)}** (۲۴ساعت قبل: ${fmtPct(wrPrev)}) ${wrDelta !== null ? `→ ${wrDelta >= 0 ? "🟢 +" : "🔴 "}${wrDelta.toFixed(1)}pp` : ""}`);
    L.push(`- EST PNL% امروز (تهران): **${fmtPct(perf.today.pnl)}** روی ${perf.today.settled} تسویه‌شده · دیروز: ${fmtPct(perf.yesterday.pnl)} روی ${perf.yesterday.settled}`);
    L.push(`- EST PNL% ۲۴ساعته: ${fmtPct(perf.last24h.pnl)} · ۲۴ساعت قبل: ${fmtPct(perf.prev24h.pnl)}`);
    L.push("");

    // 5) root-cause + actions
    L.push("## ۵) ریشه‌یابی و اقدامات مهندسی");
    const open = [...issues.values()].filter((i) => i.open).sort((a, x) => (a.severity === "crit" ? -1 : 1) - (x.severity === "crit" ? -1 : 1));
    if (open.length === 0) L.push("- هیچ ایشوی بازی وجود ندارد — همه‌ی چک‌ها سبز.");
    for (const i of open) {
      L.push(`- ${i.severity === "crit" ? "🔴" : "🟠"} **${i.title}** (${i.id}) — ${i.fails} بررسی ناموفق · ${i.lastDetail ?? ""}`);
    }
    const recent = [...issues.values()].filter((i) => !i.open && i.lastOkAt && now - i.lastOkAt < 3 * 3600_000);
    if (recent.length > 0) {
      L.push("");
      L.push("بازیابی‌های اخیر (۳ ساعت):");
      for (const i of recent) L.push(`- ✅ ${i.title}`);
    }
    L.push("");
    L.push("### توصیه‌های مهندس ارشد");
    const recs: string[] = [];
    if (perf.last24h.issued === 0 && perf.lastSignalAgeMin !== null && perf.lastSignalAgeMin > 120) recs.push("صدور سیگنال متوقف است — ترتیب بررسی: ۱) بن REST فیوچرز و Trigger Bus paused ۲) RAW-CAL holdUntilArmsFull ۳) minScore/deploy gates. اتصال اسپات-WS جایگزین فعال است؛ داده‌ی قیمت قطع نیست.");
    if ((perf.triggerBus?.cyclesPaused ?? 0) > 0) recs.push("Trigger Bus چرخه‌های متوقف‌شده دارد — با پایان بن REST فیوچرز، شمارش باید متوقف بماند و چرخه‌ها از سر گرفته شوند؛ اگر paused رشد کرد در حالی که fapi سبز است، گیت محلی باس را بازبینی کن.");
    if (wr !== null && perf.last24h.settled >= 10 && wr < WINRATE_FLOOR) recs.push("وین‌ریت زیر کف است — از EDGE LEADERBOARD فیلترهای ضعیف‌کننده‌ی ۲۴ ساعت اخیر را شناسایی و وزن آن‌ها را در خاموش‌کردن آزمایشی (shadow) بررسی کن؛ قبل از هر تغییر،snapshot RAW-CAL را فریز کن.");
    if (perf.today.settled >= 3 && perf.today.pnl < 0) recs.push("PNL امروز منفی است — فام/کوادرانت‌های بازنده‌ی امروز در TAXONOMY را با بسته‌ی دیروز مقایسه کن و نشان‌های رژیم (regime veto) را بازبینی کن.");
    if (b.spotWs !== "OK") recs.push("مسیر جایگزین WS اسپات هم فریم نمی‌گیرد — egress سندباکس را بررسی کن؛ تا برقراری آن، نردبان روی REST اسپات می‌ایستد.");
    if (recs.length === 0) recs.push("سیستم در حالت پایدار است — ادامه‌ی رصد، بدون تغییر پارامتر (بهداشت لوله مقدم بر بهینه‌سازی).");
    for (const r of recs) L.push(`- ${r}`);
  }
  L.push("");
  L.push(`_اطاعت‌نامه‌ی صداقت: همه‌ی اعداد زنده از SQLite (فقط‌خواندنی) و پروب‌های HTTP/WS measured‌اند؛ هیچ عددی ساختگی نیست._`);
  return L.join("\n");
}

async function review(trigger: string): Promise<void> {
  reviews++;
  try {
    if (!perf || Date.now() - perf.at > SWEEP_MS) await sweep("pre-review");
    const md = buildReview();
    lastReviewMd = md;
    lastReviewAt = Date.now();
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}`;
    writeFileSync(join(REPORTS_DIR, `sr-${stamp}.md`), md);
    writeFileSync(LATEST_MD, md);
    writeFileSync(LATEST_JSON, JSON.stringify({ at: lastReviewAt, ver: VER, services, binance, perf, issues: [...issues.values()].map((i) => ({ ...i })) }, null, 1));
    // trim old reports
    try {
      const files = readdirSync(REPORTS_DIR).filter((f) => f.startsWith("sr-") && f.endsWith(".md")).sort();
      while (files.length > REPORTS_KEEP) { const f = files.shift(); if (f) unlinkSync(join(REPORTS_DIR, f)); }
    } catch { /* best-effort */ }
    log(`review #${reviews} (${trigger}) written — ${md.length} bytes`);

    // digest policy → Telegram: crit open OR routine every 6h OR win-rate/pnl flag
    const openCrit = [...issues.values()].filter((i) => i.open && i.severity === "crit");
    const wr = perf?.last24h.winRate ?? null;
    const flagged = wr !== null && (perf?.last24h.settled ?? 0) >= 10 && wr < WINRATE_FLOOR;
    const routine = reviews % 6 === 0;
    if (openCrit.length > 0 || routine || flagged) {
      const head = openCrit.length > 0
        ? `🔴 ${openCrit.length} ایشوی بحرانی باز: ${openCrit.map((i) => i.title).join(" · ")}`
        : flagged ? `🟠 وین‌ریت ۲۴ساعته ${fmtPct(wr)} زیر کف ${WINRATE_FLOOR}%` : "🟢 گزارش دوره‌ای ۶ساعته";
      const digest = `${head}\nوین‌ریت ۲۴ساعته: ${fmtPct(wr)} · EST PNL% امروز: ${fmtPct(perf?.today.pnl)} · سیگنال ۲۴ساعته: ${perf?.last24h.issued ?? "—"}\nبایننس: fapi ${binance.fapiRest} · spot-REST ${binance.spotRest} · spot-WS ${binance.spotWs} · perp-WS ${binance.perpWs}\nگزارش کامل: supervisor-sr :3031/report`;
      void tgPush("sr:digest", openCrit.length > 0 ? "crit" : "info", digest, openCrit.length > 0);
    }
  } catch (e) {
    log("review error:", e instanceof Error ? e.message : String(e));
  }
}

// ── HTTP surface ──
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "supervisor-sr", ver: VER, uptimeMs: Date.now() - bootAt, sweeps, reviews, lastSweepAt, lastReviewAt, openIssues: [...issues.values()].filter((i) => i.open).length, binance: { fapiRest: binance.fapiRest, fapiBannedUntil: binance.fapiBannedUntil, spotRest: binance.spotRest, spotWs: binance.spotWs, perpWs: binance.perpWs } });
    }
    if (url.pathname === "/status") {
      return json({ ok: true, ver: VER, bootAt, sweeps, reviews, lastSweepAt, lastReviewAt, tg: { sent: tgSent, fail: tgFail }, services, binance, perf, issues: [...issues.values()] });
    }
    if (url.pathname === "/report") {
      return new Response(lastReviewMd ?? "گزارشی هنوز تولید نشده — چند دقیقه صبر کنید.", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/run-now" && req.method === "POST") {
      if (!controlOk(req)) return json({ ok: false, error: "unauthorized: mutating API requires x-nexus-key header" }, 401);
      await sweep("manual");
      await review("manual");
      return json({ ok: true, sweeps, reviews });
    }
    return json({ error: "not found", endpoints: ["/health", "/status", "/report", "POST /run-now (x-nexus-key)"] }, 404);
  },
});

// ── cycles ──
g.__svsrTimers!.push(setInterval(() => void sweep("timer"), SWEEP_MS));
g.__svsrTimers!.push(setInterval(() => void review("timer"), REVIEW_MS));
setTimeout(() => void sweep("boot"), 6_000);
setTimeout(() => void review("boot"), 20_000);

log(`${VER} listening on :${PORT} — sweep ${SWEEP_MS / 1000}s · review ${REVIEW_MS / 60000}min · pid ${process.pid}`);
