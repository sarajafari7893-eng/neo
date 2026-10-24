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
//   • GET /health (liveness, open) · GET /report · GET /history?n= · GET /perf (24h perf ring)
//     POST /run-now + POST /backup-now + POST /cure-now → require x-nexus-key (fail-closed, P0-1)
//   • v1.3.0 CONTRACT AMENDMENT (Task 69, operator order «توصیه‌ها را مهارندسی و کامل
//     اجرا کن» 2026-10-03): the sentinel now owns ONE scoped remediation — the
//     TURBOPACK CACHE CURE. The dev.log panic «Failed to restore task data» breaks
//     the COMPILE pipeline while already-compiled routes keep answering 200, so the
//     watchdog probes never see it and the cure waited for a human (measured
//     2026-10-02: panic recurred 75 log lines after a fresh boot with 0×500 served).
//     The cure executes the documented P1 doctrine: pause watchdog → kill
//     next-server → rm -rf .next → dev-up.sh. Guarded (45min cooldown, ≤3/24h,
//     backup-lock check, watchdog-pause check, failure-streak disarm) and
//     Telegram-reported. The trading domain (signals/ledger/sizing/settings) is
//     NEVER written by the cure — observability remains read-only everywhere else.
// ─────────────────────────────────────────────────────────────────────────────
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";

const VER = "nexus-sentinel 1.3.2";
// v1.2.0 PERF-HISTORY (M1 24h mission, operator order «توصیه‌های باقیمانده را کامل
// و مهندسی انجام بده» 2026-09-30): the 24h performance plateau was UNMEASURABLE —
// telemetry.jsonl kept only {at,verdict,up} for ~6.7h (400-line rotate). Now every
// tick also records {rssMB, heapUsedMB, pulseMs, memAvailableMb} into a dedicated
// 24h ring (.data/sentinel/perf-history.jsonl, ~1600 lines ≈ 26h) and GET /perf
// analyzes it: pulse p50/p95/p99/max + RSS plateau + MemAvailable floor over
// 1h/6h/24h windows, and evaluates the M1 acceptance automatically:
// p95(pulse) < 1000ms · rssMax ≤ 2300MB · coverage ≥ 24h. Observer-only: two extra
// lightweight probes per tick (pulse ~200ms p50, healthz ~16ms) — no heals, no
// trading-domain writes. Same fail-silent contract as everything else here.
// v1.1.3 (SENTINEL-RED-0929): HTTP probe timeout ≠ service down. Live-fire
// 21:52-21:57Z: dev-mode Turbopack cold-compile under memory pressure ran
// 15-29s/route while the probe cap was 4s → a HEALTHY app was paged RED
// («service down / probe failed»). Fixes: (a) per-service probe timeout — app
// gets 12s (dev compile tolerance), lightweight bun services keep 4s; (b) on
// app timeout, a quick TCP check to :3000 distinguishes warming (port open →
// warn, AMBER) from truly down (port refused → crit, RED).
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
const SERVICES: { key: string; label: string; url: string; timeoutMs?: number; expect: (s: number) => boolean }[] = [
  { key: "app", label: "app :3000", url: "http://127.0.0.1:3000/api/healthz", timeoutMs: 12_000, expect: (s) => s === 200 }, // v1.1.3: dev compile tolerance
  { key: "ws", label: "price-ws :3003", url: "http://127.0.0.1:3003/", expect: (s) => s < 500 },
  { key: "bridge", label: "telegram-bridge :3005", url: "http://127.0.0.1:3005/health", expect: (s) => s === 200 },
  { key: "liq", label: "liq :3010", url: "http://127.0.0.1:3010/health", expect: (s) => s === 200 },
  { key: "trade", label: "trade :3011", url: "http://127.0.0.1:3011/health", expect: (s) => s === 200 },
  { key: "watchdog", label: "p0-watchdog :3020", url: "http://127.0.0.1:3020/health", expect: (s) => s === 200 },
];
// v1.1.3: TCP liveness — distinguishes "warming (compile storm)" from "dead".
function tcpAlive(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { try { sock.destroy(); } catch { /* never */ } res(ok); };
    const timer = setTimeout(() => done(false), 1_200);
    sock.once("connect", () => { clearTimeout(timer); done(true); });
    sock.once("error", () => { clearTimeout(timer); done(false); });
  });
}
async function probeSvc(s: (typeof SERVICES)[number]) {
  const t0 = nowMs();
  try {
    const r = await fetch(s.url, { signal: AbortSignal.timeout(s.timeoutMs ?? 4_000), headers: { "user-agent": "nexus-sentinel/1.0" } });
    return { key: s.key, label: s.label, up: s.expect(r.status), status: r.status, ms: nowMs() - t0 };
  } catch {
    const tcpOpen = s.key === "app" ? await tcpAlive(3000) : false;
    return { key: s.key, label: s.label, up: false, status: null as number | null, ms: nowMs() - t0, tcpOpen };
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
  // v1.1.1 LIVE-FIRST (fix of the 2026-09-21 false-narrative bug): the legacy
  // .data/shadow-veto-latest.json is a mirror nobody in this vintage writes,
  // so a frozen mtime once read as "arms stalled 160h" while the live pipeline
  // was healthy. Primary source is now the LIVE telemetry API (4s budget);
  // the file is only a fallback that must self-declare as degraded, and a
  // successful live read atomically re-publishes the mirror for backups.
  try {
    const res = await fetch("http://127.0.0.1:3000/api/ai/shadow-veto/telemetry", { signal: AbortSignal.timeout(4_000) });
    if (res.ok) {
      const live = (await res.json()) as Record<string, unknown>;
      const liveArms = (live.arms ?? []) as { id: string; label?: string; n?: number; target?: number; reachable?: boolean; modeConditional?: boolean; fed?: number; lastFedAgeH?: number | null }[];
      const arms = liveArms.map((a) => ({ id: a.id, n: a.n ?? 0, target: a.target ?? 30, pct: a.target ? Math.round(((a.n ?? 0) / a.target) * 100) : null, starved: false, reachable: a.reachable ?? !a.modeConditional, fed: a.fed ?? null, lastFedAgeH: a.lastFedAgeH ?? null }));
      const nSum = arms.reduce((s, a) => s + a.n, 0), tSum = arms.reduce((s, a) => s + a.target, 0);
      const nReach = arms.filter((a) => a.reachable !== false).reduce((s, a) => s + a.n, 0);
      const tReach = arms.filter((a) => a.reachable !== false).reduce((s, a) => s + a.target, 0);
      const snapshot = { generatedAt: new Date().toISOString(), source: "sentinel-live-mirror", mode: (live.config as { mode?: string } | undefined)?.mode ?? null, stats: live.stats ?? null, arms: liveArms };
      try {
        const tmp = `${ROOT}/.data/shadow-veto-latest.json.tmp`;
        writeFileSync(tmp, JSON.stringify(snapshot));
        renameSync(tmp, `${ROOT}/.data/shadow-veto-latest.json`);
      } catch { /* mirror best-effort */ }
      let fence24h = -1;
      try {
        const tail = await tailFile(`${ROOT}/.data/shadow-veto.jsonl`, 262_144);
        const cutoff = nowMs() - 24 * 3600_000;
        fence24h = tail.split("\n").filter((l) => {
          if (!l.trim()) return false;
          try { const v = JSON.parse(l); return (v?.v?.at ?? 0) > cutoff; } catch { return false; }
        }).length;
      } catch { /* absent */ }
      return { ok: true, source: "live-api", mode: snapshot.mode, generatedAt: snapshot.generatedAt, stats: live.stats ?? null, arms, fillPct: tSum ? Math.round((nSum / tSum) * 100) : null, fillPctReach: tReach ? Math.round((nReach / tReach) * 100) : null, nSum, tSum, nSumReach: nReach, tSumReach: tReach, fenceEntries24hFloor: fence24h };
    }
  } catch { /* live unavailable → legacy file below */ }
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
    const fileAgeH = j.generatedAt ? Math.round((nowMs() - Date.parse(j.generatedAt)) / 3600_000) : null;
    return { ok: true, source: "legacy-file", degraded: true, fileAgeH, mode: j.mode ?? null, generatedAt: j.generatedAt ?? null, stats: j.stats ?? null, arms, fillPct: tSum ? Math.round((nSum / tSum) * 100) : null, nSum, tSum, fenceEntries24hFloor: fence24h, note: fileAgeH !== null && fileAgeH > 6 ? `legacy mirror is ${fileAgeH}h stale — live API unavailable; numbers below are NOT current` : undefined };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) } as Record<string, unknown>;
  }
}

// ── flow-card freshness (card-sentinel :3022 state mirror, v1.3.3) ──────────
function cardsState(): Record<string, unknown> {
  try {
    const p = `${ROOT}/.data/card-sentinel-state.json`;
    const j = JSON.parse(readFileSync(p, "utf8")) as {
      at?: string; ticks?: number; refreshed1h?: number; failures1h?: number;
      staleHot?: number; lastTickAt?: number; top?: { symbol: string; ageMin: number; heat: string }[];
    };
    const ageSec = j.lastTickAt ? Math.round((Date.now() - j.lastTickAt) / 1000) : -1;
    return {
      ok: true,
      sentinelAgeSec: ageSec,
      ticks: j.ticks ?? 0,
      refreshed1h: j.refreshed1h ?? 0,
      failures1h: j.failures1h ?? 0,
      staleHot: j.staleHot ?? 0,
      worst: (j.top ?? []).slice(0, 5),
    };
  } catch {
    return { ok: false, note: "card-sentinel state absent" };
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
  // v1.1.2 (2026-09-27, Task 41, operator report «sentinel چند هشدار فرستاد»):
  // next-dev error overlays dump SOURCE CODE into dev.log — a code-frame line
  // (`  243 |   // … OOM-proximity …`) matched the old bare /OOM/i regex and
  // fabricated up to 14 phantom "OOM markers", pinning the verdict RED for
  // hours (verdict-edge TG + RED-persist pages + supervisor sweep alerts).
  // Three corrections:
  //   (a) code-frame lines (`  243 |  …` / `      ^  …`) are dropped before
  //       counting — source comments can no longer forge forensics;
  //   (b) the OOM pattern matches REAL OOM events only (JS heap fatal, kernel
  //       kill line, V8 heap-limit fatal) — the bare acronym is never counted;
  //   (c) counting starts AFTER the last «✓ Ready in» boot banner, so markers
  //       from previous sessions age out on every restart instead of haunting
  //       a 256KB tail window forever.
  const tail = await tailFile(`${ROOT}/dev.log`, 262_144);
  const all = tail ? tail.split("\n") : [];
  const lines = all.filter((l) => !/^\s*\d+\s*\|/.test(l) && !/^\s*\^/.test(l));
  let lastBoot = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/✓?\s*Ready in /.test(lines[i])) { lastBoot = i; break; }
  }
  const windowed = lastBoot >= 0 ? lines.slice(lastBoot + 1) : lines;
  const count = (re: RegExp) => windowed.filter((l) => re.test(l)).length;
  return {
    windowLines: windowed.length,
    errors: count(/\berror\b/i),
    http500: count(/\s500\s/),
    oom: count(/JavaScript heap out of memory|Out of memory: Killed process|FATAL ERROR: Reached heap limit/i),
    enospc: count(/ENOSPC/i),
    hydration: count(/hydrat/i),
    unhandled: count(/unhandledRejection|uncaughtException/i),
    settlementStalled: count(/SETTLEMENT[ _]STALLED/i),
    // v1.3.0 (Task 69) — the «Failed to restore» class: breaks NEW compiles only,
    // warm routes keep serving 200 → watchdog probes blind to it. Counted within
    // the current-boot window; the auto-cure engine consumes this signal.
    turbopackPanic: count(/Failed to restore task data|FATAL: An unexpected Turbopack error|TurbopackInternalError/i),
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
  services: { key: string; up: boolean; tcpOpen?: boolean }[];
  memAvailableMb: number | null;
  diskRootGb: number | null; diskTmpGb: number | null;
  db: Record<string, unknown>;
  backup: Record<string, unknown>;
  wd: Record<string, unknown>;
  log: Awaited<ReturnType<typeof logForensics>>;
}): { verdict: Verdict; anomalies: Anomaly[] } {
  const A: Anomaly[] = [];
  const down = input.services.filter((s) => !s.up);
  for (const d of down) {
    // v1.1.3: timeout with TCP open = warming (dev compile storm) → warn, not RED.
    if (d.tcpOpen) A.push({ sev: "warn", area: d.key, msg: "HTTP probe timeout but TCP port open — warming (dev compile storm), NOT down" });
    else A.push({ sev: "crit", area: d.key, msg: "service down / probe failed" });
  }

  // v1.3.1 (Task 73, SENTINEL-20261003-0020 rec P3): pre-emptive memory tier.
  // 2026-10-03 log: MemAvailable hit 293→158MB BEFORE the app died of turbopack
  // SST write failures — the watchdog acts at 350/250, but the VERDICT (what the
  // operator sees) stayed silent until service death. A 4GB no-swap box needs
  // lead time: warn at <400MB so the dashboard/Telegram edge fires early.
  if (input.memAvailableMb !== null && input.memAvailableMb < 250) A.push({ sev: "crit", area: "memory", msg: `MemAvailable ${input.memAvailableMb}MB < 250MB crit floor` });
  else if (input.memAvailableMb !== null && input.memAvailableMb < 350) A.push({ sev: "warn", area: "memory", msg: `MemAvailable ${input.memAvailableMb}MB < 350MB warn floor` });
  else if (input.memAvailableMb !== null && input.memAvailableMb < 400) A.push({ sev: "warn", area: "memory", msg: `MemAvailable ${input.memAvailableMb}MB < 400MB — pre-emptive OOM-proximity watch (4GB no-swap box)` });

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
  // v1.3.0 — Turbopack panic radar (Task 69)
  if (lg.turbopackPanic > 0) A.push({ sev: "warn", area: "turbopack", msg: `${lg.turbopackPanic} Turbopack panic marker(s) in current boot window — compile pipeline fragile (auto-cure armed)` });

  const verdict: Verdict = A.some((a) => a.sev === "crit") ? "RED" : A.length ? "AMBER" : "GREEN";
  return { verdict, anomalies: A };
}

// ── telemetry assembly ───────────────────────────────────────────────────────
let lastSnapshot: Record<string, unknown> | null = null;
let lastDeepAt = 0;
let lastVerdict: Verdict = "GREEN";
// v1.1.2 PERSISTENT-DEGRADED PAGES (task 18, operator finding «چرا به گزارش خطای
// System Sentinel توجه نمیشه؟»): pages fire only on the verdict FLIP, so a
// steady AMBER/RED runs silent forever. Now a degraded verdict that PERSISTS
// pages at most every 6h (AMBER after 30min, RED after 5min).
const PERSIST_PAGE_GAP_MS = 6 * 3600_000;
let degradedSince = 0;
let lastPersistPageAt = 0;

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
  const cards = cardsState(); // v1.3.3 — card-sentinel :3022 flow-card freshness
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
    db, backup, watchdog: wd, log, shadow, rawcal, cards,
    cures: cureState(), // v1.3.0 — turbopack cache-cure state
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

  // v1.1.2 — persistent-degraded page (see PERSIST_PAGE_GAP_MS above)
  if (verdict === "GREEN") {
    degradedSince = 0;
  } else {
    if (!degradedSince) degradedSince = nowMs();
    const dwell = verdict === "RED" ? 5 * 60_000 : 30 * 60_000;
    if (nowMs() - degradedSince >= dwell && nowMs() - lastPersistPageAt >= PERSIST_PAGE_GAP_MS) {
      lastPersistPageAt = nowMs();
      const icon = verdict === "RED" ? "🔴" : "🟡";
      const mins = Math.round((nowMs() - degradedSince) / 60_000);
      const lines = anomalies.slice(0, 6).map((a) => `• [${a.sev}] ${a.area}: ${a.msg}`).join("\n");
      void tgSend("degraded-persist", `${icon} <b>NEXUS-SENTINEL · ${verdict} persisting</b> (${mins}m, not a flip)\n${lines || "no anomalies"}\n<code>${tehran()}</code> IRST`);
    }
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
    // v1.2.0 — perf-history ring (24h): RSS/heap from healthz body + pulse latency KPI
    try {
      const perf = await perfSample();
      appendFileSync(PERF_FILE, JSON.stringify({ at: snap.at, verdict, ...perf, memAvailableMb }) + "\n");
      const psz = statSync(PERF_FILE).size;
      if (psz > PERF_ROTATE_BYTES) {
        const ptxt = readFileSync(PERF_FILE, "utf8").trim().split("\n");
        writeFileSync(PERF_FILE, ptxt.slice(-PERF_KEEP_LINES).join("\n") + "\n");
      }
    } catch { /* perf ring is best-effort — never break telemetry */ }
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

// ── v1.3.2 RESTORE-DRILL SCHEDULER (operator mandate 2026-10-07
// «هر سه مورد را کامل و مهندسی پیاده کن + یک درل بازیابی برنامه‌ریزی شود») ──
// A backup ring that is never RESTORED is a hope, not a capability. Once a day
// the newest .enc is decrypted, unpacked, fingerprint-verified against the
// manifest, integrity-checked (PRAGMA) and env-chain-audited by
// scripts/restore-drill.sh — entirely in a /tmp staging dir, ZERO live-file
// contact. Result journaled to .data/restore-drill.log + state file below;
// a FAIL pages Telegram (same contract as backup-fail).
const DRILL_EVERY_MS = 24 * 3600_000;
const DRILL_STATE = `${DIR}/restore-drill.json`;
function drillDue(): { due: boolean; reason: string } {
  try {
    const st = JSON.parse(readFileSync(DRILL_STATE, "utf8")) as { lastDrillAt?: number; lastOk?: number };
    if (!st.lastDrillAt) return { due: true, reason: "no drill on record" };
    const age = nowMs() - st.lastDrillAt;
    if (age > DRILL_EVERY_MS) return { due: true, reason: `last drill ${humanAge(age)} ago` };
    if (st.lastOk !== 0) return { due: true, reason: "last drill FAILED — immediate re-probe" };
    return { due: false, reason: "recent" };
  } catch { return { due: true, reason: "drill state absent" }; }
}
function scheduleDrill(reason: string) {
  if (backupLockHeld()) { logLine("info", "drill-skipped", { reason, why: "backup lock held" }); return; }
  try {
    logLine("info", "drill-spawn", { reason });
    const proc = Bun.spawn(["bash", "-c", `cd ${ROOT} && bash scripts/restore-drill.sh >> ${ROOT}/logs/restore-drill.log 2>&1`], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    void proc.exited.then((code) => {
      if (code === 0) logLine("info", "drill-ok", { reason });
      else {
        logLine("crit", "drill-failed", { reason, exit: code });
        void tgSend("drill-fail", `🔴 <b>NEXUS-SENTINEL · RESTORE DRILL FAILED</b>\nexit ${code} — reason: ${reason}\nlogs/restore-drill.log · .data/restore-drill.log\n<code>${tehran()}</code> IRST`);
      }
    });
  } catch (e) { logLine("warn", "drill-spawn-error", { err: String(e).slice(0, 120) }); }
}

// ── v1.3.0 TURBOPACK CACHE CURE (Task 69 — the ONE scoped remediation) ──────
// Root cause: the Turbopack dev panic «Failed to restore task data» corrupts the
// COMPILE pipeline while warm routes keep serving — watchdog probes can't see it
// (no 500s, /healthz pre-compiled) — so the documented P1 cache cure waited for a
// human every time. This engine automates exactly that doctrine:
//   pause watchdog → kill next-server (both cmdlines) → rm -rf .next → dev-up.sh
// Guards: 45min cooldown · ≤3 cures/24h · backup-lock check (purge would corrupt
// a running snapshot) · watchdog-pause check (another actor owns the box) ·
// failure-streak disarm (panic within 35min after a cure = cure didn't hold;
// 2 strikes → auto-cure stops + crit page — needs POST /cure-now to re-arm).
const CURE_COOLDOWN_MS = 45 * 60_000;
const CURE_MAX_24H = 3;
const CURE_FAIL_STREAK_LIMIT = 2;
const CURE_FILE = `${DIR}/cures.jsonl`;
interface CureState { armed: boolean; baselineMark: number; lastCureAt: number; lastCureOutcome: string | null; failStreak: number; cures: number[]; curing: boolean }
const cure: CureState = { armed: true, baselineMark: 0, lastCureAt: 0, lastCureOutcome: null, failStreak: 0, cures: [], curing: false };
// boot-survivable state rebuild from the journal
try {
  const rows = readFileSync(CURE_FILE, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as { at?: string; kind?: string; outcome?: string }; } catch { return null; } })
    .filter((r): r is { at: string; kind: string; outcome?: string } => !!r?.at && !!r.kind);
  const cutoff = nowMs() - 24 * 3600_000;
  cure.cures = rows.filter((r) => r.kind === "cure").map((r) => Date.parse(r.at)).filter((t) => Number.isFinite(t) && t > cutoff);
  const lastCure = rows.filter((r) => r.kind === "cure").pop();
  if (lastCure) {
    cure.lastCureAt = Date.parse(lastCure.at);
    cure.lastCureOutcome = lastCure.outcome ?? null;
  }
  const recentDisarm = rows.some((r) => r.kind === "disarm" && Date.parse(r.at) > nowMs() - 6 * 3600_000);
  if (recentDisarm) { cure.armed = false; cure.failStreak = CURE_FAIL_STREAK_LIMIT; }
} catch { /* journal absent — fresh state */ }

function cureState(): Record<string, unknown> {
  return { armed: cure.armed, curing: cure.curing, cures24h: cure.cures.length, lastCureAt: cure.lastCureAt ? new Date(cure.lastCureAt).toISOString() : null, lastCureOutcome: cure.lastCureOutcome, failStreak: cure.failStreak, baselineMark: cure.baselineMark };
}

async function executeCure(reason: string): Promise<{ ok: boolean; detail: string }> {
  if (cure.curing) return { ok: false, detail: "cure already in progress" };
  cure.curing = true;
  try {
    logLine("warn", "cure-start", { reason });
    try { appendFileSync(CURE_FILE, JSON.stringify({ at: new Date().toISOString(), kind: "cure-start", reason }) + "\n"); } catch { /* noop */ }
    // (1) pause + kill-safe + wipe + restart now ride the CANONICAL guarded
    //     purge (scripts/dev-cache-purge.sh --full — Task 73): flock-serialized
    //     against the other dancers (watchdog heal, backup repair, hygiene),
    //     graceful kill WITH process-exit wait, port-close wait, full .next
    //     purge under the verifiably dead server, dev-up restart. The old
    //     inline dance raced the layer-1 heal-spawns (2026-10-03 14:21Z
    //     multi-dancer crash-loop) — one contract, one lock now.
    // (2) verify — POLL through the cold-rebuild window (90s→270s, 4 attempts):
    // a single 90s check measured "still compiling" on a healthy cure (Task-69
    // live-fire) — the journal must record the SETTLED outcome, not the race.
    const script = [
      `cd ${ROOT}`,
      `nohup bash scripts/dev-cache-purge.sh --full >> logs/sentinel-cure.log 2>&1 &`,
    ].join(" && ");
    const proc = Bun.spawn(["bash", "-c", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore", cwd: ROOT });
    await proc.exited; // the script backgrounds dev-up and returns immediately
    cure.cures = [...cure.cures.filter((t) => t > nowMs() - 24 * 3600_000), nowMs()];
    cure.lastCureAt = nowMs();
    cure.baselineMark = Number.MAX_SAFE_INTEGER; // fresh boot proves itself below
    // (5) verify — POLL through the cold-rebuild window (90s→270s, 4 attempts):
    // a single 90s check measured "still compiling" on a healthy cure (Task-69
    // live-fire) — the journal must record the SETTLED outcome, not the race.
    const verifyOnce = async (): Promise<string> => {
      try {
        const r = await fetch("http://127.0.0.1:3000/api/healthz", { signal: AbortSignal.timeout(15_000) });
        return r.ok ? "app-200-post-cure" : `app-${r.status}-post-cure`;
      } catch { return "app-still-compiling-post-cure"; }
    };
    void (async () => {
      let outcome = "verify-failed";
      for (let attempt = 1; attempt <= 4; attempt++) {
        await new Promise((res) => setTimeout(res, attempt === 1 ? 90_000 : 60_000));
        outcome = await verifyOnce();
        if (outcome === "app-200-post-cure") break;
      }
      cure.lastCureOutcome = outcome;
      try { appendFileSync(CURE_FILE, JSON.stringify({ at: new Date().toISOString(), kind: "cure", reason, outcome }) + "\n"); } catch { /* noop */ }
      logLine("info", "cure-done", { reason, outcome });
      void tgSend("turbopack-cure", `🛠 <b>NEXUS-SENTINEL · TURBOPACK CACHE CURE</b>\n${reason}\noutcome: ${outcome}\n<code>${tehran()}</code> IRST`);
      cure.curing = false;
    })();
    return { ok: true, detail: "cure sequence spawned — verify in ~90s" };
  } catch (e) {
    cure.curing = false;
    logLine("crit", "cure-error", { err: String(e).slice(0, 160) });
    return { ok: false, detail: String(e).slice(0, 160) };
  }
}

async function cureCheck(auto: boolean): Promise<{ triggered: boolean; why: string }> {
  if (!auto) { cure.armed = true; cure.failStreak = 0; } // operator /cure-now re-arms
  if (!cure.armed) return { triggered: false, why: "auto-cure disarmed (panic recurred post-cure) — POST /cure-now re-arms" };
  if (cure.curing) return { triggered: false, why: "cure in progress" };
  if (backupLockHeld()) return { triggered: false, why: "backup running — purge would corrupt the snapshot" };
  if (auto) {
    // watchdog paused = another actor owns the box (operator dev-up / manual work)
    try {
      const pu = Number(readFileSync(`${ROOT}/.data/p0-watchdog/pause-until`, "utf8").trim());
      if (Number.isFinite(pu) && pu * 1000 > nowMs()) return { triggered: false, why: "watchdog paused — another actor owns the box" };
    } catch { /* no pause file — fine */ }
    if (cure.lastCureAt && nowMs() - cure.lastCureAt < CURE_COOLDOWN_MS) return { triggered: false, why: "cooldown" };
    if (cure.cures.filter((t) => t > nowMs() - 24 * 3600_000).length >= CURE_MAX_24H) return { triggered: false, why: "24h cure budget exhausted — operator review needed" };
  }
  const f = await logForensics();
  const count = f.turbopackPanic;
  // fresh-boot window reset: after a cure restarts the server, the boot marker
  // moves and the count drops below the baseline → re-baseline automatically
  if (count < cure.baselineMark) cure.baselineMark = count;
  if (count <= cure.baselineMark) return { triggered: false, why: `no fresh panic beyond baseline (count=${count})` };
  // failure-streak bookkeeping: a trigger within 35min of the last cure = it did not hold
  if (auto && cure.lastCureAt && nowMs() - cure.lastCureAt < 35 * 60_000) {
    cure.failStreak += 1;
    if (cure.failStreak >= CURE_FAIL_STREAK_LIMIT) {
      cure.armed = false;
      try { appendFileSync(CURE_FILE, JSON.stringify({ at: new Date().toISOString(), kind: "disarm", why: "panic recurred post-cure — operator intervention required" }) + "\n"); } catch { /* noop */ }
      logLine("crit", "cure-disarmed", { failStreak: cure.failStreak });
      void tgSend("turbopack-cure-exhausted", `🔴 <b>NEXUS-SENTINEL · AUTO-CURE DISARMED</b>\nTurbopack panic recurred after cure — operator review required (POST /cure-now re-arms)\n<code>${tehran()}</code> IRST`);
      return { triggered: false, why: "failure streak — disarmed + paged" };
    }
  }
  const reason = auto ? `auto: ${count} panic marker(s) beyond baseline ${cure.baselineMark === Number.MAX_SAFE_INTEGER ? 0 : cure.baselineMark}` : "operator /cure-now";
  const r = await executeCure(reason);
  if (r.ok) {
    cure.baselineMark = count; // consume the signal this cure addresses
    logLine("warn", "cure-triggered", { reason, panicCount: count });
  }
  return { triggered: r.ok, why: r.detail };
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
// v1.x (task 17, 2026-09-22 canary incident): key resolution moved INSIDE
// controlOk — the boot-once const froze pre-restore values whenever this
// service booted before env-guard restored a rotated .env (stale-env class,
// same root cause as the bridge-relay BRIDGE(HTTP 401)). envFromDotenv() already
// re-reads per call, so the gate now self-heals after any .env restore.
function controlOk(req: Request): boolean {
  // Task 36: .env FILE first (envFromDotenv re-reads per call) — the boot env
  // is frozen and heal-spawn chains inherit it stale; file-first keeps the
  // gate on the live source of truth after any rotation.
  const CONTROL_KEY = envFromDotenv("NEXUS_CONTROL_KEY") ?? process.env.NEXUS_CONTROL_KEY ?? "";
  if (!CONTROL_KEY) return false; // fail-closed
  const provided = req.headers.get("x-nexus-key") ?? "";
  if (provided.length !== CONTROL_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ CONTROL_KEY.charCodeAt(i);
  return diff === 0;
}
const CONTROL_401 = () => Response.json({ ok: false, error: "unauthorized: mutating API requires x-nexus-key header" }, { status: 401, headers: { "cache-control": "no-store" } });

// ── v1.2.0 PERF-HISTORY (M1 24h mission instrument) ──────────────────────────
const PERF_FILE = `${DIR}/perf-history.jsonl`;
const PERF_KEEP_LINES = 1600;              // ≈26.7h of samples at 60s ticks
const PERF_ROTATE_BYTES = 1_200_000;
const M1_P95_MS = 1000;                    // acceptance: pulse p95 < 1000ms
const M1_RSS_MB = 2300;                    // acceptance: rssMax ≤ 2300MB (dev-up.sh v8.2 envelope top)

async function perfSample(): Promise<{ rssMB: number | null; heapUsedMB: number | null; pulseMs: number | null }> {
  const out: { rssMB: number | null; heapUsedMB: number | null; pulseMs: number | null } = { rssMB: null, heapUsedMB: null, pulseMs: null };
  try {
    const t0 = nowMs();
    const r = await fetch("http://127.0.0.1:3000/api/pulse", { signal: AbortSignal.timeout(12_000) });
    await r.arrayBuffer().catch(() => null); // drain so the socket frees
    out.pulseMs = nowMs() - t0;
  } catch { /* app down/warming — pulseMs stays null (honest gap) */ }
  try {
    const r = await fetch("http://127.0.0.1:3000/api/healthz", { signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const j = (await r.json().catch(() => null)) as { rssMB?: number; heapUsedMB?: number } | null;
      if (j) { out.rssMB = typeof j.rssMB === "number" ? j.rssMB : null; out.heapUsedMB = typeof j.heapUsedMB === "number" ? j.heapUsedMB : null; }
    }
  } catch { /* noop */ }
  return out;
}

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function perfReport(): Record<string, unknown> {
  const WINDOWS: Array<[string, number]> = [["1h", 3600_000], ["6h", 6 * 3600_000], ["24h", 24 * 3600_000]];
  let samples: Array<Record<string, unknown>> = [];
  try {
    samples = readFileSync(PERF_FILE, "utf8").trim().split("\n").filter(Boolean).slice(-PERF_KEEP_LINES)
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((s): s is Record<string, unknown> => !!s);
  } catch { /* ring not created yet */ }
  const now = nowMs();
  const windows: Record<string, unknown> = {};
  for (const [name, span] of WINDOWS) {
    const rows = samples.filter((s) => { const t = Date.parse(String(s.at)); return Number.isFinite(t) && now - t <= span; });
    const pulse = rows.map((r) => r.pulseMs).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    const rss = rows.map((r) => r.rssMB).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    const mem = rows.map((r) => r.memAvailableMb).filter((v): v is number => typeof v === "number");
    windows[name] = {
      n: rows.length,
      pulseMs: { p50: pct(pulse, 50), p95: pct(pulse, 95), p99: pct(pulse, 99), max: pulse.length ? pulse[pulse.length - 1] : null },
      rssMB: { median: pct(rss, 50), max: rss.length ? rss[rss.length - 1] : null },
      memAvailableMinMb: mem.length ? Math.min(...mem) : null,
    };
  }
  const w24 = windows["24h"] as { pulseMs?: { p95?: number | null }; rssMB?: { max?: number | null } };
  const coverageMin = samples.length ? Math.round((now - Date.parse(String(samples[0].at))) / 60_000) : 0;
  const acceptance = {
    p95_lt_1000ms: w24?.pulseMs?.p95 != null ? w24.pulseMs.p95 < M1_P95_MS : null,
    rss_max_le_2300mb: w24?.rssMB?.max != null ? w24.rssMB.max <= M1_RSS_MB : null,
    sufficient_24h_coverage: coverageMin >= 1440,
  };
  return {
    ok: true, ver: VER, at: new Date().toISOString(),
    samples: samples.length, coverageMin,
    sufficient: acceptance.sufficient_24h_coverage,
    windows, acceptance,
    note: acceptance.sufficient_24h_coverage ? "full 24h coverage — acceptance authoritative" : `instrument filling — ${coverageMin}min of 1440min; treat windows as provisional`,
  };
}

// ── HTTP surface ─────────────────────────────────────────────────────────────
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    return Response.json({
      ok: true, ver: VER, port: PORT, pid: process.pid,
      uptimeSec: Math.floor((nowMs() - BOOT) / 1000), tehran: tehran(),
      verdict: lastSnapshot?.verdict ?? null, lastTickAt: lastSnapshot?.at ?? null,
      deepEveryMin: DEEP_EVERY_MS / 60_000, backupEveryH: BACKUP_EVERY_MS / 3600_000,
      cures24h: cure.cures.length, cureArmed: cure.armed, // v1.3.0
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
  if (url.pathname === "/perf") {
    return Response.json(perfReport(), { headers: { "cache-control": "no-store" } });
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
  // v1.3.0 — operator-forced Turbopack cache cure (re-arms auto-cure on success path)
  if (url.pathname === "/cure-now" && req.method === "POST") {
    if (!controlOk(req)) return CONTROL_401();
    const r = await cureCheck(false);
    return Response.json({ ok: r.triggered, why: r.why, state: cureState() }, { headers: { "cache-control": "no-store" } });
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
console.log(`[${tehran()}] ${VER} armed on :${PORT} — 6 probes · deep/30min · backup/3h · turbopack-cure armed`);

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
    const dr = drillDue();
    if (dr.due) scheduleDrill(dr.reason);
  }, 5 * 60_000),
  // v1.3.0 — turbopack panic radar + auto-cache-cure, every tick
  setInterval(() => { void cureCheck(true).catch((e) => logLine("warn", "cure-check-failed", { err: String(e).slice(0, 160) })); }, 60_000),
];
setTimeout(() => { void collect(true).catch((e) => logLine("warn", "collect-boot-failed", { err: String(e).slice(0, 160) })); lastDeepAt = nowMs(); }, 4_000);
setTimeout(() => { const d = backupDue(); if (d.due) scheduleBackup(d.reason); }, 90_000); // first backup check after 90s

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("uncaughtException", (e) => { logLine("crit", "uncaught", { err: String(e).slice(0, 200) }); });
