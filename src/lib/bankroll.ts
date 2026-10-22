// ── Task 81 BANKROLL BASIS ENGINE (operator mandate 2026-10-05
// «قوانین جدید بانکرول را کامل و مهندسی اجرا کن، اما بالانس 100 بماند ولی
// تمام قوانین نسبت به بانکرول و نسبت به لبهٔ تعریف‌شده بر اساس 1000 باشد»)
// ─────────────────────────────────────────────────────────────────────────────
// DUAL-BASIS DOCTRINE (BR-2.0):
//   · SEED  $100  — the physical paper account. Physical sizing, equity caps
//     (10%-equity room clamp), risk-overlay equity percentages and collateral
//     logic stay coherent with the REAL seed — the account itself is untouched.
//   · BASIS $1000 — every BANKROLL-relative rule (margin rule, daily/weekly
//     rails, K1 rolling, K2/K3 locks) and every EDGE-relative rule (daily
//     target, deflated-edge ratio) is denominated on the basis bankroll.
//
// RE-DENOMINATION (honest projection): realized PnL is linear in margin —
//   net = margin × pnlPercent/100 − fees(notional = margin × leverage) − swap
// so each settled row is re-projected to the BASIS margin by the exact factor
// (BASIS_MARGIN / rowMargin). This is "the book's decisions at $1000-account
// sizing" — the identical mechanism golden-lane uses for its $2 rescale. No
// simulation, no fabrication: the row's own pnlPercent and leverage, re-priced
// on the basis collateral.
//
// Rule set (all % of BASIS, the operator's $1000 doctrine):
//   · margin rule      $20  = 2.0%  of basis (promotion-path parameter)
//   · daily rail      −$50  = 5.0%  of basis (Tehran day)   — BR-2.1: advisory
//   · weekly rail    −$100  = 10.0% of basis (Sat-start week) — BR-2.1: advisory
//   · K1 rolling-20   −$60  = 6.0%  of basis → pause rest of the Tehran day
//   · K2              two weekly-rail breaches inside 30d → LOCK (BR-2.1: inert)
//   · K3              last-300 settled basis-net ≤ −$1000 (basis ruin) → LOCK
//   · K4              engine version drift invalidates the track
//   · daily target    +$5   = 0.5% of basis — measured against the deflated
//     edge $10–15/day on basis (Task-78 deflated $1.0–1.5/day on $100 ×10):
//     target/edge = 33–50% → inside the PLAUSIBLE band.
//
// Honesty rails: fail-open on internal error · every weekly breach journaled
// (.data/bankroll-kill.jsonl) so K2 is restart-proof · operator reset lever
// = touch .data/bankroll-reset (consumed on read, journaled).
//
// BR-2.1 (operator command 2026-10-05 «حد ضرر روزانه و هفتگی را غیر فعال کن
// و نیازی نیست»): the DAILY/WEEKLY stop rails are DISABLED as enforcement —
// they remain as advisory telemetry (consumption % + breach journal) so the
// would-have-fired record stays measurable and re-armable. Tail protection
// now rests on the K-suite: K1 rolling-20 pause, K3 basis-ruin lock, K4
// version invalidation. K2 (two weekly breaches → LOCK) is INERT while the
// weekly rail is off — its premise IS the weekly stop. Re-arm lever:
// touch .data/bankroll-rails-on (read per snapshot, journaled).

import { db } from "@/lib/db";
import * as fs from "node:fs";
import * as path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const KILL_JOURNAL = path.join(DATA_DIR, "bankroll-kill.jsonl");
const RESET_LEVER = path.join(DATA_DIR, "bankroll-reset");
const TRACK_FILE = path.join(DATA_DIR, "bankroll-track.json");

// ── doctrine constants ───────────────────────────────────────────────────────
export const BANKROLL_VERSION = "BR-2.1";
export const SEED_BALANCE_USD = 100; // physical tracked account (unchanged)
export const BASIS_BANKROLL_USD = 1000; // rules & edge denomination basis
export const BASIS_MARGIN_USD = 20; // 2.0% of basis — promotion-path margin
export const DAILY_STOP_BASIS = -50; // 5.0% of basis
export const WEEKLY_STOP_BASIS = -100; // 10.0% of basis
export const K1_ROLLING_BASIS = -60; // 6.0% of basis (rolling-20)
export const DAILY_TARGET_BASIS = 5; // 0.5% of basis
export const DEFLATED_EDGE_BASIS_LOW = 10; // $/day on basis (×10 of $1.0)
export const DEFLATED_EDGE_BASIS_HIGH = 15; // $/day on basis (×10 of $1.5)
export const K2_MAX_WEEKLY_HITS_30D = 2;
export const K3_WINDOW_TRADES = 300;
export const K3_RUIN_BASIS = -BASIS_BANKROLL_USD;
export const ENGINE_VERSION_STAMP = "NEXUS-LIVE v10.18"; // K4 reference

// BR-2.1 — daily/weekly rails are advisory-only by operator command. The lever
// file re-arms them WITHOUT a redeploy (fail-safe default = command honored).
export const RAILS_DEFAULT_ENFORCED = false;
const RAILS_ON_LEVER = path.join(DATA_DIR, "bankroll-rails-on");

export function railsEnforcedNow(): boolean {
  try {
    return fs.existsSync(RAILS_ON_LEVER);
  } catch {
    return RAILS_DEFAULT_ENFORCED;
  }
}

const TZ_MS = 3.5 * 3600_000; // Tehran = UTC+3:30 (no DST since 2022)

export function tehranDayIndex(ms: number): number {
  return Math.floor((ms + TZ_MS) / 86_400_000);
}
/** Saturday-start Tehran week index (Iranian work week). */
export function tehranWeekIndex(ms: number): number {
  const tehranDays = Math.floor((ms + TZ_MS) / 86_400_000);
  return Math.floor((tehranDays + 2) / 7);
}
export function tehranWeekStartMs(ms: number): number {
  return (tehranWeekIndex(ms) * 7 - 2) * 86_400_000 - TZ_MS;
}
export function tehranDayStartMs(ms: number): number {
  return tehranDayIndex(ms) * 86_400_000 - TZ_MS;
}

// ── re-denomination ──────────────────────────────────────────────────────────
interface LedgerRow {
  pnlPercent: number | null;
  marginUsd: number | null;
  feeUsd: number | null;
  swapUsd: number | null;
}

/** Raw realized net of a settled row (the book's own dollars). */
export function rawNetOf(r: LedgerRow): number {
  return ((r.pnlPercent ?? 0) / 100) * (r.marginUsd ?? 0) - (r.feeUsd ?? 0) - (r.swapUsd ?? 0);
}

/**
 * Re-project a row's net onto the BASIS margin (exact linear rescale).
 * Rows with dust margin (<$0.10) contribute ~zero raw and are passed through
 * un-rescaled (their raw net is negligible either way).
 */
export function basisNetOf(r: LedgerRow): number {
  const raw = rawNetOf(r);
  const m = r.marginUsd ?? 0;
  return m >= 0.1 ? raw * (BASIS_MARGIN_USD / m) : raw;
}

// ── persistence (kill journal + track file + reset lever) ────────────────────
function journal(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(KILL_JOURNAL, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch {
    /* audit-only — never fail the deploy path */
  }
}

interface WeeklyBreachEvent {
  at: number;
  weekIdx: number;
  weekNetBasis: number;
}

function readWeeklyBreaches(): WeeklyBreachEvent[] {
  try {
    if (!fs.existsSync(KILL_JOURNAL)) return [];
    const lines = fs.readFileSync(KILL_JOURNAL, "utf8").split("\n").filter(Boolean);
    const out: WeeklyBreachEvent[] = [];
    for (const l of lines) {
      try {
        const j = JSON.parse(l) as WeeklyBreachEvent & { kind?: string };
        if (j.kind === "WEEKLY-BREACH" && typeof j.weekIdx === "number") out.push({ at: j.at, weekIdx: j.weekIdx, weekNetBasis: j.weekNetBasis });
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readResetLever(): boolean {
  try {
    if (!fs.existsSync(RESET_LEVER)) return false;
    fs.unlinkSync(RESET_LEVER); // consumed on read
    journal({ kind: "OPERATOR-RESET", detail: "bankroll-reset lever consumed — K2/K3 locks cleared" });
    return true;
  } catch {
    return false;
  }
}

interface TrackFile {
  version: string;
  seedUsd: number;
  basisUsd: number;
  startedAt: number;
}
function ensureTrackFile(): TrackFile {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(TRACK_FILE)) {
      const t = JSON.parse(fs.readFileSync(TRACK_FILE, "utf8")) as TrackFile;
      if (t.version === BANKROLL_VERSION) return t;
    }
    const t: TrackFile = { version: BANKROLL_VERSION, seedUsd: SEED_BALANCE_USD, basisUsd: BASIS_BANKROLL_USD, startedAt: Date.now() };
    fs.writeFileSync(TRACK_FILE, JSON.stringify(t));
    journal({ kind: "TRACK-OPEN", version: BANKROLL_VERSION, basis: BASIS_BANKROLL_USD, seed: SEED_BALANCE_USD });
    return t;
  } catch {
    return { version: BANKROLL_VERSION, seedUsd: SEED_BALANCE_USD, basisUsd: BASIS_BANKROLL_USD, startedAt: Date.now() };
  }
}

// ── snapshot (single DB pass feeding rails, K-suite and the pulse card) ──────
export interface BankrollSnapshot {
  at: number;
  dayIdx: number;
  weekIdx: number;
  // re-denominated (basis $1000) — the RULES numbers
  todayNetBasis: number;
  weekNetBasis: number;
  rolling20NetBasis: number | null;
  last300NetBasis: number | null;
  settledToday: number;
  settledWeek: number;
  // raw (seed $100 book) — the PHYSICAL numbers
  todayNetRaw: number;
  weekNetRaw: number;
  rolling20NetRaw: number | null;
  // rails
  dailyBreached: boolean; // telemetry — enforcement gated by railsEnforced (BR-2.1)
  weeklyBreached: boolean; // telemetry — enforcement gated by railsEnforced (BR-2.1)
  k1Tripped: boolean;
  railsEnforced: boolean; // BR-2.1 — false ⇒ DAILY/WEEKLY advisory-only, K2 inert
  // K-suite
  k2WeeklyHits30d: number;
  k2Locked: boolean;
  k3Locked: boolean;
  k4EngineVersion: string | null;
  k4Invalid: boolean;
  weeklyBreachEvents: WeeklyBreachEvent[];
  locked: boolean; // K2 or K3 or K4
  lockCode: "K2-LOCK" | "K3-RUIN" | "K4-INVALID" | null;
}

let snapMemo: BankrollSnapshot | null = null;
let snapInFlight: Promise<BankrollSnapshot | null> | null = null;

async function computeSnapshot(): Promise<BankrollSnapshot> {
  const now = Date.now();
  const dayIdx = tehranDayIndex(now);
  const weekIdx = tehranWeekIndex(now);
  const weekStartMs = tehranWeekStartMs(now);
  const dayStartMs = tehranDayStartMs(now);

  const rows = await db.signal.findMany({
    where: { closedAt: { gte: new Date(weekStartMs) } },
    select: { pnlPercent: true, marginUsd: true, feeUsd: true, swapUsd: true, closedAt: true, status: true, qualityFlag: true },
  });

  let todayB = 0;
  let weekB = 0;
  let todayR = 0;
  let weekR = 0;
  let settledToday = 0;
  let settledWeek = 0;
  for (const r of rows) {
    if (r.status === "VOID") continue;
    if (r.qualityFlag) continue; // clean-ledger convention (Task-74)
    if (r.closedAt === null) continue;
    settledWeek++;
    const b = basisNetOf(r);
    const raw = rawNetOf(r);
    weekB += b;
    weekR += raw;
    if (r.closedAt.getTime() >= dayStartMs) {
      settledToday++;
      todayB += b;
      todayR += raw;
    }
  }

  const rollingSel = {
    select: { pnlPercent: true, marginUsd: true, feeUsd: true, swapUsd: true },
  } as const;
  const last20 = await db.signal.findMany({
    where: { closedAt: { not: null }, status: { notIn: ["VOID"] }, qualityFlag: null },
    orderBy: { closedAt: "desc" },
    take: 20,
    ...rollingSel,
  });
  const rolling20NetBasis = last20.length ? last20.reduce((a, r) => a + basisNetOf(r), 0) : null;
  const rolling20NetRaw = last20.length ? last20.reduce((a, r) => a + rawNetOf(r), 0) : null;

  const last300 = await db.signal.findMany({
    where: { closedAt: { not: null }, status: { notIn: ["VOID"] }, qualityFlag: null },
    orderBy: { closedAt: "desc" },
    take: K3_WINDOW_TRADES,
    ...rollingSel,
  });
  const last300NetBasis = last300.length >= K3_WINDOW_TRADES ? last300.reduce((a, r) => a + basisNetOf(r), 0) : null;

  // K4 — engine version drift (each deploy stamps its engine version)
  let k4EngineVersion: string | null = null;
  let k4Invalid = false;
  try {
    const newest = await db.signal.findFirst({ orderBy: { createdAt: "desc" }, select: { engine: true } });
    k4EngineVersion = newest?.engine ?? null;
    k4Invalid = !!k4EngineVersion && k4EngineVersion !== ENGINE_VERSION_STAMP;
  } catch {
    /* fail-open */
  }

  // BR-2.1 — rails enforcement flag (lever read per snapshot)
  const railsOn = railsEnforcedNow();

  // weekly breach journal — kept as TELEMETRY even with rails off: the
  // would-have-fired record stays measurable for a future re-arm decision.
  const weeklyBreachEvents = readWeeklyBreaches();
  const weeklyBreached = weekB <= WEEKLY_STOP_BASIS;
  if (weeklyBreached && !weeklyBreachEvents.some((e) => e.weekIdx === weekIdx)) {
    journal({ kind: "WEEKLY-BREACH", weekIdx, weekNetBasis: Number(weekB.toFixed(2)), weekNetRaw: Number(weekR.toFixed(2)), railsEnforced: railsOn, rule: `week ≤ $${WEEKLY_STOP_BASIS} (10% of $${BASIS_BANKROLL_USD})${railsOn ? "" : " — TELEMETRY ONLY (BR-2.1 rails off)"}` });
    weeklyBreachEvents.push({ at: now, weekIdx, weekNetBasis: weekB });
  }

  const cutoff30d = now - 30 * 86_400_000;
  const k2WeeklyHits30d = weeklyBreachEvents.filter((e) => e.at >= cutoff30d).length;
  // K2 premise IS the weekly rail — inert while rails are off (BR-2.1)
  const k2Locked = railsOn && k2WeeklyHits30d >= K2_MAX_WEEKLY_HITS_30D;
  const k3Locked = last300NetBasis !== null && last300NetBasis <= K3_RUIN_BASIS;

  const operatorReset = readResetLever();
  let lockCode: BankrollSnapshot["lockCode"] = null;
  if (!operatorReset) {
    if (k2Locked) lockCode = "K2-LOCK";
    else if (k3Locked) lockCode = "K3-RUIN";
    else if (k4Invalid) lockCode = "K4-INVALID";
  }

  return {
    at: now,
    dayIdx,
    weekIdx,
    todayNetBasis: Number(todayB.toFixed(2)),
    weekNetBasis: Number(weekB.toFixed(2)),
    rolling20NetBasis: rolling20NetBasis === null ? null : Number(rolling20NetBasis.toFixed(2)),
    last300NetBasis: last300NetBasis === null ? null : Number(last300NetBasis.toFixed(2)),
    settledToday,
    settledWeek,
    todayNetRaw: Number(todayR.toFixed(2)),
    weekNetRaw: Number(weekR.toFixed(2)),
    rolling20NetRaw: rolling20NetRaw === null ? null : Number(rolling20NetRaw.toFixed(2)),
    dailyBreached: todayB <= DAILY_STOP_BASIS,
    weeklyBreached,
    k1Tripped: rolling20NetBasis !== null && last20.length >= 20 && rolling20NetBasis <= K1_ROLLING_BASIS,
    railsEnforced: railsOn,
    k2WeeklyHits30d,
    k2Locked,
    k3Locked,
    k4EngineVersion,
    k4Invalid,
    weeklyBreachEvents,
    locked: lockCode !== null,
    lockCode,
  };
}

/** Memoized snapshot (60s) — shared by the deploy gate and the pulse. */
export async function bankrollSnapshot(): Promise<BankrollSnapshot | null> {
  if (snapMemo && Date.now() - snapMemo.at < 60_000) return snapMemo;
  if (!snapInFlight) {
    snapInFlight = computeSnapshot()
      .then((s) => {
        snapMemo = s;
        return s;
      })
      .catch(() => null)
      .finally(() => {
        snapInFlight = null;
      });
  }
  return snapInFlight;
}

// ── admission check (consumed by the proven gate's rail precheck) ────────────
export type BankrollVetoCode = "DAILY_RAIL" | "WEEKLY_RAIL" | "K1" | "K2-LOCK" | "K3-RUIN" | "K4-INVALID";

export interface BankrollRailCheck {
  ok: boolean;
  code?: BankrollVetoCode;
  detail?: string;
  state: "ARMED" | "DAILY-STOP" | "WEEKLY-STOP" | "K1-PAUSE" | "K2-LOCK" | "K3-RUIN" | "K4-INVALID";
}

export function stateOf(s: BankrollSnapshot): BankrollRailCheck["state"] {
  if (s.lockCode === "K2-LOCK") return "K2-LOCK";
  if (s.lockCode === "K3-RUIN") return "K3-RUIN";
  if (s.lockCode === "K4-INVALID") return "K4-INVALID";
  // BR-2.1: daily/weekly stops enforce ONLY when the operator lever re-arms them
  if (s.railsEnforced && s.dailyBreached) return "DAILY-STOP";
  if (s.railsEnforced && s.weeklyBreached) return "WEEKLY-STOP";
  if (s.k1Tripped) return "K1-PAUSE";
  return "ARMED";
}

export async function bankrollRailCheck(): Promise<BankrollRailCheck | null> {
  try {
    const s = await bankrollSnapshot();
    if (!s) return null; // fail-open
    const state = stateOf(s);
    if (state === "ARMED") return { ok: true, state };
    const detail =
      state === "K2-LOCK"
        ? `${s.k2WeeklyHits30d} weekly-rail breaches inside 30d (max ${K2_MAX_WEEKLY_HITS_30D}) — bankroll LOCK, operator reset required`
        : state === "K3-RUIN"
          ? `last-${K3_WINDOW_TRADES} basis net $${(s.last300NetBasis ?? 0).toFixed(2)} ≤ −$${BASIS_BANKROLL_USD} — basis ruin lock`
          : state === "K4-INVALID"
            ? `engine version drift (${s.k4EngineVersion ?? "?"} ≠ ${ENGINE_VERSION_STAMP}) — track invalidated`
            : state === "DAILY-STOP"
              ? `basis today $${s.todayNetBasis.toFixed(2)} ≤ −$${Math.abs(DAILY_STOP_BASIS)} (5% of $${BASIS_BANKROLL_USD})`
              : state === "WEEKLY-STOP"
                ? `basis week $${s.weekNetBasis.toFixed(2)} ≤ −$${Math.abs(WEEKLY_STOP_BASIS)} (10% of $${BASIS_BANKROLL_USD})`
                : `basis rolling-20 $${(s.rolling20NetBasis ?? 0).toFixed(2)} ≤ −$${Math.abs(K1_ROLLING_BASIS)}`;
    const code: BankrollVetoCode = state === "DAILY-STOP" ? "DAILY_RAIL" : state === "WEEKLY-STOP" ? "WEEKLY_RAIL" : state === "K1-PAUSE" ? "K1" : (state as BankrollVetoCode);
    return { ok: false, code, detail, state };
  } catch {
    return null;
  }
}

// ── pulse-facing status (10s memo) ───────────────────────────────────────────
export interface BankrollStatus {
  version: string;
  railsEnforced: boolean; // BR-2.1 — false ⇒ daily/weekly advisory-only, K2 inert
  seed: { balanceUsd: number; todayNet: number | null; weekNet: number | null; rolling20Net: number | null };
  basis: {
    bankrollUsd: number;
    marginPerTradeUsd: number;
    dailyStop: number;
    weeklyStop: number;
    k1Rolling: number;
    dailyTarget: number;
    deflatedEdgeLow: number;
    deflatedEdgeHigh: number;
    todayNet: number | null;
    weekNet: number | null;
    rolling20Net: number | null;
    last300Net: number | null;
  };
  state: BankrollRailCheck["state"];
  rails: {
    dailyUsedPct: number | null; // |todayNetBasis| / |dailyStop| as consumed budget
    weeklyUsedPct: number | null;
    k1UsedPct: number | null;
  };
  target: { todayPctOfTarget: number | null; targetVsEdgePct: number | null };
  kSuite: { k1Tripped: boolean; k2Hits: number; k2Locked: boolean; k3Locked: boolean; k4Invalid: boolean; engineVersion: string | null; locked: boolean; lockCode: BankrollSnapshot["lockCode"] };
  settled: { today: number; week: number };
  weeklyBreachEvents: { at: number; weekIdx: number; weekNetBasis: number }[];
  updatedAt: number;
}

const STATUS_MEMO_MS = 10_000;
let statusMemo: { at: number; status: BankrollStatus } | null = null;

export async function getBankrollStatus(): Promise<BankrollStatus | null> {
  try {
    if (statusMemo && Date.now() - statusMemo.at < STATUS_MEMO_MS) return statusMemo.status;
    ensureTrackFile();
    const s = await bankrollSnapshot();
    if (!s) return null;
    const targetVsEdgePct = Math.round((DAILY_TARGET_BASIS / ((DEFLATED_EDGE_BASIS_LOW + DEFLATED_EDGE_BASIS_HIGH) / 2)) * 100);
    const status: BankrollStatus = {
      version: BANKROLL_VERSION,
      railsEnforced: s.railsEnforced,
      seed: {
        balanceUsd: SEED_BALANCE_USD,
        todayNet: s.todayNetRaw,
        weekNet: s.weekNetRaw,
        rolling20Net: s.rolling20NetRaw,
      },
      basis: {
        bankrollUsd: BASIS_BANKROLL_USD,
        marginPerTradeUsd: BASIS_MARGIN_USD,
        dailyStop: DAILY_STOP_BASIS,
        weeklyStop: WEEKLY_STOP_BASIS,
        k1Rolling: K1_ROLLING_BASIS,
        dailyTarget: DAILY_TARGET_BASIS,
        deflatedEdgeLow: DEFLATED_EDGE_BASIS_LOW,
        deflatedEdgeHigh: DEFLATED_EDGE_BASIS_HIGH,
        todayNet: s.todayNetBasis,
        weekNet: s.weekNetBasis,
        rolling20Net: s.rolling20NetBasis,
        last300Net: s.last300NetBasis,
      },
      state: stateOf(s),
      rails: {
        // BR-2.1: daily/weekly consumption is ADVISORY telemetry when rails are off
        dailyUsedPct: Math.min(100, Math.round((Math.max(0, -s.todayNetBasis) / Math.abs(DAILY_STOP_BASIS)) * 100)),
        weeklyUsedPct: Math.min(100, Math.round((Math.max(0, -s.weekNetBasis) / Math.abs(WEEKLY_STOP_BASIS)) * 100)),
        k1UsedPct: s.rolling20NetBasis === null ? null : Math.min(100, Math.round((Math.max(0, -s.rolling20NetBasis) / Math.abs(K1_ROLLING_BASIS)) * 100)),
      },
      target: {
        todayPctOfTarget: s.todayNetBasis > 0 ? Math.round((s.todayNetBasis / DAILY_TARGET_BASIS) * 100) : 0,
        targetVsEdgePct,
      },
      kSuite: {
        k1Tripped: s.k1Tripped,
        k2Hits: s.k2WeeklyHits30d,
        k2Locked: s.k2Locked,
        k3Locked: s.k3Locked,
        k4Invalid: s.k4Invalid,
        engineVersion: s.k4EngineVersion,
        locked: s.locked,
        lockCode: s.lockCode,
      },
      settled: { today: s.settledToday, week: s.settledWeek },
      weeklyBreachEvents: s.weeklyBreachEvents.slice(-3).map((e) => ({ at: e.at, weekIdx: e.weekIdx, weekNetBasis: Number(e.weekNetBasis.toFixed(2)) })),
      updatedAt: Date.now(),
    };
    statusMemo = { at: Date.now(), status };
    return status;
  } catch {
    return null;
  }
}
