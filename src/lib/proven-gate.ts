// ── Task 80 PROVEN ENTRY GATE (operator mandate 2026-10-05 «سیستم ردیابی و
// تصمیم‌گیری ورود به سیگنال را ارزیابی کن و مشکل اصلی را ریشه یابی و برطرف کن»)
// ─────────────────────────────────────────────────────────────────────────────
// ROOT CAUSE (Task-80 forensic, Oct-5 Tehran): the real book deployed ~140
// signals/day with NO connection to the measured evidence — 58% of settlements
// EXPIRED (avg MFE +5.1% left on the table), fees $0.62 = 57% of |gross|, the
// proven-negative zone (tp1<1%) contributed 48% of the day's loss from 19% of
// the mass, and 50/80 settled signals opened OUTSIDE the proven hour mask.
// The tracking/detection layer is healthy (executions verified in Task-77/78);
// the DECISION layer simply never consumes the edge it measured.
//
// This module closes that gap with the ONLY two entry filters that carry
// PROVEN evidence (78-3b/78-3c doctrine):
//   · HOUR MASK  — Tehran hours {2,4,5,10,12,17,18} (OOS overlay −$12.60 → +$9.81 per $1)
//   · TP1 FLOOR  — tp1 distance ≥ 1.0% (proven-negative zone below)
// plus the book-level risk circuit breakers — Task 81 RE-DENOMINATION
// (operator mandate «بالانس 100 بماند ولی تمام قوانین نسبت به بانکرول و نسبت
// به لبهٔ تعریف‌شده بر اساس 1000 باشد»): rails are owned by the BANKROLL BASIS
// ENGINE (lib/bankroll.ts) — every bankroll-relative rule is denominated on
// the $1000 BASIS with the book's realized nets re-projected onto the basis
// margin by exact linear rescale.
//
// Task 82 BR-2.1 (operator command «حد ضرر روزانه و هفتگی را غیر فعال کن و
// نیازی نیست»): DAILY/WEEKLY stop rails are advisory-only — they no longer
// veto. The gate still enforces K1 (rolling-20 pause) and the K2/K3/K4 locks.
//   · daily −$50 / weekly −$100 (basis) — TELEMETRY ONLY since BR-2.1
//   · K1 rolling-20 ≤ −$60 (6% of basis) → pause for the rest of the Tehran day
//   · K2 two weekly breaches/30d (inert while rails off) · K3 basis ruin over
//     300 trades · K4 version
// The physical $100 seed account and its collateral caps are untouched.
//
// Honesty rails:
//  · bypass ONLY for operator-forced deploys and RAW-CAL capture (the data
//    program is deliberately unfiltered and half-margin) — every bypass counted.
//  · fail-open on internal error: the gate may never take the engine down.
//    The operator can also disable instantly: touch .data/proven-gate-off
//  · every veto is journaled (.data/proven-gate.jsonl) so the gate's own
//    opportunity cost is measurable, not assumed (same standard as near-miss).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  bankrollSnapshot,
  bankrollRailCheck,
  BASIS_BANKROLL_USD,
  BASIS_MARGIN_USD,
  DAILY_STOP_BASIS,
  WEEKLY_STOP_BASIS,
  K1_ROLLING_BASIS,
  railsEnforcedNow,
  type BankrollSnapshot,
} from "./bankroll";

const DATA_DIR = path.join(process.cwd(), ".data");
const KILL_FILE = path.join(DATA_DIR, "proven-gate-off");
const JOURNAL_FILE = path.join(DATA_DIR, "proven-gate.jsonl");

export const PROVEN_HOURS = [2, 4, 5, 10, 12, 17, 18]; // 78-3b/78-3c champion mask
export const TP1_FLOOR_PCT = 1.0; // proven-negative zone below (78-3a atlas)
// Task 81: rail thresholds live in the bankroll basis engine (BR-2.0).
export const DAILY_STOP = DAILY_STOP_BASIS; // −$50 = 5% of $1000 basis
export const WEEKLY_STOP = WEEKLY_STOP_BASIS; // −$100 = 10% of $1000 basis
export const K1_ROLLING_NET = K1_ROLLING_BASIS; // −$60 = 6% of $1000 basis

const TZ_MS = 3.5 * 3600_000; // Tehran = UTC+3:30 (no DST since 2022)

export function tehranHourOf(ms: number): number {
  return Math.floor(((ms + TZ_MS) % 86_400_000) / 3_600_000);
}
function tehranDayIndex(ms: number): number {
  return Math.floor((ms + TZ_MS) / 86_400_000);
}

// Task 82 BR-2.1 — daily/weekly rails advisory-only (see header); lever read
// straight from the bankroll basis engine so one flag owns the doctrine.
const railsOff = (): boolean => !railsEnforcedNow();

// ── journal (audit trail of every veto / state change) ──────────────────────
function journal(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch {
    /* audit-only — never fail the deploy path */
  }
}

// ── in-memory counters (reset each Tehran day) ──────────────────────────────
export type GateState = "ARMED" | "DAILY-STOP" | "WEEKLY-STOP" | "K1-PAUSE" | "K2-LOCK" | "K3-RUIN" | "K4-INVALID" | "OFF";

interface GateCounters {
  dayIdx: number;
  pass: number;
  bypass: number;
  vetoHour: number;
  vetoTp1: number;
  blockedByRail: number;
  lastVetoAt: number | null;
  lastVeto: { symbol: string; code: string; detail: string } | null;
}

let counters: GateCounters = freshCounters();
function freshCounters(): GateCounters {
  return { dayIdx: tehranDayIndex(Date.now()), pass: 0, bypass: 0, vetoHour: 0, vetoTp1: 0, blockedByRail: 0, lastVetoAt: null, lastVeto: null };
}
function rollCounters(): void {
  const d = tehranDayIndex(Date.now());
  if (counters.dayIdx !== d) counters = freshCounters();
}

// ── rail evaluation — OWNED BY THE BANKROLL BASIS ENGINE (BR-2.0) ───────────
// bankroll.ts computes the snapshot (60s memo, single DB pass) with the book's
// realized nets re-denominated onto the $1000 basis; this module only maps it
// to the gate's vocabulary. Basis numbers drive the RULES; raw numbers are
// carried for honest dual display.
interface RailSnapshot {
  at: number;
  todayNet: number; // BASIS ($1000 rules)
  weekNet: number;
  rolling20Net: number | null;
  todayNetRaw: number; // SEED ($100 physical book)
  weekNetRaw: number;
  rolling20NetRaw: number | null;
  dailyBreached: boolean;
  weeklyBreached: boolean;
  k1Tripped: boolean;
  lockCode: BankrollSnapshot["lockCode"];
  k2WeeklyHits30d: number;
}

async function railSnapshot(): Promise<RailSnapshot | null> {
  const s = await bankrollSnapshot();
  if (!s) return null; // fail-open
  return {
    at: s.at,
    todayNet: s.todayNetBasis,
    weekNet: s.weekNetBasis,
    rolling20Net: s.rolling20NetBasis,
    todayNetRaw: s.todayNetRaw,
    weekNetRaw: s.weekNetRaw,
    rolling20NetRaw: s.rolling20NetRaw,
    dailyBreached: s.dailyBreached,
    weeklyBreached: s.weeklyBreached,
    k1Tripped: s.k1Tripped,
    lockCode: s.lockCode,
    k2WeeklyHits30d: s.k2WeeklyHits30d,
  };
}

function gateEnabled(): boolean {
  try {
    return !fs.existsSync(KILL_FILE);
  } catch {
    return true;
  }
}

/** Current book-level circuit-breaker state (ARMED / tripped / locked / OFF). */
export async function provenGateState(): Promise<GateState> {
  if (!gateEnabled()) return "OFF";
  const snap = await railSnapshot();
  if (!snap) return "ARMED"; // fail-open
  if (snap.lockCode === "K2-LOCK") return "K2-LOCK";
  if (snap.lockCode === "K3-RUIN") return "K3-RUIN";
  if (snap.lockCode === "K4-INVALID") return "K4-INVALID";
  // BR-2.1: daily/weekly stops no longer veto — advisory telemetry only
  if (!railsOff() && snap.dailyBreached) return "DAILY-STOP";
  if (!railsOff() && snap.weeklyBreached) return "WEEKLY-STOP";
  if (snap.k1Tripped) return "K1-PAUSE";
  return "ARMED";
}

export interface ProvenGateCheck {
  ok: boolean;
  code?: "HOUR_MASK" | "TP1_FLOOR" | "DAILY_RAIL" | "WEEKLY_RAIL" | "K1" | "K2-LOCK" | "K3-RUIN" | "K4-INVALID";
  detail?: string;
}

/**
 * Per-candidate PROVEN veto — called from deploySignal AFTER tp1 is solved.
 * `bypass` = operator-forced OR raw-cal capture (deliberately unfiltered data program).
 */
export async function provenEntryGate(params: {
  symbol: string;
  direction: string;
  strategy: string;
  tp1: number;
  entry: number;
  bypass: boolean;
}): Promise<ProvenGateCheck> {
  rollCounters();
  if (params.bypass) {
    counters.bypass++;
    return { ok: true };
  }
  if (!gateEnabled()) return { ok: true };

  // book-level circuit breakers first (cheapest to evaluate via memo) —
  // Task 81: rails are $1000-basis denominated (see header) + K2/K3/K4 locks
  const snap = await railSnapshot().catch(() => null);
  if (snap) {
    if (snap.lockCode === "K2-LOCK") {
      counters.blockedByRail++;
      return { ok: false, code: "K2-LOCK", detail: `${snap.k2WeeklyHits30d} weekly-rail breaches in 30d — bankroll LOCK (operator reset required)` };
    }
    if (snap.lockCode === "K3-RUIN") {
      counters.blockedByRail++;
      return { ok: false, code: "K3-RUIN", detail: `basis ruin over ${300}-trade window — bankroll LOCK` };
    }
    if (snap.lockCode === "K4-INVALID") {
      counters.blockedByRail++;
      return { ok: false, code: "K4-INVALID", detail: `engine version drift — bankroll track invalidated` };
    }
    // BR-2.1: daily/weekly rails are advisory — they no longer veto deploys
    if (!railsOff() && snap.dailyBreached) {
      counters.blockedByRail++;
      return { ok: false, code: "DAILY_RAIL", detail: `basis realized today $${snap.todayNet.toFixed(2)} ≤ −$${Math.abs(DAILY_STOP)} (5% of $${BASIS_BANKROLL_USD}) — daily stop engaged` };
    }
    if (!railsOff() && snap.weeklyBreached) {
      counters.blockedByRail++;
      return { ok: false, code: "WEEKLY_RAIL", detail: `basis realized this week $${snap.weekNet.toFixed(2)} ≤ −$${Math.abs(WEEKLY_STOP)} (10% of $${BASIS_BANKROLL_USD}) — weekly stop engaged` };
    }
    if (snap.k1Tripped) {
      counters.blockedByRail++;
      return { ok: false, code: "K1", detail: `basis rolling-20 net $${(snap.rolling20Net ?? 0).toFixed(2)} ≤ −$${Math.abs(K1_ROLLING_NET)} — K1 circuit breaker` };
    }
  }

  // PROVEN hour mask
  const hour = tehranHourOf(Date.now());
  if (!PROVEN_HOURS.includes(hour)) {
    counters.vetoHour++;
    counters.lastVetoAt = Date.now();
    counters.lastVeto = { symbol: params.symbol, code: "HOUR_MASK", detail: `tehran h${hour}` };
    journal({ kind: "VETO", code: "HOUR_MASK", symbol: params.symbol, direction: params.direction, strategy: params.strategy, tehranHour: hour, hourMask: PROVEN_HOURS });
    return { ok: false, code: "HOUR_MASK", detail: `tehran hour ${hour} outside proven mask {${PROVEN_HOURS.join(",")}} (OOS overlay −$12.60→+$9.81 per $1)` };
  }

  // PROVEN tp1 floor
  const tp1Dist = params.entry > 0 ? (Math.abs(params.tp1 - params.entry) / params.entry) * 100 : 0;
  if (tp1Dist < TP1_FLOOR_PCT) {
    counters.vetoTp1++;
    counters.lastVetoAt = Date.now();
    counters.lastVeto = { symbol: params.symbol, code: "TP1_FLOOR", detail: `tp1 dist ${tp1Dist.toFixed(2)}%` };
    journal({ kind: "VETO", code: "TP1_FLOOR", symbol: params.symbol, direction: params.direction, strategy: params.strategy, tehranHour: hour, tp1DistPct: Number(tp1Dist.toFixed(3)) });
    return { ok: false, code: "TP1_FLOOR", detail: `tp1 distance ${tp1Dist.toFixed(2)}% < ${TP1_FLOOR_PCT}% — proven-negative zone (fee-graveyard)` };
  }

  counters.pass++;
  return { ok: true };
}

/** Early cheap pre-check (before the scan) — blocks whole deploys once a rail/lock engaged. */
export async function provenRailPrecheck(): Promise<ProvenGateCheck> {
  rollCounters();
  if (!gateEnabled()) return { ok: true };
  const chk = await bankrollRailCheck().catch(() => null);
  if (!chk || chk.ok) return { ok: true };
  counters.blockedByRail++;
  return { ok: false, code: chk.code, detail: `rail precheck: ${chk.detail} — no new deploys until the Tehran day/week rolls` };
}

// ── pulse-facing status ──────────────────────────────────────────────────────
export interface ProvenGateBlock {
  enabled: boolean;
  state: GateState;
  railsEnforced: boolean; // Task 82 BR-2.1 — false ⇒ daily/weekly advisory-only
  hours: number[];
  tp1FloorPct: number;
  dailyStop: number;
  weeklyStop: number;
  k1RollingNet: number;
  today: { pass: number; bypass: number; vetoHour: number; vetoTp1: number; blockedByRail: number };
  /** Task 81: RULES numbers — book nets re-denominated onto the $1000 basis */
  basis: { bankrollUsd: number; marginPerTradeUsd: number; todayNet: number | null; weekNet: number | null; rolling20Net: number | null };
  /** SEED numbers — the physical $100 book, untouched */
  book: { todayNet: number | null; weekNet: number | null; rolling20Net: number | null; currentHour: number; hourInMask: boolean };
  lastVeto: GateCounters["lastVeto"];
  lastVetoAt: number | null;
  updatedAt: number;
}

const MEMO_MS = 10_000;
let statusMemo: { at: number; block: ProvenGateBlock } | null = null;

export async function getProvenGateStatus(): Promise<ProvenGateBlock | null> {
  try {
    if (statusMemo && Date.now() - statusMemo.at < MEMO_MS) return statusMemo.block;
    rollCounters();
    const snap = await railSnapshot().catch(() => null);
    const currentHour = tehranHourOf(Date.now());
    const block: ProvenGateBlock = {
      enabled: gateEnabled(),
      state: await provenGateState(),
      railsEnforced: railsEnforcedNow(),
      hours: PROVEN_HOURS,
      tp1FloorPct: TP1_FLOOR_PCT,
      dailyStop: DAILY_STOP,
      weeklyStop: WEEKLY_STOP,
      k1RollingNet: K1_ROLLING_NET,
      today: { pass: counters.pass, bypass: counters.bypass, vetoHour: counters.vetoHour, vetoTp1: counters.vetoTp1, blockedByRail: counters.blockedByRail },
      basis: {
        bankrollUsd: BASIS_BANKROLL_USD,
        marginPerTradeUsd: BASIS_MARGIN_USD,
        todayNet: snap?.todayNet ?? null,
        weekNet: snap?.weekNet ?? null,
        rolling20Net: snap?.rolling20Net ?? null,
      },
      book: {
        todayNet: snap?.todayNetRaw ?? null,
        weekNet: snap?.weekNetRaw ?? null,
        rolling20Net: snap?.rolling20NetRaw ?? null,
        currentHour,
        hourInMask: PROVEN_HOURS.includes(currentHour),
      },
      lastVeto: counters.lastVeto,
      lastVetoAt: counters.lastVetoAt,
      updatedAt: Date.now(),
    };
    statusMemo = { at: Date.now(), block };
    return block;
  } catch {
    return null;
  }
}
