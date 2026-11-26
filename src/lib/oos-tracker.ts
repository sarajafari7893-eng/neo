// ── v11.6 OOS TRACKER (EQ-97 ③-b) — live progress toward the promotion bar ──
// The senior-supervisor review carried a STATIC line: "strategyValidationStatus:
// PROMOTE gate = FAIL (insufficient OOS n …)" — honest, but blind. This module
// makes the gap MEASURABLE and its ETA computable:
//  · OOS window start = the documented baseline freeze in
//    STRATEGY-VALIDATION-PROTOCOL.md §2: backtest ranAt 2026-09-19T07:17:36.841Z
//    (FLOWRADAR-NEO v5.1 AUTO-TUNE BASELINE) — every settled signal AFTER the
//    freeze is out-of-sample for that baseline.
//  · Targets from the same protocol §2/§9 (and param-governance.ts gates):
//    total OOS ≥ 300 (preferred 500), per-strategy ≥ 60.
//  · Fill rate from the trailing 14d settle pace → ETA days to the bar.
// Fail-soft: never throws; degrade to honest zeros on internal error.

import { db } from "./db";

export const OOS_WINDOW_START_ISO = "2026-09-19T07:17:36.841Z"; // protocol §2 baseline freeze (evidence anchor)
export const OOS_TOTAL_TARGET = 300; // protocol §9 / param-governance OOS_SAMPLE_TOO_SMALL gate
export const OOS_PER_STRATEGY_TARGET = 60; // protocol §9 / PER_STRATEGY_SAMPLE_TOO_SMALL gate
const SETTLED = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] as const;

export interface OosStrategyRow {
  strategy: string;
  oosN: number;
  target: number;
  fillPct: number;
  status: "OK" | "WEAK";
}

export interface OosTracker {
  windowStart: string;
  totalOosN: number;
  totalTarget: number;
  totalFillPct: number;
  perStrategy: OosStrategyRow[];
  weakStrategies: string[];
  settlePacePerDay14d: number;
  etaDaysToBar: number | null;
  etaIso: string | null;
  verdict: "PASS-ELIGIBLE" | "FAIL-OPEN-GAPS";
  note: string;
}

export async function getOosTracker(): Promise<OosTracker> {
  const start = new Date(OOS_WINDOW_START_ISO);
  const [grouped, recent14d] = await Promise.all([
    db.signal.groupBy({
      by: ["strategy"],
      where: { status: { in: [...SETTLED] }, createdAt: { gte: start } },
      _count: { _all: true },
    }),
    db.signal.count({
      where: { status: { in: [...SETTLED] }, createdAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
    }),
  ]);
  const perStrategy: OosStrategyRow[] = grouped
    .map((g) => {
      const oosN = g._count._all;
      return {
        strategy: g.strategy,
        oosN,
        target: OOS_PER_STRATEGY_TARGET,
        fillPct: Number(Math.min(100, (oosN / OOS_PER_STRATEGY_TARGET) * 100).toFixed(1)),
        status: (oosN >= OOS_PER_STRATEGY_TARGET ? "OK" : "WEAK") as "OK" | "WEAK",
      };
    })
    .sort((a, b) => b.oosN - a.oosN);
  const totalOosN = perStrategy.reduce((s, r) => s + r.oosN, 0);
  const weakStrategies = perStrategy.filter((r) => r.status === "WEAK").map((r) => r.strategy);
  const pace = recent14d / 14; // settled rows/day, trailing 14d
  const remaining = Math.max(0, OOS_TOTAL_TARGET - totalOosN);
  const etaDays = pace > 0 && remaining > 0 ? remaining / pace : remaining === 0 ? 0 : null;
  return {
    windowStart: OOS_WINDOW_START_ISO,
    totalOosN,
    totalTarget: OOS_TOTAL_TARGET,
    totalFillPct: Number(Math.min(100, (totalOosN / OOS_TOTAL_TARGET) * 100).toFixed(1)),
    perStrategy,
    weakStrategies,
    settlePacePerDay14d: Number(pace.toFixed(1)),
    etaDaysToBar: etaDays === null ? null : Number(etaDays.toFixed(1)),
    etaIso: etaDays !== null && remaining > 0 ? new Date(Date.now() + etaDays * 86_400_000).toISOString() : remaining === 0 ? new Date().toISOString() : null,
    verdict: totalOosN >= OOS_TOTAL_TARGET && weakStrategies.length === 0 ? "PASS-ELIGIBLE" : "FAIL-OPEN-GAPS",
    note:
      "OOS = settled signals after the 2026-09-19 baseline freeze (STRATEGY-VALIDATION-PROTOCOL.md §2). " +
      "Promotion additionally requires evidence refs + frozen production config (param-governance.ts) — this tracker measures ONLY the sample-size leg.",
  };
}
