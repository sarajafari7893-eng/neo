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
//     6-hour progress report, 12-hour senior-supervisor LLM review.
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
//   progress · every 6 h     · Persian terminal-style progress report via bridge
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
import ZAI from "z-ai-web-dev-sdk";

const VER = "supervisor-cron 1.0.0";
const ROOT = "/home/z/my-project";
const DIR = `${ROOT}/.data/supervisor-cron`;
const STATE = `${DIR}/state.json`;
const REVIEW = `${DIR}/latest-review.json`;
const LOG = `${ROOT}/logs/supervisor-cron.log`;

const PORT = 3015;
const SWEEP_MS = 10 * 60_000;
const PROGRESS_MS = 6 * 60 * 60_000;
const REVIEW_MS = 12 * 60 * 60_000;
const BOOT_DELAY_MS = 12_000; // first sweep shortly after boot (watchdog grace)
const FETCH_TIMEOUT_MS = 6_000;
const DEEP_TIMEOUT_MS = 10 * 60_000;
const DEEP_TRUNCATE = 6_000;
const LLM_TIMEOUT_MS = 180_000;
const ALERT_GAP_MS = 30 * 60_000; // per anomaly class
const HISTORY_MAX = 50;

type JobId = "sweep" | "progress" | "review";

// ── env (lazy, mtime-cached — same stale-env lesson as bridge v1.2.1) ────────
const ENV_PATH = `${ROOT}/.env`;
let dotenvCache: { mtimeMs: number; values: Map<string, string> } | null = null;
function envGet(key: string): string {
  const fromProc = process.env[key];
  if (fromProc && fromProc.length > 0) return fromProc;
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
  return dotenvCache?.values.get(key) ?? "";
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
  } as Record<JobId, JobState>,
  lastSweep: null as null | { at: string; verdict: string; reason: string; services: Record<string, { up: boolean; status: number | null; ms: number }>; anomalies: Array<{ class: string; sev: string; msg: string }> },
  lastReview: null as null | { at: string; status: string; verdict: string | null },
  lastProgress: null as null | { at: string; ok: boolean },
  alertLedger: {} as Record<string, number>,
  history: [] as HistoryEntry[],
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
    for (const id of ["sweep", "progress", "review"] as JobId[]) {
      const p = prev.jobs?.[id];
      if (p) {
        state.jobs[id] = { ...freshJob(state.jobs[id].nextRunAt ?? 0), ...p };
        if (!state.jobs[id].nextRunAt || state.jobs[id].nextRunAt! < BOOT - 24 * 3600_000) {
          state.jobs[id].nextRunAt = BOOT + 30_000; // stale >24h → catch-up run soon after boot
        }
      }
    }
    if (Array.isArray(prev.history)) state.history = prev.history.slice(-HISTORY_MAX);
    if (prev.alertLedger) state.alertLedger = prev.alertLedger;
    if (prev.lastSweep) state.lastSweep = prev.lastSweep;
    if (prev.lastReview) state.lastReview = prev.lastReview;
    if (prev.lastProgress) state.lastProgress = prev.lastProgress;
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

  // classification rules (own, per 34-c contract)
  let myVerdict = "GREEN";
  let reason = "all services up · sentinel not RED";
  if (anomalies.some((a) => a.class === "app-down")) { myVerdict = "RED"; reason = "app :3000 down"; }
  else if (anomalies.some((a) => a.class === "sentinel-red")) { myVerdict = "RED"; reason = "sentinel verdict RED"; }
  else if (anomalies.length > 0) { myVerdict = "AMBER"; reason = anomalies.map((a) => a.msg).join(" · ").slice(0, 300); }

  state.lastSweep = {
    at: new Date().toISOString(),
    verdict: myVerdict,
    reason,
    services: Object.fromEntries(probes.map((p) => [p.key, { up: p.up, status: p.status, ms: p.ms }])),
    anomalies,
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
    if (s.status !== "SETTLED") continue;
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
  try {
    const zai = await ZAI.create();
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
  const [pulse, rawcal, futures, trade] = await Promise.all([
    fetchJson("http://127.0.0.1:3000/api/pulse", 15_000),
    fetchJson("http://127.0.0.1:3000/api/rawcal", 8_000),
    fetchJson("http://127.0.0.1:3000/api/futures", 8_000),
    fetchJson("http://127.0.0.1:3011/health", 6_000),
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

  const telemetry = {
    generatedAt: new Date().toISOString(),
    liveExecution: "DISABLED (paper/research-only; SUPPRESSED engine path — honesty contract)",
    strategyValidationStatus: "PROMOTE gate = FAIL (insufficient OOS n; re-validation protocol in STRATEGY-VALIDATION-PROTOCOL.md) — recommend only evidence-respecting actions",
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
    // honest operator note — sweep data still persisted (telemetrySnapshot above)
    await bridgeSend(`⚠️ <b>NEXUS · بازبینی مهندس ارشد</b>\nLLM در دسترس نبود (status: <code>${llm.status}</code>) — تلمتری sweep ذخیره شد؛ بازبینی بعدی ۱۲س دیگر.\n${llm.err ? `<code>${String(llm.err).slice(0, 100)}</code>` : ""}`);
  }
  return { status: llm.status };
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
function scheduleNext(id: JobId) {
  const interval = id === "sweep" ? SWEEP_MS : id === "progress" ? PROGRESS_MS : REVIEW_MS;
  const js = state.jobs[id];
  const now = Date.now();
  let next = js.nextRunAt ?? now + interval;
  if (next <= now) {
    if (id === "sweep") { while (next <= now) next += interval; }
    else next = now + 90_000; // overdue 6h/12h report → catch-up run
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

// ── HTTP surface ─────────────────────────────────────────────────────────────
function jobSummary(): Array<Record<string, unknown>> {
  return (["sweep", "progress", "review"] as JobId[]).map((id) => {
    const js = state.jobs[id];
    return { id, lastRunAt: js.lastRunAt, nextRunAt: js.nextRunAt, lastStatus: js.lastStatus, lastDurationMs: js.lastDurationMs, intervalMin: id === "sweep" ? 10 : id === "progress" ? 360 : 720, runs: js.runs, failures: js.failures };
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
    }, { headers: { "cache-control": "no-store" } });
  }
  if (p === "/status") {
    return Response.json({
      ok: true, service: "supervisor-cron", ver: VER, pid: process.pid,
      uptimeSec: Math.floor((Date.now() - BOOT) / 1000), tehran: tehran(),
      jobs: jobSummary(),
      lastSweep: state.lastSweep,
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
    if (job !== "sweep" && job !== "progress" && job !== "review") {
      return Response.json({ ok: false, error: 'body {job: "sweep"|"progress"|"review"} required' }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    const r = await runJob(job, "manual");
    if (r.ok) {
      // a successful manual run re-anchors the schedule from now (operator override)
      state.jobs[job].nextRunAt = Date.now() + (job === "sweep" ? SWEEP_MS : job === "progress" ? PROGRESS_MS : REVIEW_MS);
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
console.log(`[${tehran()}] ${VER} armed on :${PORT} — sweep 10m · progress 6h · review 12h (DAILY/SRE owned by Next daily-scheduler, not duplicated)`);
for (const id of ["sweep", "progress", "review"] as JobId[]) scheduleNext(id);

process.on("SIGTERM", () => { log("info", "shutdown", { sig: "SIGTERM" }); try { writeFileSync(LOCK, JSON.stringify({ pid: null, releasedAt: new Date().toISOString() })); } catch { /* */ } process.exit(0); });
process.on("SIGINT", () => { log("info", "shutdown", { sig: "SIGINT" }); process.exit(0); });
// cron must never crash: log + persist + stay alive (watchdog is the backstop)
process.on("uncaughtException", (e) => { log("crit", "uncaught", { err: String(e).slice(0, 200) }); persistState(); });
process.on("unhandledRejection", (e) => { log("crit", "unhandled-rejection", { err: String(e).slice(0, 200) }); persistState(); });
