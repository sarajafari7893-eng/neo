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
  etaBasis: string; // v11.7 — what the ETA was computed against (honesty label)
  verdict: "PASS-ELIGIBLE" | "FAIL-OPEN-GAPS";
  note: string;
}

export async function getOosTracker(): Promise<OosTracker> {
  const start = new Date(OOS_WINDOW_START_ISO);
  const [grouped, recent14d, grouped14d] = await Promise.all([
    db.signal.groupBy({
      by: ["strategy"],
      where: { status: { in: [...SETTLED] }, createdAt: { gte: start } },
      _count: { _all: true },
    }),
    db.signal.count({
      where: { status: { in: [...SETTLED] }, createdAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
    }),
    // v11.7 — per-strategy trailing pace: the bar is a CONJUNCTION (total ≥300 AND
    // every leg ≥60), so the honest ETA is set by the SLOWEST leg, not the total.
    // The pre-v11.7 ETA used the total remaining only: it read 0d while the gate
    // still said FAIL-OPEN-GAPS (MOMENTUM 15/60) — a self-contradicting report.
    db.signal.groupBy({
      by: ["strategy"],
      where: { status: { in: [...SETTLED] }, createdAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
      _count: { _all: true },
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
  const pace14d = new Map(grouped14d.map((g) => [g.strategy, g._count._all / 14]));
  const pace = recent14d / 14; // settled rows/day, trailing 14d
  const totalRemaining = Math.max(0, OOS_TOTAL_TARGET - totalOosN);
  // v11.7 honest ETA — gated by the slowest OPEN leg when the conjunction is not met
  let etaDays: number | null;
  let etaBasis: string;
  if (weakStrategies.length === 0 && totalRemaining === 0) {
    etaDays = 0;
    etaBasis = "bar met (total + all legs)";
  } else if (weakStrategies.length > 0) {
    const legs = weakStrategies.map((s) => {
      const rem = Math.max(0, OOS_PER_STRATEGY_TARGET - (perStrategy.find((r) => r.strategy === s)?.oosN ?? 0));
      const p = pace14d.get(s) ?? 0;
      return { s, rem, p, days: p > 0 ? rem / p : null };
    });
    const stalled = legs.filter((l) => l.days === null);
    const open = legs.filter((l) => l.days !== null) as Array<{ s: string; rem: number; p: number; days: number }>;
    if (stalled.length > 0) {
      etaDays = null;
      etaBasis = `gated by stalled leg(s) with zero 14d pace: ${stalled.map((l) => l.s).join(",")}`;
    } else {
      const slowest = open.sort((a, b) => b.days - a.days)[0]!;
      etaDays = Number(slowest.days.toFixed(1));
      etaBasis = `slowest open leg ${slowest.s} (${slowest.rem} left @ ${slowest.p.toFixed(1)}/day)`;
    }
  } else {
    etaDays = pace > 0 ? Number((totalRemaining / pace).toFixed(1)) : null;
    etaBasis = "total sample remaining at trailing 14d pace";
  }
  return {
    windowStart: OOS_WINDOW_START_ISO,
    totalOosN,
    totalTarget: OOS_TOTAL_TARGET,
    totalFillPct: Number(Math.min(100, (totalOosN / OOS_TOTAL_TARGET) * 100).toFixed(1)),
    perStrategy,
    weakStrategies,
    settlePacePerDay14d: Number(pace.toFixed(1)),
    etaDaysToBar: etaDays,
    etaIso: etaDays !== null && etaDays > 0 ? new Date(Date.now() + etaDays * 86_400_000).toISOString() : etaDays === 0 ? new Date().toISOString() : null,
    etaBasis,
    verdict: totalOosN >= OOS_TOTAL_TARGET && weakStrategies.length === 0 ? "PASS-ELIGIBLE" : "FAIL-OPEN-GAPS",
    note:
      "OOS = settled signals after the 2026-09-19 baseline freeze (STRATEGY-VALIDATION-PROTOCOL.md §2). " +
      "Promotion additionally requires evidence refs + frozen production config (param-governance.ts) — this tracker measures ONLY the sample-size leg. " +
      "The bar is a CONJUNCTION: total ≥ 300 AND every per-strategy leg ≥ 60 — a 100% total fill with a weak leg is still FAIL-OPEN-GAPS (v11.7 honesty note).",
  };
}
