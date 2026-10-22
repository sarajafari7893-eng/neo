// ── v11.5 GLOBAL OPEN-PNL CLOSE-ALL BREAKER (operator mandate 2026-10-12) ──
// «اگر مجموع open pnl به 20$ رسید تمام معاملات بسته شود»
//
// BOOK-LEVEL PROFIT-LOCK CIRCUIT BREAKER: when the SUM of unrealized (fee-NET)
// PnL across ALL open signals reaches the target (default +$20), the engine
// closes EVERY open signal at the current live mark in ONE audited sweep —
// the book's aggregate open profit is banked instead of riding round-trips.
//
// Design contract:
//   · NET accounting — the trigger reads the same fee-NET unrealized number
//     the dashboard's ACCOUNT bar shows (feeBreakdown on the tranche-aware
//     live mark), not gross.
//   · Honest settlement — every closed row settles with the engine's standard
//     math (tranche-aware for banked rungs, feeBreakdown NET, real fees),
//     status CLOSED + tag CLOSE-ALL, per-row event + one summary event.
//   · Fail-soft — rows whose symbol has no live price are NOT invented-
//     settled; they stay open for the normal settlement loop (v10.16
//     settlement-staleness doctrine) and the breaker re-fires next tick.
//   · Operator-tunable — enabled/targetUsd live in EngineSetting
//     "closeall.state" (POST /api/closeall, x-nexus-key/session gated by the
//     control-plane middleware); defaults ON at $20.
//   · FLAT-10 untouched — margin is never resized; this is an exit rule.

import { db } from "./db";

export const CLOSEALL_KEY = "closeall.state";
export const CLOSEALL_DEFAULT_TARGET = 20;

export interface CloseAllState {
  enabled: boolean;
  targetUsd: number;
  lastTriggeredAt: string | null;
  triggerCount: number;
  lastClosedN: number | null;
  lastClosedUsd: number | null;
}

const DEFAULT_STATE: CloseAllState = {
  enabled: true,
  targetUsd: CLOSEALL_DEFAULT_TARGET,
  lastTriggeredAt: null,
  triggerCount: 0,
  lastClosedN: null,
  lastClosedUsd: null,
};

/** NaN-proof read (same discipline as raw-cal.ts Task-49): a bad historic
 * write can never wedge the breaker — enabled heals to true, target to 20. */
export async function getCloseAllState(): Promise<CloseAllState> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: CLOSEALL_KEY } });
    if (!row) return { ...DEFAULT_STATE };
    const raw = { ...DEFAULT_STATE, ...(JSON.parse(row.value) as Partial<CloseAllState>) };
    const num = (v: unknown, dflt: number): number =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_STATE.enabled,
      targetUsd: num(raw.targetUsd, CLOSEALL_DEFAULT_TARGET),
      lastTriggeredAt: typeof raw.lastTriggeredAt === "string" ? raw.lastTriggeredAt : null,
      triggerCount: num(raw.triggerCount, 0),
      lastClosedN: typeof raw.lastClosedN === "number" && Number.isFinite(raw.lastClosedN) ? raw.lastClosedN : null,
      lastClosedUsd: typeof raw.lastClosedUsd === "number" && Number.isFinite(raw.lastClosedUsd) ? raw.lastClosedUsd : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function setCloseAllState(patch: Partial<Pick<CloseAllState, "enabled" | "targetUsd">>): Promise<CloseAllState> {
  const cur = await getCloseAllState();
  const next: CloseAllState = {
    ...cur,
    ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
    ...(typeof patch.targetUsd === "number" && Number.isFinite(patch.targetUsd) && patch.targetUsd > 0
      ? { targetUsd: Math.min(500, Math.max(1, patch.targetUsd)) }
      : {}),
  };
  await db.engineSetting.upsert({
    where: { key: CLOSEALL_KEY },
    create: { key: CLOSEALL_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return next;
}

export async function recordCloseAllTrigger(closedN: number, closedUsd: number): Promise<void> {
  const cur = await getCloseAllState();
  const next: CloseAllState = {
    ...cur,
    lastTriggeredAt: new Date().toISOString(),
    triggerCount: cur.triggerCount + 1,
    lastClosedN: closedN,
    lastClosedUsd: Number(closedUsd.toFixed(2)),
  };
  await db.engineSetting.upsert({
    where: { key: CLOSEALL_KEY },
    create: { key: CLOSEALL_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
}
