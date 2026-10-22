// ── Task 79 GOLDEN-LANE — pre-registered paper evaluation of the Task-78
// Golden Formula v1.0 (operator mandate 2026-10-05 «اقدامات لازم را کامل و
// مهندسی انجام بده») ─────────────────────────────────────────────────────────
// The Task-78 pipeline (dataset 78-3a → Monte-Carlo/annealing search 78-3b →
// adversarial risk engineering 78-3c) produced ONE edge that survived White's
// Reality Check (p=0.039) and a champion formula. Doctrine: 7d PAPER → live
// $2 → day-30 re-run. THIS module is the 7d paper gate.
//
// Design invariants (the honesty rails):
//  · PRE-REGISTERED — the filter config + window are written to
//    .data/golden-lane-preregister.json (with SHA-256) on first boot and can
//    never be edited in place afterwards; any mismatch flags TAMPERED.
//  · ANTI-LOOKAHEAD — membership uses ONLY entry-observable fields
//    (engine, createdAt hour, tp1 distance, leverage, confidence, strategy);
//    outcome fields (status, pnl, holding, ttlExtensions…) never filter.
//  · RIDE-REAL-FLOWS — the lane opens no trades; it rides the REAL deployed
//    signal stream and rescales each match's realized ledger net to the
//    doctrine's $2 flat margin (net is linear in margin: gross, taker fees
//    and funding all scale with marginUsd).
//  · RAILS NON-NEGOTIABLE — daily −$5 / weekly −$10 evaluated per lane;
//    kill-switches K1..K4 straight from the 78-3c doctrine.
//  · FAIL-OPEN — every read/journal error is swallowed; the lane can never
//    disturb the live engine (it runs inside the pulse call path).

import { db } from "@/lib/db";
import { sendDirect } from "@/lib/notify"; // v11.6 EQ-97 — adjudication push
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const PREREG_FILE = path.join(DATA_DIR, "golden-lane-preregister.json");
const SNAPSHOT_FILE = path.join(DATA_DIR, "golden-lane-latest.json");
const JOURNAL_FILE = path.join(DATA_DIR, "golden-lane.jsonl");
const ADJUDICATION_FILE = path.join(DATA_DIR, "golden-lane-adjudication.json"); // v11.6 EQ-97 — per-generation verdict of record

export const LANE_MARGIN_USD = 2; // doctrine: $2 flat per trade on a $100 bankroll
export const LANE_DAILY_STOP = -5; // doctrine rail: −$5 daily
export const LANE_WEEKLY_STOP = -10; // doctrine rail: −$10 weekly
export const WINDOW_DAYS = 7;
export const PROMOTE_MIN_N = 20; // doctrine: "positive with sufficient n" operationalized

export interface LaneConfig {
  id: "gfl-v1" | "r6-challenger";
  name: string;
  engineVersion: string | null; // exact engine string filter (null = any)
  tehranHours: number[];
  minTp1DistPct: number | null;
  maxLeverage: number | null;
  confidenceBand: [number, number] | null;
  excludeStrategies: string[];
  excludeRegimes: string[]; // regime parsed from flowJson; null regime = include
}

// ── The two pre-registered filters (Task-78 doctrine, verbatim) ────────────
export const LANE_CONFIGS: LaneConfig[] = [
  {
    id: "gfl-v1",
    name: "GOLDEN FORMULA v1.0 (78-3c champion)",
    engineVersion: "NEXUS-LIVE v10.18",
    tehranHours: [2, 4, 5, 10, 12, 17, 18],
    minTp1DistPct: 1.0,
    maxLeverage: 20,
    confidenceBand: null,
    excludeStrategies: [],
    excludeRegimes: [],
  },
  {
    id: "r6-challenger",
    name: "R6-EDGE challenger (Task-75, pre-registered parallel lane)",
    engineVersion: null,
    tehranHours: [2, 7, 18],
    minTp1DistPct: null,
    maxLeverage: null,
    confidenceBand: [70, 89],
    excludeStrategies: ["AI-SCALP"],
    excludeRegimes: ["TREND"],
  },
];

// ── Pre-registration store ──────────────────────────────────────────────────
interface Preregister {
  version: 1;
  /** v11.6 EQ-97 — measurement generation; ≥2 exists only after a formal
   *  window-end adjudication + paper-only re-registration (never in-place
   *  config mutation — the tamper flag stays meaningful). */
  generation?: number;
  registeredAt: number;
  windowStart: number;
  windowEnd: number;
  extensions: number;
  configSha256: string;
  configs: LaneConfig[];
}

const TZ_MS = 3.5 * 3600_000; // Tehran = UTC+3:30 (no DST since 2022)

function tehranHour(ms: number): number {
  return Math.floor(((ms + TZ_MS) % 86_400_000) / 3_600_000);
}
/** Saturday-start Tehran week index (Iranian work week). */
function tehranWeekIndex(ms: number): number {
  const tehranDays = Math.floor((ms + TZ_MS) / 86_400_000);
  return Math.floor((tehranDays + 2) / 7); // epoch Thu 1970-01-01 → +2 aligns Saturday=0 of week
}
function tehranDayIndex(ms: number): number {
  return Math.floor((ms + TZ_MS) / 86_400_000);
}

function configHash(configs: LaneConfig[]): string {
  return createHash("sha256").update(JSON.stringify(configs)).digest("hex");
}

function loadOrCreatePreregister(): Preregister {
  try {
    const raw = fs.readFileSync(PREREG_FILE, "utf8");
    const pr = JSON.parse(raw) as Preregister;
    if (!pr.generation || pr.generation < 1) pr.generation = 1; // v11.6 heal — gen-1 files predate the field
    if (pr.configSha256 !== configHash(pr.configs)) {
      // config edited after registration — keep window but flag loudly
      (pr as Preregister & { tampered?: boolean }).tampered = true;
    }
    return pr;
  } catch {
    const now = Date.now();
    const pr: Preregister = {
      version: 1,
      generation: 1,
      registeredAt: now,
      windowStart: now,
      windowEnd: now + WINDOW_DAYS * 86_400_000,
      extensions: 0,
      configSha256: configHash(LANE_CONFIGS),
      configs: LANE_CONFIGS,
    };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PREREG_FILE, JSON.stringify(pr, null, 1));
    } catch {
      /* read-only fs — lane still evaluates in memory */
    }
    return pr;
  }
}

// ── Match record (journal + snapshot) ───────────────────────────────────────
export interface LaneMatch {
  signalId: string;
  serial: number;
  lane: LaneConfig["id"];
  symbol: string;
  direction: string;
  strategy: string;
  engine: string;
  confidence: number;
  tehranHour: number;
  tp1DistPct: number;
  regime: string | null;
  rawCal: boolean;
  marginUsd: number;
  leverage: number;
  openedAt: number;
  /** entry-observable snapshot at membership time — nothing else was consulted */
  status: string; // ACTIVE | settled status
  closedAt: number | null;
  gross2: number | null; // pnlPercent/100 × $2 (actual margin removed)
  net2: number | null; // (gross − fee − swap) rescaled to $2
  win: boolean | null;
}

function regimeOf(flowJson: string | null): string | null {
  if (!flowJson) return null;
  try {
    const f = JSON.parse(flowJson) as Record<string, unknown>;
    const tag = (f.regimeTag ?? f.regime ?? (f.flow as Record<string, unknown> | undefined)?.regimeTag) as string | undefined;
    return typeof tag === "string" ? tag.replace("REGIME-", "") : null;
  } catch {
    return null;
  }
}

function matchesLane(sig: {
  engine: string; createdAt: Date; tp1: number; entryPrice: number; leverage: number;
  confidence: number; strategy: string; flowJson: string | null;
}, cfg: LaneConfig): boolean {
  if (cfg.engineVersion && sig.engine !== cfg.engineVersion) return false;
  if (!cfg.tehranHours.includes(tehranHour(sig.createdAt.getTime()))) return false;
  if (cfg.maxLeverage !== null && sig.leverage > cfg.maxLeverage) return false;
  if (cfg.confidenceBand && (sig.confidence < cfg.confidenceBand[0] || sig.confidence > cfg.confidenceBand[1])) return false;
  if (cfg.excludeStrategies.includes(sig.strategy)) return false;
  if (cfg.excludeRegimes.length) {
    const reg = regimeOf(sig.flowJson);
    if (reg && cfg.excludeRegimes.includes(reg)) return false;
  }
  if (cfg.minTp1DistPct !== null && sig.entryPrice > 0) {
    const dist = (Math.abs(sig.tp1 - sig.entryPrice) / sig.entryPrice) * 100;
    if (dist < cfg.minTp1DistPct) return false;
  }
  return true;
}

function toMatch(sig: {
  id: string; serial: number; symbol: string; direction: string; strategy: string;
  engine: string; confidence: number; createdAt: Date; tp1: number; entryPrice: number;
  leverage: number; marginUsd: number; status: string; closedAt: Date | null;
  pnlPercent: number; feeUsd: number; swapUsd: number; tags: string;
  flowJson: string | null;
}, cfg: LaneConfig): LaneMatch {
  const settled = sig.closedAt !== null && sig.status !== "ACTIVE";
  const margin = sig.marginUsd > 0 ? sig.marginUsd : LANE_MARGIN_USD; // zero-margin guard
  const scale = LANE_MARGIN_USD / margin;
  const gross2 = settled ? (sig.pnlPercent / 100) * LANE_MARGIN_USD : null;
  const net2 = settled ? ((sig.pnlPercent / 100) * margin - sig.feeUsd - sig.swapUsd) * scale : null;
  return {
    signalId: sig.id,
    serial: sig.serial,
    lane: cfg.id,
    symbol: sig.symbol,
    direction: sig.direction,
    strategy: sig.strategy,
    engine: sig.engine,
    confidence: sig.confidence,
    tehranHour: tehranHour(sig.createdAt.getTime()),
    // Task 80 fix: direction-aware distance (SHORT tp1 sits BELOW entry — the
    // raw tp1−entry ratio journaled negative for shorts; filter logic always
    // used abs, this corrects the telemetry only)
    tp1DistPct: Number((Math.abs((sig.tp1 - sig.entryPrice) / sig.entryPrice) * 100).toFixed(3)),
    regime: regimeOf(sig.flowJson),
    rawCal: sig.tags.includes("RAW-CAL"),
    marginUsd: sig.marginUsd,
    leverage: sig.leverage,
    openedAt: sig.createdAt.getTime(),
    status: settled ? sig.status : "ACTIVE",
    closedAt: sig.closedAt ? sig.closedAt.getTime() : null,
    gross2,
    net2,
    win: settled ? sig.pnlPercent > 0 : null,
  };
}

// ── In-memory state (rebuilt from snapshot on cold start) ───────────────────
interface LaneState {
  matches: LaneMatch[];
  journaled: Set<string>; // `${lane}:${signalId}` already appended to journal
}

let state: LaneState | null = null;
let syncInFlight: Promise<void> | null = null;
let lastSyncAt = 0;
let lastError: string | null = null;

function loadState(): LaneState {
  if (state) return state;
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")) as { matches?: LaneMatch[] };
    const matches = Array.isArray(snap.matches) ? snap.matches : [];
    return (state = { matches, journaled: new Set(matches.map((m) => `${m.lane}:${m.signalId}`)) });
  } catch {
    return (state = { matches: [], journaled: new Set() });
  }
}

function appendJournal(matches: LaneMatch[]): void {
  if (!matches.length) return;
  try {
    fs.appendFileSync(JOURNAL_FILE, matches.map((m) => JSON.stringify(m)).join("\n") + "\n");
  } catch {
    /* journal is audit-only; snapshot is the state of record */
  }
}

function writeSnapshot(matches: LaneMatch[]): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SNAPSHOT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ generatedAt: Date.now(), matches }));
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch {
    /* fail-open */
  }
}

async function syncLane(): Promise<void> {
  const pr = loadOrCreatePreregister();
  const st = loadState();
  const windowStartMs = pr.windowStart; // extensions move windowEnd, never the start
  // settled ACTIVES need re-sync: fetch unsettled matches by id in the same pass
  const openIds = st.matches.filter((m) => m.status === "ACTIVE").map((m) => m.signalId);
  const rows = await db.signal.findMany({
    where: { OR: [{ createdAt: { gte: new Date(windowStartMs) } }, { id: { in: openIds } }] },
    select: {
      id: true, serial: true, symbol: true, direction: true, strategy: true, engine: true,
      confidence: true, createdAt: true, tp1: true, entryPrice: true, leverage: true,
      marginUsd: true, status: true, closedAt: true, pnlPercent: true, feeUsd: true,
      swapUsd: true, tags: true, flowJson: true,
    },
  });
  const fresh: LaneMatch[] = [];
  // v11.6 EQ-97 — the PRE-REGISTER's configs are the source of truth (gen-2
  // re-pins the gfl lane to the live engine; matching must follow, not the
  // module-level gen-1 constants).
  const configs = pr.configs?.length ? pr.configs : LANE_CONFIGS;
  for (const sig of rows) {
    for (const cfg of configs) {
      const key = `${cfg.id}:${sig.id}`;
      if (st.journaled.has(key)) continue;
      if (!matchesLane(sig, cfg)) continue;
      const m = toMatch(sig, cfg);
      st.journaled.add(key);
      fresh.push(m); // a signal may match both lanes — matches are keyed per (lane,signalId)
    }
  }
  // refresh unsettled: update status/outcome of existing matches
  for (const m of st.matches) {
    if (m.status !== "ACTIVE") continue;
    const sig = rows.find((r) => r.id === m.signalId);
    if (!sig) continue;
    const settled = sig.closedAt !== null && sig.status !== "ACTIVE";
    if (!settled) continue;
    const refreshed = toMatch(sig, LANE_CONFIGS.find((c) => c.id === m.lane)!);
    Object.assign(m, refreshed);
  }
  if (fresh.length) {
    appendJournal(fresh);
    st.matches.push(...fresh);
  }
  writeSnapshot(st.matches);
  lastSyncAt = Date.now();
}

/** Fire-and-forget incremental sync (dedup concurrent). */
function ensureSynced(): void {
  if (syncInFlight) return;
  syncInFlight = syncLane()
    .then(() => {
      lastError = null;
    })
    .catch((e) => {
      lastError = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      syncInFlight = null;
    });
}

// ── Lane analytics (rails + kill-switches + verdict) ────────────────────────
export interface LaneVerdict {
  phase: "PAPER" | "PROMOTE-CANDIDATE" | "EXTEND" | "ABSTAIN" | "KILLED";
  detail: string;
}

export interface LaneStatus {
  id: LaneConfig["id"];
  name: string;
  windowStart: number;
  windowEnd: number;
  dayOfWindow: number;
  phase: LaneVerdict["phase"];
  detail: string;
  matched: number;
  open: number;
  settled: number;
  winRatePct: number | null;
  net2: number;
  gross2: number;
  avgNet2: number | null;
  bestDay: number | null;
  worstDay: number | null;
  todayNet2: number | null;
  weekNet2: number | null;
  dailyStopBreached: boolean;
  weeklyStopBreached: boolean;
  kills: { K1: boolean; K2: boolean; K3: boolean; K4: boolean };
  killDetail: string[];
  lastMatchAt: number | null;
  recent: LaneMatch[]; // last 8 settled for the UI
}

function analyzeLane(cfg: LaneConfig, matches: LaneMatch[], pr: Preregister): LaneStatus {
  const laneMatches = matches.filter((m) => m.lane === cfg.id);
  const settledRows = laneMatches.filter((m) => m.status !== "ACTIVE" && m.net2 !== null).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const net2 = Number(settledRows.reduce((a, m) => a + (m.net2 ?? 0), 0).toFixed(3));
  const gross2 = Number(settledRows.reduce((a, m) => a + (m.gross2 ?? 0), 0).toFixed(3));
  const wins = settledRows.filter((m) => m.win).length;

  // rails — Tehran-day / Saturday-week buckets over settled outcomes
  const dayBuckets = new Map<number, number>();
  for (const m of settledRows) dayBuckets.set(tehranDayIndex(m.closedAt ?? m.openedAt), (dayBuckets.get(tehranDayIndex(m.closedAt ?? m.openedAt)) ?? 0) + (m.net2 ?? 0));
  const weekBuckets = new Map<number, number>();
  for (const m of settledRows) weekBuckets.set(tehranWeekIndex(m.closedAt ?? m.openedAt), (weekBuckets.get(tehranWeekIndex(m.closedAt ?? m.openedAt)) ?? 0) + (m.net2 ?? 0));
  const todayIdx = tehranDayIndex(Date.now());
  const todayNet2 = dayBuckets.has(todayIdx) ? Number(dayBuckets.get(todayIdx)!.toFixed(3)) : null;
  const thisWeekIdx = tehranWeekIndex(Date.now());
  const weekNet2 = weekBuckets.has(thisWeekIdx) ? Number(weekBuckets.get(thisWeekIdx)!.toFixed(3)) : null;
  const dayVals = [...dayBuckets.values()];
  const dailyStopBreached = dayVals.some((v) => v <= LANE_DAILY_STOP);
  const weeklyStopBreached = [...weekBuckets.values()].some((v) => v <= LANE_WEEKLY_STOP);

  // kill-switches (78-3c doctrine, verbatim)
  const killDetail: string[] = [];
  const last20 = settledRows.slice(-20);
  const k1Net = Number(last20.reduce((a, m) => a + (m.net2 ?? 0), 0).toFixed(3));
  const K1 = last20.length >= 20 && k1Net <= -3 * LANE_MARGIN_USD;
  if (K1) killDetail.push(`K1 rolling-20 net $${k1Net.toFixed(2)} ≤ −$${3 * LANE_MARGIN_USD}`);
  const cutoffWeek = tehranWeekIndex(Date.now() - 30 * 86_400_000);
  const weeklyHits30d = [...weekBuckets.entries()].filter(([w, v]) => v <= LANE_WEEKLY_STOP && w >= cutoffWeek).length;
  const K2 = weeklyHits30d >= 2;
  if (K2) killDetail.push(`K2 ${weeklyHits30d} weekly-stop hits in trailing window`);
  const K3 = settledRows.length >= 300 && net2 <= 0;
  if (K3) killDetail.push(`K3 cumulative $${net2.toFixed(2)} ≤ 0 at ${settledRows.length} trades`);
  const lastMatchAt = laneMatches.length ? Math.max(...laneMatches.map((m) => m.openedAt)) : null;
  const K4 = lastMatchAt !== null && Date.now() - lastMatchAt > 7 * 86_400_000;
  if (K4) killDetail.push("K4 no formula match in 7d — population extinct (engine version drift)");
  const anyKill = K1 || K2 || K3 || K4;

  // verdict gate — 7d window, PROMOTE needs n≥20 && net>0, one auto-extension
  let phase: LaneVerdict["phase"] = "PAPER";
  let detail = `paper day ${Math.min(WINDOW_DAYS, Math.max(1, Math.ceil((Date.now() - pr.windowStart) / 86_400_000)))}/${WINDOW_DAYS}`;
  const now = Date.now();
  if (anyKill) {
    phase = "KILLED";
    detail = killDetail[0] ?? "kill-switch";
  } else if (now >= pr.windowEnd) {
    if (settledRows.length >= PROMOTE_MIN_N && net2 > 0) {
      phase = "PROMOTE-CANDIDATE";
      detail = `window closed: n=${settledRows.length} ≥ ${PROMOTE_MIN_N} · net +$${net2.toFixed(2)} — awaits operator APPROVE for live-$2 (day-30 re-run booked)`;
    } else if (pr.extensions < 1) {
      phase = "EXTEND";
      detail = `window closed with n=${settledRows.length} < ${PROMOTE_MIN_N} — one 7d extension granted (pre-registered policy)`;
    } else {
      phase = "ABSTAIN";
      detail = `window + extension closed without decision-grade evidence (n=${settledRows.length}, net $${net2.toFixed(2)}) — formula stays paper`;
    }
  }

  return {
    id: cfg.id,
    name: cfg.name,
    windowStart: pr.windowStart,
    windowEnd: pr.windowEnd + (phase === "EXTEND" ? WINDOW_DAYS * 86_400_000 : 0),
    dayOfWindow: Math.min(WINDOW_DAYS + pr.extensions * WINDOW_DAYS, Math.max(1, Math.ceil((now - pr.windowStart) / 86_400_000))),
    phase,
    detail,
    matched: laneMatches.length,
    open: laneMatches.length - settledRows.length,
    settled: settledRows.length,
    winRatePct: settledRows.length ? Number(((wins / settledRows.length) * 100).toFixed(1)) : null,
    net2,
    gross2,
    avgNet2: settledRows.length ? Number((net2 / settledRows.length).toFixed(3)) : null,
    bestDay: dayVals.length ? Number(Math.max(...dayVals).toFixed(2)) : null,
    worstDay: dayVals.length ? Number(Math.min(...dayVals).toFixed(2)) : null,
    todayNet2,
    weekNet2,
    dailyStopBreached,
    weeklyStopBreached,
    kills: { K1, K2, K3, K4 },
    killDetail,
    lastMatchAt,
    recent: settledRows.slice(-8).reverse(),
  };
}

export interface GoldenLaneBlock {
  configured: boolean;
  marginUsd: number;
  dailyStop: number;
  weeklyStop: number;
  windowStart: number;
  windowEnd: number;
  extensions: number;
  tampered: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  lanes: LaneStatus[];
}

const MEMO_MS = 15_000;
let memo: { at: number; block: GoldenLaneBlock } | null = null;

/** Pulse-facing status (15s memo, fail-soft — never throws). */
export async function getGoldenLaneStatus(): Promise<GoldenLaneBlock | null> {
  try {
    if (memo && Date.now() - memo.at < MEMO_MS) return memo.block;
    const pr = loadOrCreatePreregister();
    if (Date.now() - lastSyncAt > MEMO_MS) ensureSynced();
    const st = loadState();
    const block: GoldenLaneBlock = {
      configured: true,
      marginUsd: LANE_MARGIN_USD,
      dailyStop: LANE_DAILY_STOP,
      weeklyStop: LANE_WEEKLY_STOP,
      windowStart: pr.windowStart,
      windowEnd: pr.windowEnd,
      extensions: pr.extensions,
      tampered: Boolean((pr as Preregister & { tampered?: boolean }).tampered),
      lastSyncAt: lastSyncAt || null,
      lastError,
      // v11.6 EQ-97 — pre-registered configs are the source of truth per
      // generation (gen-2 re-pins engineVersion); fall back to the module
      // constants only for a malformed file.
      lanes: (pr.configs?.length ? pr.configs : LANE_CONFIGS).map((cfg) => analyzeLane(cfg, st.matches, pr)),
    };
    memo = { at: Date.now(), block };
    return block;
  } catch {
    return null;
  }
}

/** EXTEND verdict materializes: persist the one allowed extension. */
export function maybeApplyExtension(): boolean {
  try {
    const pr = loadOrCreatePreregister();
    if (Date.now() < pr.windowEnd || pr.extensions >= 1) return false;
    const st = loadState();
    const configs = pr.configs?.length ? pr.configs : LANE_CONFIGS;
    const anyAlive = configs.some((cfg) => {
      const s = analyzeLane(cfg, st.matches, pr);
      return s.phase === "EXTEND";
    });
    if (!anyAlive) return false;
    pr.extensions += 1;
    pr.windowEnd += WINDOW_DAYS * 86_400_000;
    fs.writeFileSync(PREREG_FILE, JSON.stringify(pr, null, 1));
    return true;
  } catch {
    return false;
  }
}

// ── v11.6 WINDOW-END ADJUDICATION + GENERATION RE-REGISTRATION (EQ-97) ──────
// Operator order: «سه اقدام واقعی باقیمانده و مأموریت بعدی را کامل و مهندسی
// اجرا کن» — the next mission (formal 10/19 adjudication + re-register on the
// live engine) is engineered to self-execute instead of waiting for a human
// to remember. Design:
//  · FIRES from the pulse path (same fail-open family as maybeApplyExtension)
//    once now ≥ windowEnd AND the extension policy is exhausted (either
//    extensions ≥ 1, or no lane qualifies for the one extension — killed /
//    promote-candidate lanes end the window immediately).
//  · VERDICT OF RECORD — per-lane phases + stats frozen into
//    .data/golden-lane-adjudication.json (atomic write), SignalEvent (ai) +
//    Telegram push. Idempotent per (generation, windowEnd).
//  · PROMOTE-CANDIDATE → NO auto anything: live-$2 requires explicit operator
//    APPROVE (doctrine 78-3c); the record says so.
//  · ABSTAIN/KILLED (nothing promotable) → PAPER-ONLY generation+1 re-run:
//    archives preregister/matches/journal under .data/golden-lane-genNN-*,
//    re-pins the gfl lane's engineVersion to the LIVE engine string measured
//    from the freshest ledger row (the gen-1 defect was measuring v10.18
//    while the engine moved on — K4 extinction), resets the match book, and
//    pre-registers a fresh 7d window with a new config SHA. No money moves —
//    this is the measurement chain staying alive, not a promotion.

export interface GoldenLaneAdjudicationRecord {
  generation: number;
  adjudicatedAt: string;
  windowStart: number;
  windowEnd: number;
  tampered: boolean;
  decision: "PROMOTE-REQUIRES-OPERATOR-APPROVE" | "ABSTAIN-STAYS-PAPER";
  lanes: Array<{
    id: string;
    phase: string;
    detail: string;
    matched: number;
    settled: number;
    winRatePct: number | null;
    net2: number;
    kills: { K1: boolean; K2: boolean; K3: boolean; K4: boolean };
    killDetail: string[];
  }>;
  reRegistered: boolean;
  nextGeneration: number | null;
}

function readAdjudication(): GoldenLaneAdjudicationRecord | null {
  try {
    return JSON.parse(fs.readFileSync(ADJUDICATION_FILE, "utf8")) as GoldenLaneAdjudicationRecord;
  } catch {
    return null;
  }
}

/** Adjudication record of the current (or last) generation — API/card surface. */
export function getGoldenLaneAdjudication(): GoldenLaneAdjudicationRecord | null {
  return readAdjudication();
}

/** ACTIVE pre-registered configs for the current generation (API doctrine view). */
export function getActiveLaneConfigs(): LaneConfig[] {
  try {
    const pr = loadOrCreatePreregister();
    if (pr.configs?.length) return pr.configs;
  } catch {
    /* fall through */
  }
  return LANE_CONFIGS;
}

let adjudicationInFlight: Promise<boolean> | null = null;

/** Pulse-path hook — fire-and-forget safe, dedup'd, fail-open. */
export function maybeRunGoldenLaneAdjudication(): Promise<boolean> {
  if (!adjudicationInFlight) {
    adjudicationInFlight = runWindowEndAdjudication().finally(() => {
      adjudicationInFlight = null;
    });
  }
  return adjudicationInFlight;
}

async function runWindowEndAdjudication(): Promise<boolean> {
  try {
    const pr = loadOrCreatePreregister();
    if (Date.now() < pr.windowEnd) return false; // window still open
    if ((pr.extensions ?? 0) < 1) {
      // policy not exhausted: grant the extension if any lane qualifies;
      // a window where NO lane qualifies (all killed/promote) ends NOW.
      const st = loadState();
      const configs = pr.configs?.length ? pr.configs : LANE_CONFIGS;
      const anyExtend = configs.some((cfg) => analyzeLane(cfg, st.matches, pr).phase === "EXTEND");
      if (anyExtend) {
        maybeApplyExtension();
        return false;
      }
    }
    const gen = pr.generation ?? 1;
    const prior = readAdjudication();
    if (prior && prior.generation === gen && prior.windowEnd === pr.windowEnd) return false; // already of record
    await syncLane().catch(() => undefined); // settlement truth before the verdict freezes
    const st = loadState();
    const configs = pr.configs?.length ? pr.configs : LANE_CONFIGS;
    const lanes = configs.map((cfg) => analyzeLane(cfg, st.matches, pr));
    const promoteCandidate = lanes.find((l) => l.phase === "PROMOTE-CANDIDATE");
    const decision: GoldenLaneAdjudicationRecord["decision"] = promoteCandidate
      ? "PROMOTE-REQUIRES-OPERATOR-APPROVE"
      : "ABSTAIN-STAYS-PAPER";
    let reRegistered = false;
    let nextGeneration: number | null = null;
    if (decision === "ABSTAIN-STAYS-PAPER") {
      nextGeneration = gen + 1;
      reRegistered = await registerNextGeneration(pr, lanes);
    }
    const record: GoldenLaneAdjudicationRecord = {
      generation: gen,
      adjudicatedAt: new Date().toISOString(),
      windowStart: pr.windowStart,
      windowEnd: pr.windowEnd,
      tampered: Boolean((pr as Preregister & { tampered?: boolean }).tampered),
      decision,
      lanes: lanes.map((l) => ({
        id: l.id,
        phase: l.phase,
        detail: l.detail,
        matched: l.matched,
        settled: l.settled,
        winRatePct: l.winRatePct,
        net2: l.net2,
        kills: l.kills,
        killDetail: l.killDetail,
      })),
      reRegistered,
      nextGeneration,
    };
    try {
      const tmp = ADJUDICATION_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(record, null, 1));
      fs.renameSync(tmp, ADJUDICATION_FILE);
    } catch {
      /* snapshot-of-record is best effort; the event below is the durable trail */
    }
    const laneLine = lanes
      .map((l) => `${l.id} ${l.phase} n=${l.settled} WR=${l.winRatePct ?? "?"}% net2=$${l.net2.toFixed(2)}${l.killDetail.length ? ` [${l.killDetail[0]}]` : ""}`)
      .join(" · ");
    await import("./engine").then(({ fireEvent }) =>
      fireEvent(
        null,
        null,
        "ENGINE",
        "ai",
        `GOLDEN LANE GEN-${gen} WINDOW ADJUDICATION — ${decision.replace(/-/g, " ")} · ${laneLine} · window ${new Date(pr.windowStart).toISOString().slice(0, 10)} → ${new Date(pr.windowEnd).toISOString().slice(0, 10)} (extensions ${pr.extensions ?? 0}/1)${reRegistered ? ` · GEN-${nextGeneration} paper-only re-registered on the live engine (fresh 7d window, prior book archived)` : ""}${promoteCandidate ? " · AWAITING OPERATOR APPROVE for live-$2 (day-30 re-run booked)" : ""}`,
      ),
    ).catch(() => undefined);
    void sendDirect(
      `⚖️ <b>GOLDEN LANE GEN-${gen} — WINDOW ADJUDICATION</b>\n${laneLine.replace(/ · /g, "\n")}\n🏛 Decision: <b>${decision.replace(/-/g, " ")}</b>${reRegistered ? `\n🔁 GEN-${nextGeneration} re-registered (paper-only, live engine)` : ""}${promoteCandidate ? "\n✋ waiting for operator APPROVE" : ""}`,
    ).catch(() => undefined);
    return true;
  } catch {
    return false; // fail-open — the lane can never disturb the live engine
  }
}

/** PAPER-ONLY next generation: archive gen artifacts, re-pin engine, reset book. */
async function registerNextGeneration(prev: Preregister, lanes: LaneStatus[]): Promise<boolean> {
  try {
    const gen = prev.generation ?? 1;
    const stamp = String(gen).padStart(2, "0");
    // 1) archive the generation of record (preregister + matches + journal)
    const archive = (src: string, dst: string) => {
      try {
        if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      } catch {
        /* archive is best effort */
      }
    };
    archive(PREREG_FILE, path.join(DATA_DIR, `golden-lane-gen${stamp}-preregister.json`));
    archive(SNAPSHOT_FILE, path.join(DATA_DIR, `golden-lane-gen${stamp}-matches.json`));
    archive(JOURNAL_FILE, path.join(DATA_DIR, `golden-lane-gen${stamp}-journal.jsonl`));
    // 2) live engine string from the freshest ledger row (data-driven — no
    //    import cycle with engine.ts; measures the truth, not a constant)
    let liveEngine = "NEXUS-LIVE v11.5";
    try {
      const last = await db.signal.findFirst({ orderBy: { serial: "desc" }, select: { engine: true } });
      if (last?.engine) liveEngine = last.engine;
    } catch {
      /* keep the fallback */
    }
    // 3) gen-N+1 configs: same lane identities, gfl re-pinned to the LIVE engine
    const nextConfigs: LaneConfig[] = (prev.configs?.length ? prev.configs : LANE_CONFIGS).map((cfg) => ({
      ...cfg,
      name: cfg.engineVersion ? `GOLDEN FORMULA (GEN-${gen + 1}, live-engine re-pin)` : `${cfg.name.split(" (GEN")[0]} (GEN-${gen + 1} re-registration)`,
      engineVersion: cfg.engineVersion ? liveEngine : null,
    }));
    const now = Date.now();
    const nextPr: Preregister = {
      version: 1,
      generation: gen + 1,
      registeredAt: now,
      windowStart: now,
      windowEnd: now + WINDOW_DAYS * 86_400_000,
      extensions: 0,
      configSha256: configHash(nextConfigs),
      configs: nextConfigs,
    };
    // 4) reset the measurement book BEFORE the new preregister lands
    state = null; // cold-rebuild from the (emptied) snapshot on next read
    try {
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ generatedAt: now, matches: [] }));
      try {
        fs.rmSync(JOURNAL_FILE, { force: true }); // journal restarts per generation (gen copy archived above)
      } catch {
        /* journal is audit-only */
      }
    } catch {
      /* fail-open */
    }
    // 5) pre-register atomically (tmp+rename — the tamper hash must match on first read)
    const tmp = PREREG_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(nextPr, null, 1));
    fs.renameSync(tmp, PREREG_FILE);
    memo = null; // invalidate the status memo — next read is gen-N+1
    lastSyncAt = 0; // force a fresh sync against the new window
    void lanes; // stats already frozen into the adjudication record
    return true;
  } catch {
    return false;
  }
}
