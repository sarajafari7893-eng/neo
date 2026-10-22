// ── NEXUS//SIGNALS — STABLE-FEED SERVICE v1.0.0 (:3017) ─────────────────────
// Operator mandate 2026-09-30: «تمام فازها را کامل و مهندسی اجرا کن» — PHASE 1.
// Family-E substrate: on-chain stablecoin liquidity collected from DefiLlama's
// FREE API (no key, no AI — IRAN-VPS compatible). The service is a PURE
// COLLECTOR: it never touches SQLite (Prisma owns writes — doctrine), it
// publishes:
//   .data/stable-feed/board.json       — live regime board (atomic tmp+rename)
//   .data/stable-feed/events.jsonl     — MINTBURN | DEPEG | REGIME events
//   .data/stable-feed/backfill/*.json  — daily history (~9y) backtest substrate
// Consumers: engine gates (DEPEG-MUTE enforced / STABLE-REGIME shadow),
// shadow-veto family-E telemetry, /api/stableflow, Persian TG digest.
//
// CONTRACT
//   • poll DefiLlama every 15min (POLL_MS) — 6 requests/cycle, no key
//   • tracked: top-USD stables by symbol — USDT USDC DAI USDE USDS
//   • backfill runs ONCE (marker-gated) — self-heals after platform resets
//   • board regime: 7d total Δ ≥ +0.5% → RISK-ON · ≤ −0.5% → RISK-OFF ·
//     else NEUTRAL · any |pegDev| ≥ 1% forces RISK-OFF (depeg override)
//   • events: MINTBURN |Δ24h| ≥ $150M · DEPEG |pegDev| ≥ 0.5% · REGIME flip
//   • TG page (crit) on DEPEG ≥ 1%, rate-limited 6h — fully fail-silent
//   • GET /health (open) · GET /board (open) — plain bun, NO --hot (LEASH-0929b:
//     hot-reload mid-life inode replacement = zombie module timers, seen twice)
// ─────────────────────────────────────────────────────────────────────────────
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";

const VER = "stable-feed 1.0.1";
const ROOT = "/home/z/my-project";
const DATA = `${ROOT}/.data/stable-feed`;
const BOARD = `${DATA}/board.json`;
const EVENTS = `${DATA}/events.jsonl`;
const BACKFILL_DIR = `${DATA}/backfill`;
const BACKFILL_MARKER = `${DATA}/backfill-done.json`;
const PORT = 3017;

const POLL_MS = 15 * 60_000;
const FIRST_POLL_DELAY_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
const LLAMA = "https://stablecoins.llama.fi";

// thresholds — mirror src/lib/stableflow.ts (ONE doctrine, two readers)
const REGIME_ON_PCT = 0.5;
const REGIME_OFF_PCT = -0.5;
const DEPEG_WARN_PCT = 0.5;
const DEPEG_MUTE_PCT = 1.0;
const MINTBURN_USD = 150e6;
const TG_DEPEG_COOLDOWN_MS = 6 * 3600_000;

const TRACKED = ["USDT", "USDC", "DAI", "USDE", "USDS"] as const;
type TrackedKey = (typeof TRACKED)[number];

const nowMs = () => Date.now();
const tehran = (d: number | Date = nowMs()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);

// ── tiny log + counters ─────────────────────────────────────────────────────
const LOG = `${ROOT}/logs/stable-feed.log`;
function log(level: "info" | "warn" | "crit", msg: string, extra: Record<string, unknown> = {}) {
  try { appendLine(`${tehran()} ${level.toUpperCase()} ${msg} ${JSON.stringify(extra)}`, LOG); } catch { /* never */ }
}
function appendLine(line: string, file: string) {
  try { writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + line + "\n"); } catch { /* never */ }
}
const counters = { polls: 0, pollErrors: 0, consecutiveErrors: 0, events: 0, tgPages: 0, lastPollAt: 0, lastOkAt: 0, backfilledAt: 0 };

// ── atomic json write ───────────────────────────────────────────────────────
function writeJsonAtomic(file: string, obj: unknown) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, file);
}

// ── telegram (fail-silent; .env file-first like p0-watchdog) ────────────────
function envFromDotenv(key: string): string | null {
  try {
    const m = readFileSync(`${ROOT}/.env`, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") || null : null;
  } catch { return null; }
}
function tgChat(): string | null {
  const env = envFromDotenv("TELEGRAM_CHAT_ID");
  if (env) return env;
  try {
    const db = new Database(`${ROOT}/db/custom.db`, { readonly: true });
    const row = db.query("SELECT value FROM EngineSetting WHERE key = 'telegram.chatId'").get() as { value: string } | null;
    db.close();
    return row?.value ?? null;
  } catch { return null; }
}
let lastTgAt = 0;
async function tgSendCrit(text: string) {
  const token = envFromDotenv("TELEGRAM_BOT_TOKEN");
  const chat = tgChat();
  if (!token || !chat) return;
  if (nowMs() - lastTgAt < TG_DEPEG_COOLDOWN_MS) return;
  lastTgAt = nowMs();
  counters.tgPages += 1;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* fail-silent */ }
}

// ── defillama fetchers ──────────────────────────────────────────────────────
async function llamaJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "nexus-stable-feed/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
interface LlamaAsset { id: number; name: string; symbol: string; price?: number; pegType?: string; circulating?: { peggedUSD?: number } }
type ChartPoint = { date: number; usd: number };

function normalizeChart(raw: unknown): ChartPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: ChartPoint[] = [];
  for (const p of raw as Array<Record<string, unknown>>) {
    const date = Number(p.date);
    if (!Number.isFinite(date)) continue;
    const tc = p.totalCirculating as { peggedUSD?: number } | undefined;
    const usd = Number(tc?.peggedUSD ?? p.peggedUSD ?? p.totalCirculatingUnquoted);
    if (Number.isFinite(usd) && usd > 0) out.push({ date: date * 1000, usd });
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}

// Δ% vs the point closest to `msBack` ago, honest-null when the grid is too
// coarse (spacing-tolerant: tolerance = max(0.6 × median gap, 30min))
function deltaPct(series: ChartPoint[], msBack: number): number | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1]!;
  const target = last.date - msBack;
  let best: ChartPoint | null = null;
  let bestDist = Infinity;
  for (let i = series.length - 1; i >= 0 && last.date - series[i]!.date < msBack * 4; i--) {
    const d = Math.abs(series[i]!.date - target);
    if (d < bestDist) { bestDist = d; best = series[i]!; }
  }
  if (!best || best.usd <= 0) return null;
  const gaps: number[] = [];
  for (let i = Math.max(1, series.length - 6); i < series.length; i++) gaps.push(series[i]!.date - series[i - 1]!.date);
  gaps.sort((a, b) => a - b);
  const medGap = gaps[Math.floor(gaps.length / 2)] ?? 86_400_000;
  const tol = Math.max(0.6 * medGap, 30 * 60_000);
  if (bestDist > tol) return null;
  return ((last.usd - best.usd) / best.usd) * 100;
}
function deltaUsd(series: ChartPoint[], msBack: number): number | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1]!;
  const target = last.date - msBack;
  let best: ChartPoint | null = null;
  let bestDist = Infinity;
  for (let i = series.length - 1; i >= 0 && last.date - series[i]!.date < msBack * 4; i--) {
    const d = Math.abs(series[i]!.date - target);
    if (d < bestDist) { bestDist = d; best = series[i]!; }
  }
  if (!best || best.usd <= 0) return null;
  return last.usd - best.usd;
}

// in-memory series cache (per key) so the live board can reuse the chart from
// the previous cycle when a per-asset fetch fails (fail-soft, honest staleness)
const seriesCache = new Map<string, ChartPoint[]>();

// ── board assembly ──────────────────────────────────────────────────────────
interface AssetBoard {
  asset: string; mcapUsd: number | null; delta1hPct: number | null; delta24hPct: number | null;
  delta24hUsd: number | null; delta7dPct: number | null; pegDevPct: number | null;
}
interface Board {
  at: number; totalMcapUsd: number | null; totalDelta24hPct: number | null; totalDelta7dPct: number | null;
  assets: AssetBoard[]; maxPegDevPct: number | null; regime: "RISK-ON" | "NEUTRAL" | "RISK-OFF"; regimeReason: string;
}
let lastRegime: string | null = null;
// v1.0.1 event latch: journal on TRANSITION only — while a condition stays
// true (e.g. USDC Δ24h beyond threshold for hours) we log it ONCE, not every
// poll. Unlatches when the condition clears; restarts reset the latch (one
// honest duplicate per restart is acceptable).
const eventLatch = new Map<string, boolean>();
function latchOnce(key: string, cond: boolean): boolean {
  const prev = eventLatch.get(key) ?? false;
  eventLatch.set(key, cond);
  return cond && !prev;
}

function buildBoard(total: ChartPoint[], assets: AssetBoard[]): Board {
  const totalMcap = total.length ? total[total.length - 1]!.usd : null;
  const d24 = deltaPct(total, 24 * 3600_000);
  const d7 = deltaPct(total, 7 * 24 * 3600_000);
  const worstPeg = assets
    .map((a) => ({ asset: a.asset, dev: a.pegDevPct }))
    .filter((x): x is { asset: string; dev: number } => x.dev !== null)
    .sort((x, y) => Math.abs(y.dev) - Math.abs(x.dev))[0];
  const maxPegDevPct = worstPeg ? worstPeg.dev : null;

  let regime: Board["regime"] = "NEUTRAL";
  let reason = `7d total Δ ${d7 === null ? "n/a" : `${d7 >= 0 ? "+" : ""}${d7.toFixed(2)}%`} inside ±${REGIME_ON_PCT}% band`;
  if (d7 !== null && d7 >= REGIME_ON_PCT) { regime = "RISK-ON"; reason = `7d stable supply +${d7.toFixed(2)}% ≥ +${REGIME_ON_PCT}% — fresh liquidity entering`; }
  else if (d7 !== null && d7 <= REGIME_OFF_PCT) { regime = "RISK-OFF"; reason = `7d stable supply ${d7.toFixed(2)}% ≤ ${REGIME_OFF_PCT}% — liquidity contracting`; }
  if (worstPeg && Math.abs(worstPeg.dev) >= DEPEG_MUTE_PCT) {
    regime = "RISK-OFF";
    reason = `DEPEG override: ${worstPeg.asset} ${worstPeg.dev >= 0 ? "+" : ""}${worstPeg.dev.toFixed(2)}% off peg (≥ ±${DEPEG_MUTE_PCT}%)`;
  }
  return { at: nowMs(), totalMcapUsd: totalMcap, totalDelta24hPct: d24, totalDelta7dPct: d7, assets, maxPegDevPct, regime, regimeReason: reason };
}

function journalEvent(e: { kind: "MINTBURN" | "DEPEG" | "REGIME"; asset: string; text: string; sev?: "info" | "warn" | "crit" }) {
  try {
    appendLine(JSON.stringify({ ts: nowMs(), ...e }) + "\n", EVENTS);
    counters.events += 1;
    log("info", `event:${e.kind}`, { asset: e.asset });
  } catch { /* never */ }
}

// ── backfill (once; marker-gated; self-heals after workspace resets) ────────
async function runBackfill(idByKey: Map<string, number>) {
  const jobs: Array<{ key: string; id: number | "TOTAL" }> = [{ key: "TOTAL", id: "TOTAL" as const }];
  for (const [key, id] of idByKey) jobs.push({ key, id });
  const counts: Record<string, number> = {};
  for (const j of jobs) {
    try {
      const url = j.id === "TOTAL" ? `${LLAMA}/stablecoincharts/all` : `${LLAMA}/stablecoincharts/all?stablecoin=${j.id}`;
      const series = normalizeChart(await llamaJson(url));
      writeJsonAtomic(`${BACKFILL_DIR}/${j.key}.json`, { asset: j.key, fetchedAt: nowMs(), points: series.map((p) => [p.date, p.usd]) });
      counts[j.key] = series.length;
      log("info", `backfill:${j.key}`, { points: series.length });
    } catch (e) {
      counts[j.key] = -1;
      log("warn", `backfill-fail:${j.key}`, { err: String(e).slice(0, 90) });
    }
  }
  writeJsonAtomic(BACKFILL_MARKER, { at: nowMs(), counts });
  counters.backfilledAt = nowMs();
  const okCount = Object.values(counts).filter((v) => v > 0).length;
  log("info", `backfill done ${okCount}/${jobs.length}`, {});
}

// ── one poll cycle ──────────────────────────────────────────────────────────
async function poll() {
  counters.polls += 1;
  counters.lastPollAt = nowMs();
  try {
    const list = (await llamaJson(`${LLAMA}/stablecoins?includePrices=true`)) as { peggedAssets: LlamaAsset[] };
    const byKey = new Map<string, LlamaAsset>();
    for (const a of list.peggedAssets ?? []) {
      const sym = String(a.symbol ?? "").toUpperCase();
      if ((TRACKED as readonly string[]).includes(sym) && !byKey.has(sym)) byKey.set(sym, a);
    }
    const assets: AssetBoard[] = [];
    const idByKey = new Map<string, number>();
    for (const key of TRACKED) {
      const a = byKey.get(key);
      const mcap = a?.circulating?.peggedUSD ?? null;
      let peg: number | null = null;
      if (a && Number.isFinite(Number(a.price)) && Number(a.price) > 0) peg = (Number(a.price) - 1) * 100;
      let s = seriesCache.get(key);
      if (a) {
        idByKey.set(key, a.id);
        try {
          const fresh = normalizeChart(await llamaJson(`${LLAMA}/stablecoincharts/all?stablecoin=${a.id}`));
          if (fresh.length > 0) { seriesCache.set(key, fresh); s = fresh; }
        } catch { /* reuse cached series — fail-soft */ }
      }
      assets.push({
        asset: key,
        mcapUsd: mcap === null ? null : Number(mcap),
        delta1hPct: s ? deltaPct(s, 3600_000) : null,
        delta24hPct: s ? deltaPct(s, 24 * 3600_000) : null,
        delta24hUsd: s ? deltaUsd(s, 24 * 3600_000) : null,
        delta7dPct: s ? deltaPct(s, 7 * 24 * 3600_000) : null,
        pegDevPct: peg === null ? null : Math.round(peg * 100) / 100,
      });
    }
    let total = seriesCache.get("TOTAL");
    try {
      const t = normalizeChart(await llamaJson(`${LLAMA}/stablecoincharts/all`));
      if (t.length > 0) { seriesCache.set("TOTAL", t); total = t; }
    } catch { /* reuse cached */ }
    if (!total || total.length === 0) throw new Error("no total series available");

    const board = buildBoard(total, assets);
    writeJsonAtomic(BOARD, board);
    counters.consecutiveErrors = 0;
    counters.lastOkAt = nowMs();

    // events — thresholds mirror the lib doctrine; LATCHED (transition-only)
    for (const a of board.assets) {
      const mb = a.delta24hUsd !== null && Math.abs(a.delta24hUsd) >= MINTBURN_USD;
      if (latchOnce(`mb:${a.asset}`, mb)) {
        journalEvent({ kind: "MINTBURN", asset: a.asset, sev: "info", text: `Δ24h ${a.delta24hUsd! >= 0 ? "+" : ""}${(a.delta24hUsd! / 1e6).toFixed(0)}M$ (${(a.delta24hPct ?? 0).toFixed(2)}%) — crossed mint/burn proxy threshold ${MINTBURN_USD / 1e6}M$` });
      }
      const dp = a.pegDevPct !== null && Math.abs(a.pegDevPct) >= DEPEG_WARN_PCT;
      if (latchOnce(`dp:${a.asset}`, dp)) {
        journalEvent({ kind: "DEPEG", asset: a.asset, sev: Math.abs(a.pegDevPct!) >= DEPEG_MUTE_PCT ? "crit" : "warn", text: `peg deviation ${a.pegDevPct! >= 0 ? "+" : ""}${a.pegDevPct!.toFixed(2)}%` });
        if (Math.abs(a.pegDevPct!) >= DEPEG_MUTE_PCT) {
          void tgSendCrit(`🚨 <b>NEXUS · DEPEG-MUTE ARMED</b>\n<code>${a.asset}</code> peg ${a.pegDevPct! >= 0 ? "+" : ""}${a.pegDevPct!.toFixed(2)}% — systemic stablecoin emergency\nNEW DEPLOYS ARE MUTED (fail-closed)\n<code>${tehran()}</code> IRST`);
        }
      }
    }
    if (lastRegime && lastRegime !== board.regime) {
      journalEvent({ kind: "REGIME", asset: "TOTAL", sev: board.regime === "RISK-OFF" ? "warn" : "info", text: `${lastRegime} → ${board.regime} — ${board.regimeReason}` });
    }
    lastRegime = board.regime;
    log("info", "poll ok", { regime: board.regime, total: board.totalMcapUsd ? `${(board.totalMcapUsd / 1e9).toFixed(1)}B` : "?" });
    // lazy backfill: if a previous backfill is missing keys (marker counts -1),
    // retry once per day — honest self-healing without boot-loop hammering
    const marker = existsSync(BACKFILL_MARKER) ? JSON.parse(readFileSync(BACKFILL_MARKER, "utf8")) : null;
    if (!marker || Object.values(marker.counts ?? {}).some((v) => (v as number) < 0)) {
      if (!marker || nowMs() - (marker.at ?? 0) > 24 * 3600_000) await runBackfill(idByKey);
    }
  } catch (e) {
    counters.pollErrors += 1;
    counters.consecutiveErrors += 1;
    log("warn", "poll failed", { err: String(e).slice(0, 140), consecutive: counters.consecutiveErrors });
  }
}

// ── control plane ───────────────────────────────────────────────────────────
function boardSummary() {
  try {
    const b = JSON.parse(readFileSync(BOARD, "utf8")) as Board;
    return { regime: b.regime, totalMcapUsd: b.totalMcapUsd, at: b.at, ageSec: Math.floor((nowMs() - b.at) / 1000) };
  } catch { return null; }
}
function handle(req: Request): Response {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    const healthy = counters.consecutiveErrors < 3;
    return Response.json({
      ok: healthy, ver: VER, pid: process.pid, port: PORT, tehran: tehran(),
      polls: counters.polls, pollErrors: counters.pollErrors, consecutiveErrors: counters.consecutiveErrors,
      lastPollAt: counters.lastPollAt || null, lastOkAt: counters.lastOkAt || null,
      backfill: existsSync(BACKFILL_MARKER) ? JSON.parse(readFileSync(BACKFILL_MARKER, "utf8")) : { done: false },
      events: counters.events, tgPages: counters.tgPages,
      board: boardSummary(),
    }, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/board") {
    try { return Response.json(JSON.parse(readFileSync(BOARD, "utf8")), { headers: { "cache-control": "no-store" } }); }
    catch { return Response.json({ ok: false, error: "no board yet" }, { status: 503 }); }
  }
  return new Response("stable-feed: 404\n", { status: 404 });
}

// ── boot ────────────────────────────────────────────────────────────────────
mkdirSync(DATA, { recursive: true });
mkdirSync(BACKFILL_DIR, { recursive: true });
try { Bun.serve({ port: PORT, fetch: handle }); } catch (e) {
  console.log(`[${tehran()}] port ${PORT} busy — exiting: ${String(e).slice(0, 100)}`);
  process.exit(0);
}
log("info", `boot ${VER}`, { pid: process.pid, port: PORT });
console.log(`[${tehran()}] ${VER} armed on :${PORT} — tracked: ${TRACKED.join(" ")} · poll ${POLL_MS / 60000}min · source: DefiLlama (free, no key)`);

// backfill: marker-gated (skip when a healthy one exists)
if (existsSync(BACKFILL_MARKER)) {
  try {
    const m = JSON.parse(readFileSync(BACKFILL_MARKER, "utf8"));
    counters.backfilledAt = m.at ?? 0;
    if (Object.values(m.counts ?? {}).every((v) => (v as number) > 0)) {
      log("info", "backfill already present — skipped", { counts: m.counts });
    }
  } catch { /* refetch below */ }
}

const g = globalThis as typeof globalThis & { __sfTimer?: ReturnType<typeof setInterval> };
setTimeout(() => {
  if (g.__sfTimer) clearInterval(g.__sfTimer);
  void poll(); // first live board fast — gates need data soon
  g.__sfTimer = setInterval(() => void poll(), POLL_MS);
}, FIRST_POLL_DELAY_MS);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("uncaughtException", (e) => { log("crit", "uncaught", { err: String(e).slice(0, 180) }); });
