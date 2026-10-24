// ── NEXUS//SIGNALS · card-sentinel :3022 ─────────────────────────────────────
// v12.12 (2026-10-24, operator order: «ساخت ماژول نظارت و پیگیری کارت‌های کهنه
// و بروزرسانی در سریعترین حالت») — flow-card freshness governor.
//
// MISSION: the dashboard's flow cards (FlowScan rows) went stale for hours on
// exactly the symbols that mattered (BIRBUSDT cards 4h9m old while its cascade
// events kept firing; KATUSDT 43 days). Root cause: the two-speed rotation
// drops cooled symbols into the dust tail and nothing watches card AGE.
//
// DESIGN (read-only on the ledger — Prisma/engine own writes):
//   · every CARD_TICK_MS: read FlowScan/VolCauseEvent/MarketAsset via bun:sqlite
//     READONLY → classify per-symbol card age budget by heat:
//       hot  (event <45min OR |Δ24h| ≥ 20%) → budget 15min
//       warm (event <3h   OR |Δ24h| ≥ 10%) → budget 45min
//       dust (else)                        → budget 24h (slow revive lane)
//   · stale > budget → POST :3000/api/internal/flow-refresh?symbol=X
//     (route enforces 90s/symbol; scanner is single-flight; 30s timeout here)
//   · RAM-aware: cycle SKIPPED when avail < RAM_FLOOR_MB (never add pressure —
//     the 10-24 boot-treadmill lesson)
//   · app-down tolerant: probe /api/healthz first; skip cycle when down
//   · telemetry: /health · /state · .data/card-sentinel-state.json (atomic)
//
// LEASH doctrine: plain bun, no secrets, loopback-only writes to the app API.

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const PORT = 3022;
const VER = "card-sentinel 1.0.0";
const ROOT = "/home/z/my-project";
const DB_PATH = `${ROOT}/db/custom.db`;
const STATE_PATH = `${ROOT}/.data/card-sentinel-state.json`;
const APP = "http://127.0.0.1:3000";

const CARD_TICK_MS = 45_000;
const RAM_FLOOR_MB = 400;
const MAX_REFRESH_PER_CYCLE = 6;
const CONCURRENCY = 2;
const PER_SYMBOL_MIN_MS = 6 * 60_000; // never re-refresh a symbol faster than 6min
const DUST_SLOTS_PER_CYCLE = 1;       // the 43-day tail revives at 1/cycle — bounded

const HOT_EVENT_AGE_MS = 45 * 60_000;
const HOT_BUDGET_MS = 15 * 60_000;
const WARM_EVENT_AGE_MS = 3 * 3600_000;
const WARM_BUDGET_MS = 45 * 60_000;
const DUST_BUDGET_MS = 24 * 3600_000;

const BOOT = Date.now();
let ticks = 0;
let lastTickAt = 0;
let lastCycleAt = 0;
let lastRefreshOkAt = 0;
let refreshedRing: number[] = []; // timestamps of successful refreshes (1h ring)
let failedRing: number[] = [];
let lastTop: { symbol: string; ageMin: number; heat: string }[] = [];

const tehran = (): string =>
  new Date(Date.now() + 3.5 * 3600e3).toISOString().replace("T", " ").slice(0, 19);

function log(level: "info" | "warn" | "crit", event: string, data: Record<string, unknown> = {}) {
  try {
    console.log(`[${tehran()}] ${level.toUpperCase()} ${event} ${JSON.stringify(data)}`);
  } catch { /* logging never kills */ }
}

const refreshRingCount = (ring: number[]): number => {
  const cutoff = Date.now() - 3600_000;
  while (ring.length && ring[0] < cutoff) ring.shift();
  return ring.length;
};

// ── DB read model (readonly) ──────────────────────────────────────────────────
interface CardRow { symbol: string; ageMin: number; heat: "hot" | "warm" | "dust"; change24h: number; lastEventMin: number }

function readCards(): { cards: CardRow[]; appDbError: string | null } {
  let db: Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    db.exec("PRAGMA busy_timeout=2500");
    const now = Date.now();
    // worst (oldest) card age per symbol — one row per symbol
    const cardAges = db
      .query(
        `SELECT symbol, MIN(updatedAt) oldestAt, COUNT(*) tfs FROM FlowScan GROUP BY symbol`
      )
      .all() as { symbol: string; oldestAt: number; tfs: number }[];
    // if ANY card of the symbol is old, the panel looks broken → track OLDEST card:
    const oldest = db
      .query(`SELECT symbol, MIN(updatedAt) at FROM FlowScan GROUP BY symbol`)
      .all() as { symbol: string; at: number }[];
    void cardAges;
    const lastEvents = new Map<string, number>(
      (
        db
          .query(
            `SELECT symbol, MAX(detectedAt) at FROM VolCauseEvent WHERE detectedAt > ${now - 24 * 3600e3} GROUP BY symbol`
          )
          .all() as { symbol: string; at: number }[]
      ).map((r) => [r.symbol, r.at])
    );
    const assets = db
      .query(`SELECT symbol, change24h FROM MarketAsset`)
      .all() as { symbol: string; change24h: number | null }[];
    const change = new Map(assets.map((a) => [a.symbol, a.change24h ?? 0]));

    const cards: CardRow[] = oldest.map((o) => {
      const ageMin = Math.round((now - o.at) / 60_000);
      const evMin = lastEvents.has(o.symbol) ? Math.round((now - (lastEvents.get(o.symbol) as number)) / 60_000) : 999999;
      const c24 = Math.abs(change.get(o.symbol) ?? 0);
      const heat: CardRow["heat"] =
        evMin <= 45 || c24 >= 20 ? "hot" : evMin <= 180 || c24 >= 10 ? "warm" : "dust";
      return { symbol: o.symbol, ageMin, heat, change24h: c24, lastEventMin: evMin };
    });
    return { cards, appDbError: null };
  } catch (e: unknown) {
    return { cards: [], appDbError: String(e).slice(0, 160) };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

function budgetMs(heat: CardRow["heat"]): number {
  return heat === "hot" ? HOT_BUDGET_MS : heat === "warm" ? WARM_BUDGET_MS : DUST_BUDGET_MS;
}

// ── refresh lane ─────────────────────────────────────────────────────────────
const lastRefreshAttempt = new Map<string, number>();

async function refreshSymbol(symbol: string): Promise<boolean | "skipped"> {
  try {
    const res = await fetch(`${APP}/api/internal/flow-refresh?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; skipped?: string };
    if (res.ok && j.ok) return j.skipped ? "skipped" : true; // v1.0.1 — rate-limit is neutral, not failure
    return false;
  } catch {
    return false;
  }
}

async function appAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${APP}/api/healthz`, { signal: AbortSignal.timeout(4_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function readAvailMb(): number {
  try {
    const m = readFileSync("/proc/meminfo", "utf8");
    const hit = m.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return hit ? Math.round(Number(hit[1]) / 1024) : -1;
  } catch {
    return -1;
  }
}

async function cycle(): Promise<void> {
  const avail = readAvailMb();
  if (avail >= 0 && avail < RAM_FLOOR_MB) {
    log("warn", "cycle-skipped-ram", { availMb: avail, floor: RAM_FLOOR_MB });
    return;
  }
  if (!(await appAlive())) {
    log("warn", "cycle-skipped-app-down", {});
    return;
  }
  const { cards, appDbError } = readCards();
  if (appDbError) {
    log("crit", "db-read-failed", { err: appDbError });
    return;
  }
  const now = Date.now();
  const stale = cards
    .filter((c) => c.ageMin * 60_000 > budgetMs(c.heat))
    .filter((c) => now - (lastRefreshAttempt.get(c.symbol) ?? 0) > PER_SYMBOL_MIN_MS);
  const heatRank = { hot: 0, warm: 1, dust: 2 } as const;
  stale.sort((a, b) => heatRank[a.heat] - heatRank[b.heat] || b.ageMin - a.ageMin);
  const hotStale = stale.filter((c) => c.heat === "hot");
  const warmStale = stale.filter((c) => c.heat === "warm");
  const dustStale = stale.filter((c) => c.heat === "dust");
  const batch = [
    ...hotStale.slice(0, MAX_REFRESH_PER_CYCLE),
    ...warmStale.slice(0, Math.max(0, MAX_REFRESH_PER_CYCLE - hotStale.length)),
    ...dustStale.slice(0, DUST_SLOTS_PER_CYCLE),
  ];
  lastTop = [...cards]
    .filter((c) => c.heat !== "dust")
    .sort((a, b) => b.ageMin - a.ageMin)
    .slice(0, 12)
    .map((c) => ({ symbol: c.symbol, ageMin: c.ageMin, heat: c.heat }));

  if (batch.length === 0) {
    lastCycleAt = Date.now();
    return;
  }
  log("info", "refresh-batch", {
    staleHot: hotStale.length,
    staleWarm: warmStale.length,
    staleDust: dustStale.length,
    batch: batch.map((b) => `${b.symbol}:${b.heat}:${b.ageMin}m`),
  });
  // bounded concurrency lane
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < batch.length) {
      const c = batch[idx++];
      lastRefreshAttempt.set(c.symbol, Date.now());
      const ok = await refreshSymbol(c.symbol);
      if (ok === true) {
        refreshedRing.push(Date.now());
        lastRefreshOkAt = Date.now();
      } else if (ok === false) {
        failedRing.push(Date.now());
      } // "skipped" → neutral, no ring
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
  lastCycleAt = Date.now();
  log("info", "refresh-cycle-done", {
    ok: refreshRingCount(refreshedRing),
    fail: refreshRingCount(failedRing),
  });
}

// ── state persistence (atomic) ───────────────────────────────────────────────
function persistState(): void {
  try {
    const payload = {
      ver: VER,
      at: new Date().toISOString(),
      tehran: tehran(),
      ticks,
      lastTickAt,
      lastCycleAt,
      lastRefreshOkAt,
      refreshed1h: refreshRingCount(refreshedRing),
      failures1h: refreshRingCount(failedRing),
      staleHot: lastTop.filter((t) => t.heat === "hot").length,
      top: lastTop,
    };
    const tmp = `${STATE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, STATE_PATH);
  } catch { /* best-effort */ }
}

// ── main loops ───────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  ticks++;
  lastTickAt = Date.now();
  try {
    await cycle();
  } catch (e: unknown) {
    log("crit", "tick-error", { err: String(e).slice(0, 200) });
  }
  persistState();
}

function scheduleTick(): void {
  setTimeout(async () => {
    try {
      await tick();
    } catch { /* self-reaping */ }
    scheduleTick();
  }, CARD_TICK_MS).unref?.();
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        ver: VER,
        pid: process.pid,
        uptimeSec: Math.floor((Date.now() - BOOT) / 1000),
        lastTickAt,
        ticks,
        tehran: tehran(),
      });
    }
    if (url.pathname === "/state") {
      return Response.json({
        ok: true,
        ver: VER,
        ticks,
        lastTickAt,
        lastCycleAt,
        lastRefreshOkAt,
        refreshed1h: refreshRingCount(refreshedRing),
        failures1h: refreshRingCount(failedRing),
        staleHot: lastTop.filter((t) => t.heat === "hot").length,
        top: lastTop,
      });
    }
    return new Response("card-sentinel\n", { status: 404 });
  },
});

log("info", "armed", { ver: VER, port: PORT, tickMs: CARD_TICK_MS, ramFloor: RAM_FLOOR_MB });
// first pass after a short settle delay (let the app finish its own boot first)
setTimeout(() => void tick(), 20_000).unref?.();
scheduleTick();
