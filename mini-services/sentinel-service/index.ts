// ── NEXUS//SIGNALS — SENTINEL SERVICE v1.0.0 (:3030) ────────────────────────
// Born from operator order 2026-09-21: «ساخت یک ایجنت با اسکیل مهندسی شده برای
// نظارت بر عملکرد سیستم با قابلیت جستجوی عمیق و اهداف و ماموریت‌های هدفمند»
//
// WHAT IT IS
//   The system's own deep-monitoring agent service. Layer-1 (p0-watchdog :3020)
//   heals fast; THIS layer watches everything the healer cannot judge:
//     · all 6 services (app/ws/bridge/liq/trade/watchdog) with latency
//     · memory + dual-disk (rootfs + PolarFS /tmp) headroom
//     · SQLite vitals: row growth, event velocity, engine-liveness (last event age)
//     · backup ring freshness on PolarFS + AUTONOMOUS 3h snapshot scheduling
//       (in-repo IaC — audit P1-8: cold start no longer depends on platform cron)
//     · shadow-veto arms fill/starvation (audit P1-7 follow-up visibility)
//     · RAWCAL run state + heartbeat staleness
//     · dev.log forensics (errors, OOM, ENOSPC, 500s, SETTLEMENT STALLED)
//     · p0-watchdog state.json cross-read (degraded/healing/escalated detection)
//   …and compresses all of it into ONE verdict: GREEN / AMBER / RED.
//
// CONTRACT
//   • telemetry tick 60s → .data/sentinel/latest.json + telemetry.jsonl (rotated)
//   • deep report every 30min → .data/sentinel/reports/ (keep 48)
//   • backup duty: ring's newest .enc older than 3h10m → spawn scripts/backup.sh
//     (pid-liveness lock, Telegram alert on failure — never two at once)
//   • verdict edge → Telegram (rate-limited 1/30min), fully fail-silent
//   • GET /health (liveness, open) · GET /report · GET /history?n=
//     POST /run-now + POST /backup-now → require x-nexus-key (fail-closed, P0-1)
//   • the service NEVER heals, NEVER kills, NEVER writes to the trading domain —
//     observe, judge, alert, and schedule backups. Nothing else.
// ─────────────────────────────────────────────────────────────────────────────
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";

const VER = "nexus-sentinel 1.0.0";
const ROOT = "/home/z/my-project";
const DIR = `${ROOT}/.data/sentinel`;
const RING = "/tmp/my-project/backups"; // backup.sh v3.4 canonical ring (PolarFS)
const PORT = 3030;
const TICK_MS = 60_000;
const DEEP_EVERY_MS = 30 * 60_000;
const BACKUP_EVERY_MS = 3 * 3600_000;
const BACKUP_GRACE_MS = 10 * 60_000; // 3h cycle + 10m grace before "missed"
const BACKUP_STALE_ALERT_MS = 7 * 3600_000; // >2 missed cycles → RED
const LOG_KEEP_BYTES = 512_000;
const REPORTS_KEEP = 48;

type Verdict = "GREEN" | "AMBER" | "RED";
interface Anomaly { sev: "warn" | "crit"; area: string; msg: string }

const nowMs = () => Date.now();
const tehran = (d: number | Date = nowMs()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);
const BOOT = nowMs();

// ── service probes ───────────────────────────────────────────────────────────
const SERVICES: { key: string; label: string; url: string; expect: (s: number) => boolean }[] = [
  { key: "app", label: "app :3000", url: "http://127.0.0.1:3000/api/healthz", expect: (s) => s === 200 },
  { key: "ws", label: "price-ws :3003", url: "http://127.0.0.1:3003/", expect: (s) => s < 500 },
  { key: "bridge", label: "telegram-bridge :3005", url: "http://127.0.0.1:3005/health", expect: (s) => s === 200 },
  { key: "liq", label: "liq :3010", url: "http://127.0.0.1:3010/health", expect: (s) => s === 200 },
  { key: "trade", label: "trade :3011", url: "http://127.0.0.1:3011/health", expect: (s) => s === 200 },
  { key: "watchdog", label: "p0-watchdog :3020", url: "http://127.0.0.1:3020/health", expect: (s) => s === 200 },
];
async function probeSvc(s: (typeof SERVICES)[number]) {
  const t0 = nowMs();
  try {
    const r = await fetch(s.url, { signal: AbortSignal.timeout(4000), headers: { "user-agent": "nexus-sentinel/1.0" } });
    return { key: s.key, label: s.label, up: s.expect(r.status), status: r.status, ms: nowMs() - t0 };
  } catch {
    return { key: s.key, label: s.label, up: false, status: null as number | null, ms: nowMs() - t0 };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function envFromDotenv(key: string): string | null {
  try {
    const m = readFileSync(`${ROOT}/.env`, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? (m[1].trim().replace(/^["']|["']$/g, "") || null) : null;
  } catch { return null; }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function humanAge(ms: number | null): string {
  if (ms === null) return "never";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `+${m % 60}m` : ""}`;
}
async function tailFile(p: string, bytes: number): Promise<string> {
  try {
    const sz = statSync(p).size;
    const fh = Bun.file(p);
    const start = Math.max(0, sz - bytes);
    return await fh.slice(start).text();
  } catch { return ""; }
}

// ── telegram (fail-silent, rate-limited) ─────────────────────────────────────
let lastTg: Record<string, number> = {};
const TG_MIN_GAP_MS = 30 * 60_000;
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
    } catch { /* db busy → env-only */ }
  }
  chatCache = { v: v ?? null, at: nowMs() };
  return chatCache.v;
}
async function tgSend(kind: string, text: string) {
  if (nowMs() - (lastTg[kind] ?? 0) < TG_MIN_GAP_MS) return;
  const token = process.env.TELEGRAM_BOT_TOKEN ?? envFromDotenv("TELEGRAM_BOT_TOKEN");
  const chat = getChat();
  if (!token || !chat) return;
  lastTg[kind] = nowMs();
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* never affect the sentinel */ }
}

// ── DB vitals (readonly — never races Prisma writes) ─────────────────────────
function dbVitals() {
  const out: Record<string, unknown> = { ok: false };
  let db: Database | null = null;
  try {
    db = new Database(`${ROOT}/db/custom.db`, { readonly: true });
    db.exec("PRAGMA busy_timeout=2500");
    const q = (sql: string, ...args: (string | number)[]) => db!.query(sql).get(...args) as Record<string, unknown> | null;
    const c = (t: string) => Number(q(`SELECT COUNT(*) AS n FROM "${t}"`)?.n ?? -1);
    const signals = c("Signal"), events = c("SignalEvent"), prices = c("PricePoint"), assets = c("MarketAsset"), pumps = c("PumpTrack");
    const since1h = nowMs() - 3600_000;
    const ev1h = Number(q("SELECT COUNT(*) AS n FROM SignalEvent WHERE createdAt > ?", since1h)?.n ?? -1);
    const maxRow = q("SELECT MAX(createdAt) AS m FROM SignalEvent") as { m?: number | string } | null;
    let lastEvAgeMs: number | null = null;
    const m = maxRow?.m;
    if (m !== undefined && m !== null) lastEvAgeMs = nowMs() - (typeof m === "number" ? m : parseInt(String(m), 10) || 0);
    // engine stuck guard: active signals whose expiresAt passed >48h (should be impossible)
    const stuck = Number(q("SELECT COUNT(*) AS n FROM Signal WHERE status IN ('ACTIVE','TP1','TP2') AND expiresAt < ?", nowMs() - 48 * 3600_000)?.n ?? 0);
    // orphan events (data-integrity, audit P1-3 family)
    const orphan = Number(q("SELECT COUNT(*) AS n FROM SignalEvent WHERE signalId IS NOT NULL AND signalId NOT IN (SELECT id FROM Signal)")?.n ?? 0);
    // stuck pump tracks (audit P1-13 regression watch) — PumpTrack lifecycle: phase ONSET|EXTENSION|EXHAUSTION → RESOLVED
    const stuckPumps = Number(q("SELECT COUNT(*) AS n FROM PumpTrack WHERE phase != 'RESOLVED' AND detectedAt < ?", nowMs() - 24 * 3600_000)?.n ?? 0);
    let dbBytes: number | null = null, walBytes: number | null = null;
    try { dbBytes = statSync(`${ROOT}/db/custom.db`).size; walBytes = statSync(`${ROOT}/db/custom.db-wal`).size; } catch { /* wal may not exist */ }
    Object.assign(out, { ok: true, signals, events, prices, assets, pumps, events1h: ev1h, lastEventAgeMs: lastEvAgeMs, stuckActive: stuck, orphanEvents: orphan, stuckPumpTracks: stuckPumps, dbBytes, walBytes });
  } catch (e) {
    out.error = String(e).slice(0, 120);
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
  return out;
}

// ── backup ring ──────────────────────────────────────────────────────────────
function backupRing() {
  try {
    const files = readdirSync(RING).filter((f) => /^nexus-snapshot-\d{8}-\d{6}\.zip(\.enc)?$/.test(f));
    let newestEncMs: number | null = null, newestAnyMs: number | null = null, encCount = 0, zipCount = 0;
    for (const f of files) {
      const st = statSync(`${RING}/${f}`);
      if (f.endsWith(".enc")) { encCount++; if (newestEncMs === null || st.mtimeMs > newestEncMs) newestEncMs = st.mtimeMs; }
      else zipCount++;
      if (newestAnyMs === null || st.mtimeMs > newestAnyMs) newestAnyMs = st.mtimeMs;
    }
    return { ok: true, dir: RING, encCount, zipCount, newestEncMs, newestAnyMs, encAgeMs: newestEncMs === null ? null : nowMs() - newestEncMs };
  } catch (e) {
    return { ok: false, dir: RING, error: String(e).slice(0, 120) } as Record<string, unknown>;
  }
}

// ── shadow arms (audit P1-7 visibility) ──────────────────────────────────────
async function shadowArms() {
  try {
    const j = JSON.parse(readFileSync(`${ROOT}/.data/shadow-veto-latest.json`, "utf8")) as {
      generatedAt?: string; mode?: string;
      stats?: { total?: number; vetoCount?: number; paperOpen?: number; paperSettled?: number };
      arms?: { id: string; label: string; n: number; target: number; feed?: { starved?: boolean; starveDetail?: string | null; fed?: number; lastFedAt?: number | null } }[];
    };
    const arms = (j.arms ?? []).map((a) => ({ id: a.id, n: a.n, target: a.target, pct: a.target ? Math.round((a.n / a.target) * 100) : null, starved: !!a.feed?.starved, fed: a.feed?.fed ?? null, lastFedAgeH: a.feed?.lastFedAt ? Math.round((nowMs() - a.feed.lastFedAt) / 3600_000) : null }));
    const nSum = arms.reduce((s, a) => s + a.n, 0), tSum = arms.reduce((s, a) => s + a.target, 0);
    // 24h fence activity from telemetry jsonl (tail only — file can be large)
    let fence24h = -1;
    try {
      const tail = await tailFile(`${ROOT}/.data/shadow-veto.jsonl`, 262_144);
      const cutoff = nowMs() - 24 * 3600_000;
      fence24h = tail.split("\n").filter((l) => {
        if (!l.trim()) return false;
        try { const v = JSON.parse(l); return (v?.v?.at ?? 0) > cutoff; } catch { return false; }
      }).length; // counts only within tailed window — floor estimate, honest label
    } catch { /* absent */ }
    return { ok: true, mode: j.mode ?? null, generatedAt: j.generatedAt ?? null, stats: j.stats ?? null, arms, fillPct: tSum ? Math.round((nSum / tSum) * 100) : null, nSum, tSum, fenceEntries24hFloor: fence24h };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) } as Record<string, unknown>;
  }
}

// ── rawcal state ─────────────────────────────────────────────────────────────
async function rawcalState() {
  const out: Record<string, unknown> = {};
  try {
    const r = await fetch("http://127.0.0.1:3000/api/rawcal", { signal: AbortSignal.timeout(4000), headers: { "user-agent": "nexus-sentinel/1.0" } });
    const j = await r.json() as { armed?: boolean; issued?: number; issuedTotal?: number; target?: number; lastIssueAt?: string };
    out.armed = j.armed ?? null; out.issued = j.issued ?? null; out.issuedTotal = j.issuedTotal ?? null; out.target = j.target ?? null;
  } catch { out.armed = null; out.error = "api unreachable"; }
  try {
    const hb = readFileSync(`${ROOT}/.data/rawcal-run-heartbeat.txt`, "utf8").trim().split("\n").filter(Boolean);
    const last = hb[hb.length - 1] ?? "";
    const m = last.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})Z/);
    if (m) {
      const ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      out.heartbeatAgeH = Math.round((nowMs() - ts) / 3600_000);
      out.heartbeatAt = last;
    }
  } catch { /* absent */ }
  return out;
}

// ── dev.log forensics ────────────────────────────────────────────────────────
async function logForensics() {
  const tail = await tailFile(`${ROOT}/dev.log`, 262_144);
  const lines = tail ? tail.split("\n") : [];
  const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
  return {
    windowLines: lines.length,
    errors: count(/\berror\b/i),
    http500: count(/\s500\s/),
    oom: count(/OOM|heap out of memory/i),
    enospc: count(/ENOSPC/i),
    hydration: count(/hydrat/i),
    unhandled: count(/unhandledRejection|uncaughtException/i),
    settlementStalled: count(/SETTLEMENT[ _]STALLED/i),
  };
}

// ── p0-watchdog cross-read ───────────────────────────────────────────────────
function watchdogState() {
  try {
    const j = JSON.parse(readFileSync(`${ROOT}/.data/p0-watchdog/state.json`, "utf8")) as {
      ver?: string; services?: Record<string, { mode?: string; heals?: number; lastStatus?: number | null; lastLatencyMs?: number | null; recoveries?: number }>;
      mem?: { availableMb?: number | null; level?: string };
      pausedUntil?: number | null;
    };
    const modes: Record<string, string> = {};
    let bad = 0;
    for (const [k, v] of Object.entries(j.services ?? {})) {
      modes[k] = v.mode ?? "?";
      if (v.mode && v.mode !== "ok" && v.mode !== "init") bad++;
    }
    return { ok: true, ver: j.ver ?? null, modes, nonOk: bad, memLevel: j.mem?.level ?? null, memAvailableMb: j.mem?.availableMb ?? null, paused: !!j.pausedUntil };
  } catch {
    return { ok: false } as Record<string, unknown>;
  }
}

// ── verdict engine ───────────────────────────────────────────────────────────
function judge(input: {
  services: { key: string; up: boolean }[];
  memAvailableMb: number | null;
  diskRootGb: number | null; diskTmpGb: number | null;
  db: Record<string, unknown>;
  backup: Record<string, unknown>;
  wd: Record<string, unknown>;
  log: Awaited<ReturnType<typeof logForensics>>;
}): { verdict: Verdict; anomalies: Anomaly[] } {
  const A: Anomaly[] = [];
  const down = input.services.filter((s) => !s.up);
  for (const d of down) A.push({ sev: "crit", area: d.key, msg: "service down / probe failed" });

  if (input.memAvailableMb !== null && input.memAvailableMb < 250) A.push({ sev: "crit", area: "memory", msg: `MemAvailable ${input.memAvailableMb}MB < 250MB crit floor` });
  else if (input.memAvailableMb !== null && input.memAvailableMb < 350) A.push({ sev: "warn", area: "memory", msg: `MemAvailable ${input.memAvailableMb}MB < 350MB warn floor` });

  if (input.diskRootGb !== null && input.diskRootGb < 0.5) A.push({ sev: "crit", area: "disk-root", msg: `rootfs ${input.diskRootGb.toFixed(2)}GB free < 0.5GB` });
  else if (input.diskRootGb !== null && input.diskRootGb < 1.2) A.push({ sev: "warn", area: "disk-root", msg: `rootfs ${input.diskRootGb.toFixed(2)}GB free — tightening` });
  if (input.diskTmpGb !== null && input.diskTmpGb < 1) A.push({ sev: "crit", area: "disk-tmp", msg: `PolarFS /tmp ${input.diskTmpGb.toFixed(2)}GB free < 1GB — backup ring at risk` });

  if (!input.db.ok) A.push({ sev: "crit", area: "db", msg: `SQLite unreadable: ${input.db.error ?? "?"}` });
  else {
    if (Number(input.db.lastEventAgeMs ?? 0) > 2 * 3600_000) A.push({ sev: "crit", area: "engine", msg: `no SignalEvent for ${humanAge(Number(input.db.lastEventAgeMs))} — engine may be stalled` });
    else if (Number(input.db.lastEventAgeMs ?? 0) > 45 * 60_000) A.push({ sev: "warn", area: "engine", msg: `last SignalEvent ${humanAge(Number(input.db.lastEventAgeMs))} ago` });
    if (Number(input.db.stuckActive ?? 0) > 0) A.push({ sev: "warn", area: "signals", msg: `${input.db.stuckActive} active signals past expiresAt+48h` });
    if (Number(input.db.stuckPumpTracks ?? 0) > 0) A.push({ sev: "warn", area: "pump", msg: `${input.db.stuckPumpTracks} PumpTracks stuck >24h (P1-13 regression watch)` });
  }

  const bk = input.backup as { ok?: boolean; encAgeMs?: number | null; encCount?: number };
  if (bk.ok) {
    if (bk.encCount === 0) A.push({ sev: "crit", area: "backup", msg: "backup ring has NO encrypted snapshot yet" });
    else if (bk.encAgeMs !== null && bk.encAgeMs > BACKUP_STALE_ALERT_MS) A.push({ sev: "crit", area: "backup", msg: `newest .enc is ${humanAge(bk.encAgeMs)} old (>7h — 2+ cycles missed)` });
    else if (bk.encAgeMs !== null && bk.encAgeMs > BACKUP_EVERY_MS + BACKUP_GRACE_MS) A.push({ sev: "warn", area: "backup", msg: `backup cycle missed — newest .enc ${humanAge(bk.encAgeMs)} old` });
  } else A.push({ sev: "crit", area: "backup", msg: `ring unreachable: ${bk.error ?? "?"}` });

  const wd = input.wd as { ok?: boolean; nonOk?: number; modes?: Record<string, string>; paused?: boolean };
  if (!wd.ok) A.push({ sev: "warn", area: "watchdog", msg: "p0-watchdog state.json unreadable" });
  else if (wd.nonOk > 0) A.push({ sev: "warn", area: "watchdog", msg: `layer-1 non-ok services: ${JSON.stringify(wd.modes)}` });

  const lg = input.log;
  if (lg.enospc > 0) A.push({ sev: "crit", area: "dev.log", msg: `${lg.enospc} ENOSPC hits in recent log window` });
  if (lg.oom > 0) A.push({ sev: "crit", area: "dev.log", msg: `${lg.oom} OOM markers in recent log window` });
  if (lg.errors >= 20) A.push({ sev: "warn", area: "dev.log", msg: `${lg.errors} error lines in recent log window` });
  if (lg.settlementStalled > 0) A.push({ sev: "warn", area: "settlement", msg: `${lg.settlementStalled} SETTLEMENT STALLED markers (veto active — verify feed)` });

  const verdict: Verdict = A.some((a) => a.sev === "crit") ? "RED" : A.length ? "AMBER" : "GREEN";
  return { verdict, anomalies: A };
}

// ── telemetry assembly ───────────────────────────────────────────────────────
let lastSnapshot: Record<string, unknown> | null = null;
let lastDeepAt = 0;
let lastVerdict: Verdict = "GREEN";

async function collect(deep: boolean) {
  const services = await Promise.all(SERVICES.map(probeSvc));
  let memAvailableMb: number | null = null;
  try {
    const m = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (m) memAvailableMb = Math.floor(parseInt(m[1], 10) / 1024);
  } catch { /* noop */ }
  let diskRootGb: number | null = null, diskTmpGb: number | null = null;
  try { const s = statfsSync("/"); diskRootGb = Math.floor((s.bavail * s.bsize) / 1024 ** 3 * 100) / 100; } catch { /* noop */ }
  try { const s = statfsSync("/tmp"); diskTmpGb = Math.floor((s.bavail * s.bsize) / 1024 ** 3 * 100) / 100; } catch { /* noop */ }

  const db = dbVitals();
  const backup = backupRing();
  const wd = watchdogState();
  const log = await logForensics();
  const shadow = await shadowArms();
  const rawcal = await rawcalState();
  const { verdict, anomalies } = judge({ services, memAvailableMb, diskRootGb, diskTmpGb, db, backup, wd, log });

  const snap: Record<string, unknown> = {
    schemaVersion: 1,
    kind: deep ? "deep" : "tick",
    at: new Date().toISOString(),
    tehran: tehran(),
    verdict,
    anomalies,
    services,
    mem: { availableMb: memAvailableMb },
    disk: { rootFreeGb: diskRootGb, tmpFreeGb: diskTmpGb },
    db, backup, watchdog: wd, log, shadow, rawcal,
    uptimeSec: Math.floor((nowMs() - BOOT) / 1000),
    ver: VER,
  };

  // verdict edge → Telegram
  if (verdict !== lastVerdict) {
    const icon = verdict === "RED" ? "🔴" : verdict === "AMBER" ? "🟡" : "🟢";
    const lines = anomalies.slice(0, 6).map((a) => `• [${a.sev}] ${a.area}: ${a.msg}`).join("\n");
    void tgSend(`verdict-${verdict}`, `${icon} <b>NEXUS-SENTINEL · ${verdict}</b> (was ${lastVerdict})\n${lines || "no anomalies"}\n<code>${tehran()}</code> IRST`);
    lastVerdict = verdict;
  }

  lastSnapshot = snap;
  try {
    writeFileSync(`${DIR}/latest.json.tmp`, JSON.stringify(snap));
    renameSync(`${DIR}/latest.json.tmp`, `${DIR}/latest.json`);
    appendFileSync(`${DIR}/telemetry.jsonl`, JSON.stringify({ at: snap.at, verdict, services: services.map((s) => ({ k: s.key, up: s.up })), anomalies: anomalies.length }) + "\n");
    const sz = statSync(`${DIR}/telemetry.jsonl`).size;
    if (sz > LOG_KEEP_BYTES) {
      const txt = readFileSync(`${DIR}/telemetry.jsonl`, "utf8").trim().split("\n");
      writeFileSync(`${DIR}/telemetry.jsonl`, txt.slice(-400).join("\n") + "\n");
    }
    if (deep) {
      mkdirSync(`${DIR}/reports`, { recursive: true });
      writeFileSync(`${DIR}/reports/report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify(snap, null, 1));
      const reps = readdirSync(`${DIR}/reports`).sort();
      for (const f of reps.slice(0, Math.max(0, reps.length - REPORTS_KEEP))) { try { unlinkSync(`${DIR}/reports/${f}`); } catch { /* noop */ } }
    }
  } catch { /* persistence best-effort */ }
  return snap;
}

// ── backup scheduler (P1-8 in-repo IaC) ──────────────────────────────────────
const BACKUP_LOCK = `${DIR}/backup.lock`;
function backupDue(): { due: boolean; reason: string } {
  try {
    const ring = backupRing() as { ok?: boolean; encAgeMs?: number | null; encCount?: number };
    if (!ring.ok) return { due: false, reason: "ring unreadable" };
    if (ring.encCount === 0) return { due: true, reason: "ring empty — first snapshot" };
    if (ring.encAgeMs !== null && ring.encAgeMs > BACKUP_EVERY_MS + BACKUP_GRACE_MS) return { due: true, reason: `newest .enc ${humanAge(ring.encAgeMs)} old` };
    return { due: false, reason: "ring fresh" };
  } catch (e) { return { due: false, reason: String(e).slice(0, 80) }; }
}
function backupLockHeld(): boolean {
  try {
    const j = JSON.parse(readFileSync(BACKUP_LOCK, "utf8")) as { pid?: number; startedAt?: number };
    if (j.pid && pidAlive(j.pid)) {
      if (j.startedAt && nowMs() - j.startedAt > 40 * 60_000) return false; // stale lock — steal
      return true;
    }
    return false;
  } catch { return false; }
}
function scheduleBackup(reason: string) {
  if (backupLockHeld()) { logLine("info", "backup-skipped", { reason, why: "lock held" }); return; }
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(BACKUP_LOCK, JSON.stringify({ pid: process.pid, startedAt: nowMs(), reason }));
    logLine("info", "backup-spawn", { reason });
    const proc = Bun.spawn(["bash", "-c", `cd ${ROOT} && bash scripts/backup.sh >> ${ROOT}/logs/backup-sentinel.log 2>&1; echo "$?" > ${DIR}/backup.exit`], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    void proc.exited.then((code) => {
      try { unlinkSync(BACKUP_LOCK); } catch { /* noop */ }
      if (code === 0) logLine("info", "backup-ok", { reason });
      else {
        logLine("crit", "backup-failed", { reason, exit: code });
        void tgSend("backup-fail", `🔴 <b>NEXUS-SENTINEL · BACKUP FAILED</b>\nexit ${code} — reason: ${reason}\nlogs/backup-sentinel.log\n<code>${tehran()}</code> IRST`);
      }
    });
  } catch (e) { logLine("warn", "backup-spawn-error", { err: String(e).slice(0, 120) }); }
}

// ── logging ──────────────────────────────────────────────────────────────────
const ACTIONS = `${DIR}/actions.jsonl`;
function logLine(lvl: "info" | "warn" | "crit", ev: string, det: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), tehran: tehran(), lvl, ev, ...det });
  try {
    if (existsSync(ACTIONS) && statSync(ACTIONS).size > LOG_KEEP_BYTES) {
      const txt = readFileSync(ACTIONS, "utf8").trim().split("\n");
      writeFileSync(ACTIONS, txt.slice(-200).join("\n") + "\n");
    }
    appendFileSync(ACTIONS, line + "\n");
  } catch { /* noop */ }
  if (lvl !== "info") console.log(`[${tehran()}] ${lvl.toUpperCase()} ${ev} ${JSON.stringify(det)}`);
}

// ── control gate (P0-1 contract — same as p0-watchdog) ───────────────────────
const CONTROL_KEY = process.env.NEXUS_CONTROL_KEY ?? envFromDotenv("NEXUS_CONTROL_KEY") ?? "";
function controlOk(req: Request): boolean {
  if (!CONTROL_KEY) return false; // fail-closed
  const provided = req.headers.get("x-nexus-key") ?? "";
  if (provided.length !== CONTROL_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ CONTROL_KEY.charCodeAt(i);
  return diff === 0;
}
const CONTROL_401 = () => Response.json({ ok: false, error: "unauthorized: mutating API requires x-nexus-key header" }, { status: 401, headers: { "cache-control": "no-store" } });

// ── HTTP surface ─────────────────────────────────────────────────────────────
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    return Response.json({
      ok: true, ver: VER, port: PORT, pid: process.pid,
      uptimeSec: Math.floor((nowMs() - BOOT) / 1000), tehran: tehran(),
      verdict: lastSnapshot?.verdict ?? null, lastTickAt: lastSnapshot?.at ?? null,
      deepEveryMin: DEEP_EVERY_MS / 60_000, backupEveryH: BACKUP_EVERY_MS / 3600_000,
    }, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/report") {
    // staleness guard: hot-reloads/restarts can orphan module timers — if the
    // last snapshot is older than 2× the tick, collect fresh on demand.
    const fresh = lastSnapshot ? nowMs() - new Date(String(lastSnapshot.at)).getTime() < 2 * TICK_MS : false;
    if (!lastSnapshot || !fresh) { try { await collect(false); } catch { /* noop */ } }
    return Response.json(lastSnapshot ?? { ok: false, error: "no snapshot yet" }, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/history") {
    const n = Math.max(1, Math.min(200, Number(url.searchParams.get("n")) || 24));
    try {
      const lines = readFileSync(`${DIR}/telemetry.jsonl`, "utf8").trim().split("\n").slice(-n);
      return Response.json({ ok: true, items: lines.map((l) => { try { return JSON.parse(l); } catch { return l; } }) }, { headers: { "cache-control": "no-store" } });
    } catch { return Response.json({ ok: true, items: [] }); }
  }
  if (url.pathname === "/run-now" && req.method === "POST") {
    if (!controlOk(req)) return CONTROL_401();
    const snap = await collect(true);
    lastDeepAt = nowMs();
    return Response.json({ ok: true, ranAt: snap.at, verdict: snap.verdict, anomalies: snap.anomalies }, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/backup-now" && req.method === "POST") {
    if (!controlOk(req)) return CONTROL_401();
    if (backupLockHeld()) return Response.json({ ok: false, error: "backup already running" }, { status: 409 });
    scheduleBackup("operator /backup-now");
    return Response.json({ ok: true, spawned: true });
  }
  return new Response("nexus-sentinel: 404\n", { status: 404 });
}

// ── boot ─────────────────────────────────────────────────────────────────────
mkdirSync(DIR, { recursive: true });
mkdirSync(`${DIR}/reports`, { recursive: true });
try { Bun.serve({ port: PORT, fetch: handle }); } catch (e) {
  console.log(`[${tehran()}] port ${PORT} busy (duplicate sentinel?) — exiting: ${String(e).slice(0, 100)}`);
  process.exit(0);
}
logLine("info", "boot", { ver: VER, pid: process.pid, port: PORT });
console.log(`[${tehran()}] ${VER} armed on :${PORT} — 6 probes · deep/30min · backup/3h`);

// bun --hot safety: reap old timers across hot reloads
const g = globalThis as typeof globalThis & { __sentinelTimers?: ReturnType<typeof setInterval>[] };
if (g.__sentinelTimers) for (const t of g.__sentinelTimers) clearInterval(t);
g.__sentinelTimers = [
  setInterval(() => { void collect(false).catch((e) => logLine("warn", "collect-failed", { err: String(e).slice(0, 160) })); }, TICK_MS),
  setInterval(() => {
    lastDeepAt = nowMs();
    void collect(true).catch((e) => logLine("warn", "collect-deep-failed", { err: String(e).slice(0, 160) }));
  }, DEEP_EVERY_MS),
  setInterval(() => {
    const d = backupDue();
    if (d.due) scheduleBackup(d.reason);
  }, 5 * 60_000),
];
setTimeout(() => { void collect(true).catch((e) => logLine("warn", "collect-boot-failed", { err: String(e).slice(0, 160) })); lastDeepAt = nowMs(); }, 4_000);
setTimeout(() => { const d = backupDue(); if (d.due) scheduleBackup(d.reason); }, 90_000); // first backup check after 90s

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("uncaughtException", (e) => { logLine("crit", "uncaught", { err: String(e).slice(0, 200) }); });
