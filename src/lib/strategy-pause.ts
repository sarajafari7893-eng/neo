// ── v11.6 STRATEGY-PAUSE — data-driven per-strategy risk switch (EQ-97) ──
// Operator order (trace 1a1344a53e7ff2d1): «سه اقدام واقعی باقیمانده و مأموریت
// بعدی را کامل و مهندسی اجرا کن». The senior-supervisor review (2026-10-13
// 02:49Z) listed "توقف اجرای استراتژی AI-SCALP تا بازبینی" as its #1 action;
// the ledger corroborates with an overwhelming cohort: 14d n=284 settled,
// WR 6.0%, net −$39.35 (gross −$24.48 + fees $14.86) — the worst
// fee-adjusted bleed per trade in the book.
//
// WHAT IT IS (honest engineering, no discretion drift):
//  · A strategy-level PAUSE gate in the deploy chain (engine.ts, same family
//    as SYMBOL-CAP / RISK-CLUSTER): auto deploys of a paused strategy are
//    refused (409), gate-block journaled, near-miss captured. Operator-forced
//    and capture-authority deploys are never refused — they deploy tagged
//    STRAT-PAUSE so the override cohort stays auditable.
//  · State lives in EngineSetting key "strat-pause.state" (anti-NaN heal on
//    read, same pattern as raw-cal.ts / close-all.ts).
//  · Fail-open: any internal error leaves the gate open — a monitoring switch
//    must never wedge the engine.
//  · Every enable/disable writes an ENGINE SignalEvent + Telegram push (by
//    the API route) so the decision trail is permanent.

import { db } from "./db";

export const STRAT_PAUSE_KEY = "strat-pause.state";

export interface StrategyPauseEntry {
  enabled: boolean;
  reason: string;
  by: string;
  since: string;
  /** evidence snapshot frozen at pause time (numbers, not adjectives) */
  evidence: string;
}

export interface StrategyPauseState {
  version: 1;
  pauses: Record<string, StrategyPauseEntry>;
  lastChangedAt: string | null;
  lastChangedBy: string | null;
}

const DEFAULT_STATE: StrategyPauseState = {
  version: 1,
  pauses: {},
  lastChangedAt: null,
  lastChangedBy: null,
};

// TASK-49-style anti-NaN heal — a wedged write can never pin the gate shut.
function healState(raw: Partial<StrategyPauseState>): StrategyPauseState {
  const pauses: Record<string, StrategyPauseEntry> = {};
  for (const [k, v] of Object.entries(raw.pauses ?? {})) {
    if (!v || typeof v !== "object") continue;
    pauses[k] = {
      enabled: v.enabled === true,
      reason: typeof v.reason === "string" ? v.reason.slice(0, 300) : "paused",
      by: typeof v.by === "string" ? v.by.slice(0, 120) : "OPERATOR",
      since: typeof v.since === "string" ? v.since : new Date().toISOString(),
      evidence: typeof v.evidence === "string" ? v.evidence.slice(0, 300) : "",
    };
  }
  return {
    version: 1,
    pauses,
    lastChangedAt: typeof raw.lastChangedAt === "string" ? raw.lastChangedAt : null,
    lastChangedBy: typeof raw.lastChangedBy === "string" ? raw.lastChangedBy : null,
  };
}

export async function getStrategyPauseState(): Promise<StrategyPauseState> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: STRAT_PAUSE_KEY } });
    if (!row) return { ...DEFAULT_STATE, pauses: {} };
    return healState(JSON.parse(row.value) as Partial<StrategyPauseState>);
  } catch {
    return { ...DEFAULT_STATE, pauses: {} };
  }
}

// 15s memo for the hot deploy path — state changes invalidate it.
let memo: { at: number; state: StrategyPauseState } | null = null;
const MEMO_MS = 15_000;
export function invalidateStrategyPauseMemo(): void {
  memo = null;
}

export async function isStrategyPaused(strategy: string): Promise<boolean> {
  try {
    if (!memo || Date.now() - memo.at > MEMO_MS) {
      memo = { at: Date.now(), state: await getStrategyPauseState() };
    }
    return memo.state.pauses[strategy]?.enabled === true;
  } catch {
    return false; // fail-open
  }
}

export async function setStrategyPause(
  strategy: string,
  patch: { enabled: boolean; reason: string; by: string; evidence?: string },
): Promise<StrategyPauseState> {
  const cur = await getStrategyPauseState();
  const next: StrategyPauseState = {
    ...cur,
    pauses: {
      ...cur.pauses,
      [strategy]: {
        enabled: patch.enabled,
        reason: patch.reason.slice(0, 300),
        by: patch.by.slice(0, 120),
        since: patch.enabled ? new Date().toISOString() : cur.pauses[strategy]?.since ?? new Date().toISOString(),
        evidence: (patch.evidence ?? "").slice(0, 300),
      },
    },
    lastChangedAt: new Date().toISOString(),
    lastChangedBy: patch.by.slice(0, 120),
  };
  await db.engineSetting.upsert({
    where: { key: STRAT_PAUSE_KEY },
    create: { key: STRAT_PAUSE_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  invalidateStrategyPauseMemo();
  return next;
}

/** Trailing settled-cohort evidence for one strategy (fee-aware net). */
export interface StrategyTrailingStats {
  strategy: string;
  windowDays: number;
  n: number;
  wins: number;
  winRatePct: number;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
}

export async function strategyTrailingStats(strategy: string, days = 14): Promise<StrategyTrailingStats> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.signal.findMany({
    where: { strategy, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, createdAt: { gte: since } },
    select: { marginUsd: true, pnlPercent: true, feeUsd: true, swapUsd: true, reachedTp: true },
  });
  let wins = 0;
  let gross = 0;
  let fees = 0;
  for (const r of rows) {
    if (r.reachedTp >= 1) wins += 1;
    gross += (r.marginUsd * r.pnlPercent) / 100;
    fees += (r.feeUsd ?? 0) + (r.swapUsd ?? 0);
  }
  const n = rows.length;
  return {
    strategy,
    windowDays: days,
    n,
    wins,
    winRatePct: n ? Number(((wins / n) * 100).toFixed(1)) : 0,
    grossUsd: Number(gross.toFixed(2)),
    feesUsd: Number(fees.toFixed(2)),
    netUsd: Number((gross - fees).toFixed(2)),
  };
}
