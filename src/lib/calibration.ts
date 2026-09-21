// ── FlowRadar Neo factor-weight calibration (server-only) ──
// v6.3 PROFIT-FIRST CALIBRATION (operator mandate: «کالیبراتور با معیار سود،
// نه تعداد برد»): factor weights are driven by NET PNL expectancy, not raw
// win rate. A factor that wins 44% of the time but bleeds -13%/trade on its
// losers is a LIABILITY (measured: BREAKOUT cohort) — raw WR could not see
// that; expectancy can. Per factor (strong votes only, n≥10 floor):
//
//   expectancy_f = Σ pnlPercent / n          (avg %/trade attributed)
//   profitFactor_f = Σ wins$ / |Σ losses$|   (gross wins ÷ gross losses)
//   weight_f = clamp(1 + expectancy/15 + 0.15·tanh(PF−1), 0.70, 1.30)
//
// Monotone in profit: +4.5%/trade ≈ +0.3 weight, 0%/trade ≈ 1.0, losers sink.
// Calibration goes ACTIVE at ≥30 settled signals, otherwise OBSERVING.
//
// v10.16 R6 QUALITY GATE (audit 4-f): the R6 freeze lift no longer fires on the
// n-count alone — the rawcal sample-quality gate must co-approve (verdict GREEN
// or blended informative ≥ 50%). Rationale: the lift re-fits factor weights on
// the EPOCH-2 book whose recent majority is RAW-CAL capture rows; when the
// raw cohort is censored (informative 43.4% AMBER live), the re-fit optimizes
// against time-censored outcomes. rawcal-quality.ts explicitly never edits the
// calibration math — so the CONDITIONING lives here, at the single decision
// point. No other calibration math is touched.

import { db } from "@/lib/db";
import type { FactorWeights } from "./indicators";
import { computeRawcalQuality, type RawcalQualityDigest } from "./rawcal-quality";

export interface FactorCalRow {
  factor: string;
  weight: number;
  n: number;
  /** v6.3 profit-first columns */
  expectancy: number; // avg NET %/trade attributed to this factor's strong votes
  netPct: number; // Σ pnlPercent (the factor's net PNL share numerator)
  profitFactor: number; // Σ gains / |Σ losses| (capped at 9.9 for display)
  winRate: number; // kept for transparency — no longer drives the weight
  /** display aliases consumed by the memory card UI (kept in sync) */
  avgPct: number; // = expectancy
  pnlUsd: number; // netPct converted at the ledger's mean margin (~$1) for display parity
}

export interface CalibrationState {
  // v8.4.1 G3: FROZEN — the R3/R6 freeze is ON (weights locked, display-only recompute).
  // target reflects the R6 lift bar (epoch-2 minN=100) while frozen, not ACTIVE_AT.
  status: "OBSERVING" | "ACTIVE" | "FROZEN";
  settled: number;
  target: number;
  /** v6.3: criterion provenance — the operator can always see which metric rules */
  criterion: "NET-PNL-EXPECTANCY";
  weights: FactorWeights;
  rows: FactorCalRow[];
  updatedAt: string | null;
}

const KEY = "calibration";
const ACTIVE_AT = 30;
const N_FLOOR = 10;
const MOVING_FACTORS = ["EMA STACK", "MACD MOMENTUM", "RSI POSITION", "RANGE BREAKOUT", "BOLLINGER EXTREME", "VOLUME CONFIRM"];
/** %/trade of expectancy that maps to a full ±0.3 weight swing */
const EXPECTANCY_SCALE = 15;
/** weight ceiling/floor (matches the deploy-scan clamp in getEffectiveWeights) */
const W_MIN = 0.7;
const W_MAX = 1.3;

// ── v8.4 R3+R6 CALIBRATION FREEZE (module-performance audit 2026-09-11) ──
// Evidence: confidence calibration ran INVERTED (conf-80 bucket avgPnl −14.6%
// vs conf-70 −6.1%; 75%+ basket −$10.10) and the weights floored at 0.70 on
// negative-expectancy factors with n=35 — Wilson-LB far too thin to move on.
// R3: weights are FROZEN at a one-time recalibration over EPOCH-2-only rows.
// R6: no weight may move again until the epoch-2 book reaches minN settled
// samples (100) — then the freeze auto-lifts and normal calibration resumes.
const FROZEN_KEY = "calibration.frozen";
/** v10.16 — audit trail key for lift checks blocked by the rawcal quality gate. */
const R6_LIFT_BLOCKED_KEY = "calibration.r6.liftBlocked";
/** v10.16 — the blended informative share that co-approves the R6 lift
 * (alongside gate verdict GREEN). Matches the rawcal gate's GREEN informative bar. */
const R6_INFORMATIVE_FLOOR = 50;
const FREEZE_MIN_N = 100; // R6 gate — Wilson-LB width ∝ 1/√n; 100 ≈ ±10% at 50%
const FREEZE_EPOCH_TAG = "EPOCH-2";

export interface CalibrationFreezeState {
  frozen: boolean;
  reason: string;
  minN: number;
  epoch: string;
  frozenAt: string;
  frozenSettled: number;
}

async function readFreeze(): Promise<CalibrationFreezeState | null> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: FROZEN_KEY } });
    return row ? (JSON.parse(row.value) as CalibrationFreezeState) : null;
  } catch {
    return null;
  }
}

async function writeFreeze(state: CalibrationFreezeState): Promise<void> {
  await db.engineSetting.upsert({ where: { key: FROZEN_KEY }, create: { key: FROZEN_KEY, value: JSON.stringify(state) }, update: { value: JSON.stringify(state) } });
}

/**
 * R3 bootstrap (idempotent): the FIRST call computes the calibration over
 * EPOCH-2 rows only, persists those weights as the frozen book, and locks.
 * Later calls are no-ops; after an R6 lift (frozen:false) it never re-freezes.
 */
export async function ensureCalibrationFrozen(): Promise<CalibrationFreezeState> {
  const existing = await readFreeze();
  if (existing) return existing;
  const epoch2 = await computeCalibration(true);
  const state: CalibrationFreezeState = {
    frozen: true,
    reason: `R3 audit 2026-09-11: calibration INVERTED (conf-80 bucket −14.6%/trade vs conf-70 −6.1%) with n=35 — weights recalibrated on ${epoch2.settled} EPOCH-2 settled rows and frozen (R6: no movement until n≥${FREEZE_MIN_N})`,
    minN: FREEZE_MIN_N,
    epoch: FREEZE_EPOCH_TAG,
    frozenAt: new Date().toISOString(),
    frozenSettled: epoch2.settled,
  };
  await db.engineSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify({ ...epoch2, updatedAt: new Date().toISOString() }) },
    update: { key: KEY, value: JSON.stringify({ ...epoch2, updatedAt: new Date().toISOString() }) },
  });
  hot = null; // drop the hot cache so the frozen book is what deploys read
  await writeFreeze(state);
  return state;
}

interface Acc {
  n: number;
  wins: number;
  sumPct: number;
  gains: number;
  losses: number;
  sumUsd: number; // net USD PNL attributed (marginUsd × pnlPercent)
}

export async function computeCalibration(epoch2Only = false): Promise<CalibrationState> {
  const settled = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    select: { pnlPercent: true, reachedTp: true, marginUsd: true, factorsJson: true, tags: true },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  // v8.4 R3: the frozen book must reflect the CURRENT ledger epoch only —
  // pre-reset rows (different sizing/fee regime) would poison the weights.
  const epochRows = epoch2Only ? settled.filter((s) => (s.tags ?? "").includes("EPOCH-2")) : settled;

  // accumulate per-factor strong-vote PNL ledgers
  const acc = new Map<string, Acc>();
  for (const f of MOVING_FACTORS) acc.set(f, { n: 0, wins: 0, sumPct: 0, gains: 0, losses: 0, sumUsd: 0 });

  for (const s of epochRows) {
    if (!s.factorsJson) continue;
    let votes: Array<{ factor: string; vote: number }> = [];
    try {
      votes = JSON.parse(s.factorsJson) as Array<{ factor: string; vote: number }>;
    } catch {
      continue;
    }
    for (const v of votes) {
      const cell = acc.get(v.factor);
      if (!cell || Math.abs(v.vote) < 8) continue; // strong votes only
      cell.n++;
      cell.sumPct += s.pnlPercent;
      cell.sumUsd += (s.marginUsd * s.pnlPercent) / 100;
      if (s.pnlPercent >= 0) cell.gains += s.pnlPercent;
      else cell.losses += Math.abs(s.pnlPercent);
      // v5.4 TP-proven win kept for the transparency column only
      if (s.pnlPercent > 0 || s.reachedTp >= 1) cell.wins++;
    }
  }

  const rows: FactorCalRow[] = [];
  const weights: FactorWeights = {};
  for (const f of MOVING_FACTORS) {
    const cell = acc.get(f)!;
    if (cell.n < N_FLOOR) continue;
    const expectancy = cell.sumPct / cell.n;
    const pf = cell.losses > 0 ? Math.min(9.9, cell.gains / cell.losses) : 9.9;
    const raw = 1 + expectancy / EXPECTANCY_SCALE + 0.15 * Math.tanh(pf - 1);
    const w = Math.min(W_MAX, Math.max(W_MIN, raw));
    weights[f] = Number(w.toFixed(3));
    rows.push({
      factor: f,
      weight: weights[f]!,
      n: cell.n,
      expectancy: Number(expectancy.toFixed(2)),
      netPct: Number(cell.sumPct.toFixed(1)),
      profitFactor: Number(pf.toFixed(2)),
      winRate: Number(((cell.wins / cell.n) * 100).toFixed(1)),
      avgPct: Number(expectancy.toFixed(2)),
      pnlUsd: Number(cell.sumUsd.toFixed(2)),
    });
  }

  let updatedAt: string | null = null;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    if (row) {
      const prev = JSON.parse(row.value) as CalibrationState;
      updatedAt = prev.updatedAt ?? null;
    }
  } catch {
    /* ignore */
  }

  return {
    status: (epoch2Only ? epochRows : settled).length >= ACTIVE_AT ? "ACTIVE" : "OBSERVING",
    settled: (epoch2Only ? epochRows : settled).length,
    target: ACTIVE_AT,
    criterion: "NET-PNL-EXPECTANCY",
    weights,
    rows,
    updatedAt,
  };
}

/**
 * Recompute + persist (called by the engine every ~60 ticks).
 * v8.4 R3/R6: while the freeze is ON, weights are NOT rewritten — the state is
 * recomputed over EPOCH-2 rows for DISPLAY only, and the audit line reports the
 * freeze. When the epoch-2 book reaches minN settled samples the freeze
 * auto-lifts (R6 evidence gate) and normal profit-first calibration resumes.
 */
export async function refreshCalibration(): Promise<{ state: CalibrationState; auditLine: string | null }> {
  const freeze = await ensureCalibrationFrozen();
  const epoch2Settled = (await db.signal.count({ where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, tags: { contains: "EPOCH-2" } } }));
  if (freeze.frozen && epoch2Settled < freeze.minN) {
    const state = await computeCalibration(true); // display-only
    // v8.4.1 G3 (operator mandate): surface the freeze honestly — the card must
    // not read "OBSERVING 28/30" while weights are locked with a n≥100 lift bar.
    state.status = "FROZEN";
    state.settled = epoch2Settled;
    state.target = freeze.minN;
    await db.engineSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) },
      update: { key: KEY, value: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) },
    });
    return {
      state,
      auditLine:
        tickFreezeLine++ % 10 === 0
          ? `CALIBRATION FROZEN (R3/R6): weights locked at epoch-2 recalibration (${freeze.frozenSettled} settled) — no movement until n≥${freeze.minN} (now ${epoch2Settled}). Learned/advisor weight writes are ignored while frozen.`
          : null,
    };
  }
  if (freeze.frozen && epoch2Settled >= freeze.minN) {
    // ── v10.16 R6 QUALITY GATE — the n-count alone must not unfreeze. The lift
    // re-fits weights on the ledger; when the RAW-CAL sample quality is AMBER/RED
    // (censored book), the re-fit would learn from censoring, not edge. Require
    // gate GREEN OR blended informative ≥ 50% IN ADDITION to the n-bar.
    // Fail-closed: if the quality digest is unavailable, the freeze HOLDS
    // (an unverifiable book is not a healthy book).
    let quality: RawcalQualityDigest | null = null;
    try {
      quality = await computeRawcalQuality(); // 30s-memoized, cheap at this cadence (~3.5min)
    } catch {
      quality = null;
    }
    const qStatus = quality?.gate.verdict ?? "UNAVAILABLE";
    const qInformative = quality?.informativePct ?? null;
    const qualityOk = quality !== null && (quality.gate.verdict === "GREEN" || (quality.informativePct ?? -1) >= R6_INFORMATIVE_FLOOR);
    if (!qualityOk) {
      const blocked = { at: new Date().toISOString(), informativePct: qInformative, status: qStatus, epoch2Settled };
      await db.engineSetting
        .upsert({ where: { key: R6_LIFT_BLOCKED_KEY }, create: { key: R6_LIFT_BLOCKED_KEY, value: JSON.stringify(blocked) }, update: { value: JSON.stringify(blocked) } })
        .catch(() => undefined);
      const state = await computeCalibration(true); // display-only — weights stay frozen
      state.status = "FROZEN";
      state.settled = epoch2Settled;
      state.target = freeze.minN;
      await db.engineSetting.upsert({
        where: { key: KEY },
        create: { key: KEY, value: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) },
        update: { key: KEY, value: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) },
      });
      if (r6BlockWarn++ % 10 === 0) {
        console.warn(`[calibration] R6 lift BLOCKED by rawcal quality gate — status ${qStatus}, informative ${qInformative ?? "n/a"}% (need GREEN or ≥${R6_INFORMATIVE_FLOOR}%), epoch2Settled ${epoch2Settled} ≥ n-bar ${freeze.minN}. Weights stay frozen — no re-fit on a censored book (v10.16).`);
      }
      return {
        state,
        auditLine:
          tickFreezeLine++ % 10 === 0
            ? `CALIBRATION STILL FROZEN (R3/R6 + v10.16 quality gate): n-bar reached (${epoch2Settled} ≥ ${freeze.minN}) but rawcal sample gate ${qStatus} (blended informative ${qInformative ?? "n/a"}% < ${R6_INFORMATIVE_FLOOR}% or not GREEN) — no weight re-fit on a censored book until the gate co-approves.`
            : null,
      };
    }
    await writeFreeze({ ...freeze, frozen: false, reason: `${freeze.reason} → R6 LIFT: epoch-2 book reached n=${epoch2Settled} ≥ ${freeze.minN} with rawcal quality co-approval (gate ${qStatus}, informative ${qInformative}%) — calibration unfrozen` });
    const state = await computeCalibration();
    await db.engineSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) },
      update: { key: KEY, value: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) },
    });
    return {
      state,
      auditLine: `R6 CALIBRATION LIFT: epoch-2 book reached n=${epoch2Settled} ≥ ${freeze.minN} — profit-first weight calibration RESUMES (was frozen since ${freeze.frozenAt}).`,
    };
  }
  const state = await computeCalibration();
  await db.engineSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) },
    update: { key: KEY, value: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) },
  });
  const auditLine =
    state.status === "ACTIVE" && state.rows.length > 0
      ? `AI CALIBRATION (net-PNL criterion): weights from ${state.settled} settled — ${state.rows.map((r) => `${r.factor} ×${r.weight.toFixed(2)} (exp ${r.expectancy >= 0 ? "+" : ""}${r.expectancy}%/trade, PF ${r.profitFactor}, n=${r.n})`).join(" · ")}`
      : null;
  return { state, auditLine };
}

let tickFreezeLine = 0; // rate-limit the frozen audit line inside the 60-tick calibration hook
let r6BlockWarn = 0; // v10.16 — rate-limit the quality-blocked console.warn (~1 line / 35min at the 60-tick cadence)

/** Cached read for hot paths (deploy scan). Falls back to compute on miss. */
let hot: { at: number; state: CalibrationState } | null = null;
export async function getCalibration(): Promise<CalibrationState> {
  if (hot && Date.now() - hot.at < 60_000) return hot.state;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    if (row) {
      const state = JSON.parse(row.value) as CalibrationState;
      hot = { at: Date.now(), state };
      return state;
    }
  } catch {
    /* ignore */
  }
  const state = await computeCalibration();
  hot = { at: Date.now(), state };
  return state;
}

/**
 * EFFECTIVE weights = live-outcome calibration × BACKTEST AUTO-TUNE adoption.
 * The learner (v5.0) may adopt swept factor weights when they genuinely beat
 * the baseline objective; those multiply on top of the realized-outcome
 * calibration and are re-clamped to [0.7, 1.3] for safety.
 */
export async function getEffectiveWeights(): Promise<{ weights: FactorWeights; source: "none" | "calibration" | "autotune" | "calibration×autotune" | "frozen" }> {
  const cal = await getCalibration();
  const weights: FactorWeights = { ...cal.weights };
  let source: "none" | "calibration" | "autotune" | "calibration×autotune" | "frozen" = Object.keys(weights).length ? "calibration" : "none";
  // v8.4 R6: while frozen, learned autotune adoption is ignored — the whole
  // point of the freeze is that n=35 evidence must not steer live scoring.
  if (source === "calibration" && (await readFreeze())?.frozen) {
    return { weights, source: "frozen" };
  }
  try {
    const row = await db.engineSetting.findUnique({ where: { key: "backtest.autotune" } });
    if (row) {
      const at = JSON.parse(row.value) as { adopted: boolean; adoptedWeights: Record<string, number> | null };
      if (at.adopted && at.adoptedWeights) {
        for (const [f, w] of Object.entries(at.adoptedWeights)) {
          const base = weights[f] ?? 1;
          weights[f] = Number(Math.min(1.3, Math.max(0.7, base * w)).toFixed(3));
        }
        source = Object.keys(cal.weights).length ? "calibration×autotune" : "autotune";
      }
    }
  } catch {
    /* ignore */
  }
  return { weights, source };
}
