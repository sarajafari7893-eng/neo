// ── FlowRadar Neo v10.6 PER-STRATEGY SIZING WEIGHTS (server-only) ───────────
// SUPERVISOR proposal, completed for operator decision (mandate 2026-09-15:
// «وزن‌دهی per-strategy به جای سایز سراسری — قطع خون AI-SWING، تقویت AI-SCALP»).
//
// WHY (7-day audit 2026-09-15): the book sizes every strategy with ONE global
// margin formula, so the worst cohort gets the most capital:
//   · AI-SWING  = 57% of the settled book, expectancy −1.87%/trade → the
//     single largest bleed (the "blood" this module is built to cut);
//   · AI-SCALP  = +0.84%/trade and MEAN-REVERT = +0.58%/trade — the proven
//     positive edges stay under-allocated;
//   · BREAKOUT  = −10.82% realized (already fenced by breakoutGuard).
// A per-strategy multiplier on the FINAL margin keeps every gate, geometry and
// risk cap untouched — only the stake changes. Staged weights live in
// EngineSetting "strategy.weights"; while enabled=false every weight reads 1.0
// (mechanism deployed, activation = one explicit operator decision).
//
// ACTIVATED + REALLOCATED (operator mandate trace 1a16ff36143328fd, applied
// 2026-10-25 via audited script scripts/apply-strategy-weights-20261025.ts)
// from the FRESH 15-day audit (window 2026-10-10→25, n=974 CLEAN signals):
// AI-SCALP ×0.25 (n=64 WR30% net −$11.34 — pause-by-sizing at clamp floor),
// MEAN-REVERT ×0.5 (n=90 WR38% −$13.98), BREAKOUT ×1.25 (native n=188 WR64%
// +$110.45; surrogate cohort vetoed by the P0-a SURROGATE-BREAKOUT gate),
// AI-SWING ×1.0 (workhorse, native +$104.07), MOMENTUM ×1.0 (n=6 insufficient).
// The STAGED_PROPOSAL below is the superseded 2026-09-15 draft (kept for
// history only — it is NOT live and only renders when the module is OFF).
//
// Invariants: weight ∈ [0.25, 2.0] per strategy (clamped), unknown strategies
// read 1.0, disabled module reads 1.0, every activation change auditable via
// /api/strategy-weights POST (ENGINE event).

import { db } from "@/lib/db";

export const STRATEGY_WEIGHTS_KEY = "strategy.weights";

export const STRATEGY_LIST = ["AI-SCALP", "MEAN-REVERT", "MOMENTUM", "BREAKOUT", "AI-SWING"] as const;
export type StrategyName = (typeof STRATEGY_LIST)[number];

const W_LO = 0.25;
const W_HI = 2.0;

export interface StrategyWeights {
  enabled: boolean;
  weights: Record<string, number>;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** v10.6 STAGED PROPOSAL (decision-ready, NOT active) — computed from the
 * 7-day ledger: cut the bleeders to half stake, boost the proven edges. The
 * operator activates by flipping enabled=true (API / dashboard / audited script). */
export const STAGED_PROPOSAL: Record<string, number> = {
  "AI-SWING": 0.5, // 57% of book @ −1.87%/trade — halve the bleed, keep the learning signal
  "AI-SCALP": 1.5, // +0.84%/trade — feed the positive edge
  "MEAN-REVERT": 1.25, // +0.58%/trade — feed the second positive edge
  MOMENTUM: 1.0, // neutral — insufficient settled n to judge
  BREAKOUT: 0.5, // −10.82% realized — already guard-fenced; half-size if it ever passes
};

const DEFAULTS: StrategyWeights = { enabled: false, weights: {}, updatedAt: null, updatedBy: null };

let cache: { at: number; value: StrategyWeights } | null = null;
const CACHE_TTL = 15_000;

function sanitize(raw: Partial<StrategyWeights>): StrategyWeights {
  const weights: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.weights ?? {})) {
    const num = Number(v);
    if (Number.isFinite(num)) weights[String(k).toUpperCase().slice(0, 24)] = Math.min(W_HI, Math.max(W_LO, Math.round(num * 100) / 100));
  }
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    weights,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy.slice(0, 80) : null,
  };
}

export async function getStrategyWeights(force = false): Promise<StrategyWeights> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL) return cache.value;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: STRATEGY_WEIGHTS_KEY } });
    const value = row ? sanitize(JSON.parse(row.value) as Partial<StrategyWeights>) : { ...DEFAULTS };
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return { ...DEFAULTS };
  }
}

export async function putStrategyWeights(next: Partial<StrategyWeights>, by = "OPERATOR"): Promise<StrategyWeights> {
  const cur = await getStrategyWeights(true);
  const merged = sanitize({
    enabled: next.enabled ?? cur.enabled,
    weights: { ...cur.weights, ...(next.weights ?? {}) },
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  });
  await db.engineSetting.upsert({
    where: { key: STRATEGY_WEIGHTS_KEY },
    create: { key: STRATEGY_WEIGHTS_KEY, value: JSON.stringify(merged) },
    update: { value: JSON.stringify(merged) },
  });
  cache = { at: Date.now(), value: merged };
  return merged;
}

/** The ONE function the deploy path consumes — 15s-cached, never throws.
 * Returns 1.0 while disabled (neutral), the clamped weight when active. */
export async function strategyWeightFor(strategy: string): Promise<number> {
  try {
    const sw = await getStrategyWeights();
    if (!sw.enabled) return 1;
    const w = sw.weights[strategy];
    return Number.isFinite(w) ? (w as number) : 1;
  } catch {
    return 1;
  }
}

export function describeStrategyWeights(sw: StrategyWeights): string {
  if (!sw.enabled) {
    const staged = STRATEGY_LIST.map((s) => `${s}:${STAGED_PROPOSAL[s] ?? 1}`).join(" ");
    return `OFF (staged: ${staged} — awaiting operator activation)`;
  }
  const live = STRATEGY_LIST.map((s) => `${s}:×${sw.weights[s] ?? 1}`).join(" ");
  return `ACTIVE ${live} (updated ${sw.updatedAt ?? "n/a"} by ${sw.updatedBy ?? "n/a"})`;
}
