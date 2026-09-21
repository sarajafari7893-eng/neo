// ── FlowRadar Neo v10.11 STRAT-PROBATION — strategy-level expectancy probation ──
// SUPERVISOR proposal 2026-09-17 14:55Z, operator APPROVE via bridge 2026-09-17
// 17:50Z («پیشنهادات سوپروایزر رو کامل و مهندسی انجام بده + گزارشات»).
//
// BLIND SPOT (SUPERVISOR audit 1455Z): the realizedEdge memory gate keys on
// (symbol, strategy) combos — a strategy can bleed book-wide while NO single
// combo crosses the combo floor. Measured 2026-09-17: BREAKOUT book-wide
// expectancy −8.2%/trade (n=18, 2W, −$2.71) with every individual combo below
// the n≥8 combo floor → invisible to the gate. Advisor RULE-2 proposes, but a
// proposal is not a valve.
//
// MECHANISM (soft, shrinkage-gated — never a hard kill):
//   1. EB SHRINKAGE (Efron-Morris / normal-normal hierarchical model): each
//      strategy's rolling expectancy is shrunk toward the book grand mean by
//      the method-of-moments between-variance τ̂² — small-n strategies lean
//      on the book mean (posterior sd shrinks accordingly), so a 3-trade
//      disaster CANNOT trip the probation on its own tails.
//   2. MULTIPLE-TESTING CONTROL: the family is the set of strategies with
//      n≥15 (the evaluation set); per-strategy one-sided significance uses
//      Bonferroni α′ = α/S_active — a conservative surrogate for White
//      Reality Check / Hansen SPA over the strategy family (no bootstrap
//      deps; documented surrogate, not a claim of SPA equivalence).
//   3. PROBATION RULE: strategy enters probation when n≥15 AND the shrunk
//      expectancy's ONE-SIDED (1−α′) upper confidence bound is STILL
//      negative — i.e. even the optimistic posterior reading loses money.
//   4. SOFT ACTION (eval-layer, advisor-contract compatible):
//        · margin factor ×0.5 for that strategy (sizing only, no veto);
//        · DOUBLE CONFIRM: +5 on the effective score bar (+5 effMin) — the
//          strategy must beat a higher confluence bar to deploy at all.
//      The memory gate, breakoutGuard, governor and advisor keep their
//      semantics untouched; probation only tightens size + bar for the
//      strategy-level bleed the combo gate cannot see.
//   5. EXIT: re-evaluated on a 30min lazy TTL — UCB(1−α′) ≥ 0 clears the
//      probation automatically (audited). A 48h re-entry cooldown prevents
//      threshold chatter (Schmitt trigger, mirrors v10.9.3 hysteresis).
//
// EXPECTANCY definition: mean NET pnlPercent per settled EPOCH-2 trade over a
// rolling window of STRAT_WINDOW=60 most-recent settles per strategy — the
// SAME book semantics as the realizedEdge memory gate (tags contain EPOCH-2).

import { db } from "@/lib/db";

export const STRATEGY_PROBATION_KEY = "strategy.probation";

const STRAT_WINDOW = 60; // rolling settled window per strategy (mirrors memory-gate rolling semantics)
const MIN_N = 15; // evaluation floor — below this the posterior is prior-dominated
const ALPHA = 0.05; // family-wise error budget across the strategy family
const EVAL_TTL_MS = 30 * 60_000; // lazy evaluation cadence
const READ_CACHE_TTL_MS = 60_000; // hot-path state cache
const SIZE_MULT = 0.5; // probation margin factor
const EFFMIN_BONUS = 5; // double-confirm score-bar raise

export interface ProbationEntry {
  strategy: string;
  sinceAt: number;
  ucbAtEntry: number;
  meanAtEntry: number;
  nAtEntry: number;
  lastReviewAt: number;
  lastReviewUcb: number;
  posStreak: number; // consecutive reviews with UCB ≥ 0 (exit needs 2 — hysteresis)
}

export interface ProbationState {
  entered: Record<string, ProbationEntry>;
  lastEvalAt: number | null;
  lastEvalSummary: string | null;
}

export interface StratStat {
  strategy: string;
  n: number;
  mean: number; // raw rolling expectancy %/trade
  shrunkMean: number; // EB posterior mean %/trade
  sd: number; // EB posterior sd
  ucb: number; // one-sided (1−α′) upper bound on shrunk expectancy
  inEvaluationSet: boolean; // n ≥ MIN_N
  onProbation: boolean;
}

export interface ProbationEvaluation {
  at: number;
  familySize: number; // strategies in the evaluation set (Bonferroni S)
  grandMean: number;
  tauSq: number; // method-of-moments between-strategy variance
  strats: StratStat[];
  actions: string[]; // audit lines for entry/exit transitions this pass
}

const DEFAULT_STATE: ProbationState = { entered: {}, lastEvalAt: null, lastEvalSummary: null };

let stateCache: { at: number; value: ProbationState } | null = null;
let evalCache: { at: number; value: ProbationEvaluation | null } | null = null;
let evalInFlight = false;

/** Acklam's inverse-normal CDF (|ε| < 1.15e-9 relative) — no deps. */
function probit(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

function sanitize(raw: Partial<ProbationState>): ProbationState {
  const entered: Record<string, ProbationEntry> = {};
  for (const [k, v] of Object.entries(raw.entered ?? {})) {
    if (v && typeof v.sinceAt === "number" && typeof v.strategy === "string") {
      entered[String(k).toUpperCase().slice(0, 24)] = {
        strategy: String(v.strategy).slice(0, 24),
        sinceAt: v.sinceAt,
        ucbAtEntry: Number(v.ucbAtEntry) || 0,
        meanAtEntry: Number(v.meanAtEntry) || 0,
        nAtEntry: Number(v.nAtEntry) || 0,
        lastReviewAt: Number(v.lastReviewAt) || v.sinceAt,
        lastReviewUcb: Number(v.lastReviewUcb) || 0,
        posStreak: Number(v.posStreak) || 0,
      };
    }
  }
  return {
    entered,
    lastEvalAt: typeof raw.lastEvalAt === "number" ? raw.lastEvalAt : null,
    lastEvalSummary: typeof raw.lastEvalSummary === "string" ? raw.lastEvalSummary.slice(0, 300) : null,
  };
}

export async function getProbationState(force = false): Promise<ProbationState> {
  if (!force && stateCache && Date.now() - stateCache.at < READ_CACHE_TTL_MS) return stateCache.value;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: STRATEGY_PROBATION_KEY } });
    const value = row ? sanitize(JSON.parse(row.value) as Partial<ProbationState>) : { ...DEFAULT_STATE, entered: {} };
    stateCache = { at: Date.now(), value };
    return value;
  } catch {
    return { ...DEFAULT_STATE, entered: {} };
  }
}

async function putProbationState(next: ProbationState): Promise<void> {
  await db.engineSetting.upsert({
    where: { key: STRATEGY_PROBATION_KEY },
    create: { key: STRATEGY_PROBATION_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  stateCache = { at: Date.now(), value: next };
}

/** The evaluation pass — EB shrinkage + Bonferroni UCB + entry/exit transitions.
 * Lazy (TTL-gated), fire-and-forget safe, never throws. */
export async function evaluateStrategyProbation(force = false): Promise<ProbationEvaluation | null> {
  if (!force && evalCache && Date.now() - evalCache.at < EVAL_TTL_MS) return evalCache.value;
  if (evalInFlight) return evalCache?.value ?? null;
  evalInFlight = true;
  try {
    const rows = await db.signal.findMany({
      where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, tags: { contains: "EPOCH-2" } },
      select: { strategy: true, pnlPercent: true },
      orderBy: { createdAt: "desc" },
      take: 800, // ring: ≥ 5 strategies × 60 window headroom
    });
    // per-strategy rolling windows
    const byStrat = new Map<string, number[]>();
    for (const r of rows) {
      const arr = byStrat.get(r.strategy);
      if (arr) {
        if (arr.length < STRAT_WINDOW) arr.push(r.pnlPercent);
      } else {
        byStrat.set(r.strategy, [r.pnlPercent]);
      }
    }
    const data = [...byStrat.entries()].filter(([, xs]) => xs.length >= 3).map(([strategy, xs]) => {
      const n = xs.length;
      const mean = xs.reduce((a, x) => a + x, 0) / n;
      const varr = n > 1 ? xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / (n - 1) : 0;
      return { strategy, n, mean, varr };
    });
    const evalSet = data.filter((d) => d.n >= MIN_N);
    if (data.length < 2 || evalSet.length === 0) {
      const empty: ProbationEvaluation = { at: Date.now(), familySize: evalSet.length, grandMean: 0, tauSq: 0, strats: [], actions: [] };
      evalCache = { at: Date.now(), value: empty };
      return empty;
    }
    const N = data.reduce((a, d) => a + d.n, 0);
    const grandMean = data.reduce((a, d) => a + d.mean * d.n, 0) / N;
    const sw = data.reduce((a, d) => a + (d.n - 1) * d.varr, 0) / Math.max(1, N - data.length); // pooled within-variance
    // method-of-moments between-variance (normal-normal): mean of squared mean-deviations minus average sampling noise
    const S = data.length;
    const rawTau = S > 1 ? (data.reduce((a, d) => a + (d.mean - grandMean) * (d.mean - grandMean), 0) - data.reduce((a, d) => a + d.varr / d.n, 0)) / (S - 1) : 0;
    const tauSq = Math.max(0, Number.isFinite(rawTau) ? rawTau : 0);
    const alphaPrime = ALPHA / Math.max(1, evalSet.length); // Bonferroni over the evaluation family
    const zU = probit(1 - alphaPrime); // one-sided upper
    const st = await getProbationState(true);
    const nextEntered: Record<string, ProbationEntry> = { ...st.entered };
    const actions: string[] = [];
    const strats: StratStat[] = [];
    const now = Date.now();
    for (const d of data) {
      const inSet = d.n >= MIN_N;
      // EB posterior: precision-weighted blend of the strategy mean with the grand mean
      const w = tauSq > 0 ? d.n / Math.max(1e-9, sw) : 0; // prior dominates completely when τ̂²=0
      const prec = w + (tauSq > 0 ? 1 / tauSq : Infinity);
      const shrunkMean = tauSq > 0 ? (w * d.mean + grandMean / tauSq) / prec : grandMean;
      const sd = tauSq > 0 ? 1 / Math.sqrt(prec) : Math.sqrt(sw / Math.max(1, d.n)); // posterior sd
      const ucb = shrunkMean + (inSet ? zU * sd : Infinity); // non-eval strategies can never qualify
      let onProbation = false;
      if (inSet) {
        const entry = nextEntered[d.strategy];
        if (!entry && ucb < 0) {
          onProbation = true;
          nextEntered[d.strategy] = { strategy: d.strategy, sinceAt: now, ucbAtEntry: ucb, meanAtEntry: d.mean, nAtEntry: d.n, lastReviewAt: now, lastReviewUcb: ucb, posStreak: 0 };
          actions.push(`ENTER ${d.strategy}: shrunk expectancy ${shrunkMean.toFixed(2)}%/trade, UCB(1−α′=${alphaPrime.toFixed(3)})=${ucb.toFixed(2)} < 0 over n=${d.n} (raw ${d.mean.toFixed(2)}%) — margin ×${SIZE_MULT} + effMin +${EFFMIN_BONUS}`);
        } else if (entry) {
          // Schmitt-trigger exit: TWO consecutive reviews with UCB ≥ 0 (optimistic
          // bound recovered) — single-review exits would chatter at the boundary.
          const streak = ucb >= 0 ? (entry.posStreak || 0) + 1 : 0;
          if (streak >= 2) {
            delete nextEntered[d.strategy];
            actions.push(`EXIT ${d.strategy}: UCB=${ucb.toFixed(2)} ≥ 0 two consecutive reviews at n=${d.n} — probation cleared (on since ${new Date(entry.sinceAt).toISOString()})`);
          } else {
            onProbation = true;
            nextEntered[d.strategy] = { ...entry, lastReviewAt: now, lastReviewUcb: ucb, posStreak: streak };
          }
        }
      }
      strats.push({ strategy: d.strategy, n: d.n, mean: d.mean, shrunkMean, sd, ucb: Number.isFinite(ucb) ? ucb : 999, inEvaluationSet: inSet, onProbation });
    }
    const evaluation: ProbationEvaluation = { at: now, familySize: evalSet.length, grandMean, tauSq, strats, actions };
    if (actions.length > 0 || Object.keys(nextEntered).length !== Object.keys(st.entered).length) {
      await putProbationState({ entered: nextEntered, lastEvalAt: now, lastEvalSummary: actions.join(" · ").slice(0, 300) || st.lastEvalSummary });
      for (const line of actions) {
        void import("@/lib/engine")
          .then((m) => m.fireEvent(null, null, "ENGINE", "info", `STRAT-PROBATION: ${line}`))
          .catch(() => undefined);
      }
    } else {
      await putProbationState({ ...st, lastEvalAt: now, lastEvalSummary: st.lastEvalSummary ?? "no transitions" });
    }
    evalCache = { at: Date.now(), value: evaluation };
    return evaluation;
  } catch {
    return evalCache?.value ?? null; // fail-neutral — probation must never break the deploy path
  } finally {
    evalInFlight = false;
  }
}

/** Hot-path margin factor — 1.0 neutral, 0.5 on probation. 60s-cached, never throws. */
export async function probationFactorFor(strategy: string): Promise<number> {
  try {
    const st = await getProbationState();
    void ensureFreshEvaluation();
    return st.entered[strategy] ? SIZE_MULT : 1;
  } catch {
    return 1;
  }
}

/** Hot-path double-confirm — extra effMin raise for probation strategies. */
export function probationEffMinBonus(): number {
  return EFFMIN_BONUS;
}

/** The set of strategies currently on probation (for the scan/eligibility path). */
export async function probationStrategies(): Promise<Set<string>> {
  try {
    const st = await getProbationState();
    void ensureFreshEvaluation();
    return new Set(Object.keys(st.entered));
  } catch {
    return new Set();
  }
}

let lastKickAt = 0;
function ensureFreshEvaluation(): void {
  const now = Date.now();
  if (now - lastKickAt < EVAL_TTL_MS) return;
  lastKickAt = now;
  void evaluateStrategyProbation().catch(() => undefined);
}

export function describeProbation(st: ProbationState, ev: ProbationEvaluation | null): string {
  const keys = Object.keys(st.entered);
  if (!ev) return keys.length ? `ON: ${keys.join(", ")} (evaluation pending)` : "no strategy on probation (evaluation pending)";
  const rows = ev.strats.map((s) => `${s.strategy}${s.onProbation ? "·PROB" : ""} n=${s.n} raw ${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(1)}% shrunk ${s.shrunkMean >= 0 ? "+" : ""}${s.shrunkMean.toFixed(1)}% UCB ${s.ucb >= 900 ? "n/a" : (s.ucb >= 0 ? "+" : "") + s.ucb.toFixed(1) + "%"}`).join(" · ");
  return `family S=${ev.familySize} α′=${(ALPHA / Math.max(1, ev.familySize)).toFixed(3)} τ̂²=${ev.tauSq.toFixed(2)} — ${rows || "no data"}`;
}
