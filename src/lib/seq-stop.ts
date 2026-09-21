// ── FlowRadar Neo v10.11 SEQ-STOP — ALWAYS-VALID SEQUENTIAL EARLY DECISION ──
// SUPERVISOR proposal 2026-09-17 14:55Z, operator APPROVE via bridge 2026-09-17
// 17:50Z («پیشنهادات سوپروایزر رو کامل و مهندسی انجام بده + گزارشات»).
//
// WHY (SUPERVISOR audit 1455Z): the shadow-veto promotion gate waits for
// n=30 settled per real arm. Three measured problems with waiting:
//   (1) LATENCY — epoch fill pace ≈ 5.2 settles/day → the gate lands in
//       ~3.5 days; a decisive answer may exist much earlier.
//   (2) WINDOW FRAGILITY — the rolling-30 paper-keep cohort swung 13W/+$1.48
//       → 8W/−$10.32 (−$11.8) inside 4h: a decision taken exactly at fill
//       samples one arbitrary slice of a moving window anyway.
//   (3) SELECTION BIAS — the paper-veto arm is structurally 0/30 in shadow
//       mode (it can only fill once veto authority exists), so "wait for all
//       arms" silently means "decide with the counterfactual arm missing".
// SEQ-STOP adds a SEQUENTIAL STOPPING RULE on top of the fixed-n gate: the
// evaluation may stop EARLY (PROMOTE-EARLY / ABORT-EARLY) the moment the
// evidence crosses an always-valid boundary, with the type-I error spent
// across looks by an O'Brien-Fleming spending function (conservative early,
// full α only at t=1). Waiting for n=30 remains the fallback path — the
// fixed gate is UNCHANGED; the sequential rule only ADDS an earlier,
// statistically disciplined exit.
//
// STATISTIC: two-proportion z on the REAL arms,
//   d̂ = p_keep − p_veto   (positive ⇒ the would-veto cohort performs WORSE
//   than the would-keep cohort ⇒ blocking those trades adds value),
//   SE = sqrt( p̄(1−p̄)(1/n_keep + 1/n_veto) )   (pooled; H0: p_keep = p_veto),
//   z = d̂ / SE,  information fraction t = (n_keep + n_veto) / (2·PLANNED_MAX_N).
// BOUNDARY (O'Brien-Fleming spending, two-sided, α = 0.05):
//   c(t) = z_{α/2} / √t ;   α_spent(t) = 2 − 2Φ(c(t))
//   → |z| ≥ c(t) stops the trial in the direction of the sign of z.
//   PROMOTE-EARLY: z ≥ +c(t) AND would-veto net < 0 (economic concordance,
//     mirrors the fixed gate's "net must be negative" criterion).
//   ABORT-EARLY:   z ≤ −c(t) AND would-veto net > 0 (the veto instinct is
//     measurably counterproductive → refresh/retire, never promote).
//   CONTINUE: otherwise.
// GUARDRAILS: no stop before MIN_ARM_N=12 settled per arm (sub-significant
// mini-windows must not end a 60-trade trial); SE floor to reject degenerate
// p̄∈{0,1}; fail-CONTINUE on any malformed input (this module must never
// throw into the promotion path).
//
// Validation (2026-09-17, independent numerical mirror): t=0.4 → c=3.099,
// α=0.00194 · t=0.5 → c=2.772 · t=2/3 → c=2.400 · t=1.0 → c=1.960, α=0.05.

export type SeqStopState = "CONTINUE" | "PROMOTE-EARLY" | "ABORT-EARLY";

export interface SeqStopArms {
  wins: number;
  n: number;
  netUsd: number;
}

export interface SeqStopResult {
  state: SeqStopState;
  z: number | null; // signed statistic; + = veto cohort worse (promote side)
  boundary: number | null; // OF boundary c(t) at the current look
  infoFrac: number | null; // t = (nK + nV) / (2 · PLANNED_MAX_N)
  alphaSpent: number | null; // α_spent(t) — two-sided O'Brien-Fleming
  dPct: number | null; // d̂ in percentage points (keep − veto)
  minNMet: boolean; // both arms ≥ MIN_ARM_N
  detail: string; // human-readable, journal/API-ready
  checkedAt: number;
}

export const SEQ_STOP = {
  MIN_ARM_N: 12, // per-arm settled floor before any early stop (proposal: n≥12)
  PLANNED_MAX_N: 30, // per-arm planned max information (the fixed gate's n=30)
  ALPHA: 0.05, // two-sided total error budget
} as const;

const Z_ALPHA_2 = 1.959963984540054; // z_{0.025} two-sided 95%

/** Abramowitz-Stegun 7.1.26 erf (|ε| ≤ 1.5e-7) — no external deps. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
}

function phi(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** O'Brien-Fleming boundary at information fraction t ∈ (0,1]. */
export function ofBoundary(t: number): number {
  const tc = Math.min(1, Math.max(1e-6, t));
  return Z_ALPHA_2 / Math.sqrt(tc);
}

/** α spent by the OF function at information fraction t (two-sided). */
export function ofAlphaSpent(t: number): number {
  return Math.max(0, Math.min(1, 2 * (1 - phi(ofBoundary(t)))));
}

/** The ONE evaluation entry-point — pure, fail-CONTINUE, never throws. */
export function seqStopEvaluate(keep: SeqStopArms, veto: SeqStopArms): SeqStopResult {
  const base: SeqStopResult = {
    state: "CONTINUE",
    z: null,
    boundary: null,
    infoFrac: null,
    alphaSpent: null,
    dPct: null,
    minNMet: false,
    detail: "",
    checkedAt: Date.now(),
  };
  try {
    const nK = Math.max(0, Math.floor(Number(keep?.n) || 0));
    const nV = Math.max(0, Math.floor(Number(veto?.n) || 0));
    const wK = Math.min(nK, Math.max(0, Math.floor(Number(keep?.wins) || 0)));
    const wV = Math.min(nV, Math.max(0, Math.floor(Number(veto?.wins) || 0)));
    const netV = Number(veto?.netUsd) || 0;
    const t = (nK + nV) / (2 * SEQ_STOP.PLANNED_MAX_N);
    const boundary = ofBoundary(t);
    const alphaSpent = ofAlphaSpent(t);
    const minNMet = nK >= SEQ_STOP.MIN_ARM_N && nV >= SEQ_STOP.MIN_ARM_N;
    const info: Pick<SeqStopResult, "boundary" | "infoFrac" | "alphaSpent" | "minNMet"> = {
      boundary,
      infoFrac: Number(Math.min(1, t).toFixed(3)),
      alphaSpent: Number(alphaSpent.toFixed(5)),
      minNMet,
    };
    if (nK < 2 || nV < 2) {
      return {
        ...base,
        ...info,
        detail: `seq-stop CONTINUE — cohorts still warming (keep ${nK}, veto ${nV}; no test before n≥2 per arm)`,
      };
    }
    const pK = wK / nK;
    const pV = wV / nV;
    const d = pK - pV; // + ⇒ veto cohort worse ⇒ promote side
    const pBar = (wK + wV) / (nK + nV);
    const se = Math.sqrt(pBar * (1 - pBar) * (1 / nK + 1 / nV));
    if (!Number.isFinite(se) || se < 1e-4) {
      return {
        ...base,
        ...info,
        dPct: Number((d * 100).toFixed(1)),
        detail: `seq-stop CONTINUE — degenerate pooled rate (p̄=${pBar.toFixed(3)}), statistic undefined`,
      };
    }
    const z = d / se;
    const dPct = Number((d * 100).toFixed(1));
    if (!minNMet) {
      return {
        ...base,
        ...info,
        z: Number(z.toFixed(3)),
        dPct,
        detail: `seq-stop CONTINUE — z=${z.toFixed(2)} vs c(t)=${boundary.toFixed(2)} at t=${Math.min(1, t).toFixed(2)}, but min-n guard active (need ≥${SEQ_STOP.MIN_ARM_N} per arm; have keep ${nK}, veto ${nV})`,
      };
    }
    if (z >= boundary) {
      if (netV < 0) {
        return {
          ...base,
          ...info,
          state: "PROMOTE-EARLY",
          z: Number(z.toFixed(3)),
          dPct,
          detail: `seq-stop PROMOTE-EARLY (always-valid, OF α=${alphaSpent.toFixed(4)} at t=${Math.min(1, t).toFixed(2)}): would-veto cohort WR is ${Math.abs(dPct).toFixed(1)}pp BELOW would-keep (z=${z.toFixed(2)} ≥ c=${boundary.toFixed(2)}) with net $${netV.toFixed(2)} < 0 — blocking those trades adds measured value; early decision justified`,
        };
      }
      return {
        ...base,
        ...info,
        z: Number(z.toFixed(3)),
        dPct,
        detail: `seq-stop CONTINUE — WR boundary crossed (${z.toFixed(2)} ≥ ${boundary.toFixed(2)}) but economic guard fails (would-veto net $${netV.toFixed(2)} ≥ 0): rate separation without concordant PnL is not promotion evidence`,
      };
    }
    if (z <= -boundary) {
      if (netV > 0) {
        return {
          ...base,
          ...info,
          state: "ABORT-EARLY",
          z: Number(z.toFixed(3)),
          dPct,
          detail: `seq-stop ABORT-EARLY (always-valid, OF α=${alphaSpent.toFixed(4)} at t=${Math.min(1, t).toFixed(2)}): would-veto cohort WR is ${dPct.toFixed(1)}pp ABOVE would-keep (z=${z.toFixed(2)} ≤ −c=${(-boundary).toFixed(2)}) with net $${netV.toFixed(2)} > 0 — the veto instinct is counterproductive; recommend epoch refresh / adjudicator re-tune, never promote this evidence`,
        };
      }
      return {
        ...base,
        ...info,
        z: Number(z.toFixed(3)),
        dPct,
        detail: `seq-stop CONTINUE — abort-side boundary touched (${z.toFixed(2)} ≤ ${(-boundary).toFixed(2)}) but economic guard fails (would-veto net $${netV.toFixed(2)} ≤ 0): mixed signal, keep collecting`,
      };
    }
    return {
      ...base,
      ...info,
      z: Number(z.toFixed(3)),
      dPct,
      detail: `seq-stop CONTINUE — z=${z.toFixed(2)} inside (−${boundary.toFixed(2)}, +${boundary.toFixed(2)}) at t=${Math.min(1, t).toFixed(2)} (α spent ${alphaSpent.toFixed(4)}); keep=${nK}, veto=${nV} settled`,
    };
  } catch (e) {
    return { ...base, detail: `seq-stop CONTINUE — evaluation error suppressed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
