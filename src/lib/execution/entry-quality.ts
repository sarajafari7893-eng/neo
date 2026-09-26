/**
 * NEXUS//SIGNALS — entry-quality research gate (LIVE-HARDENING Phase 6).
 *
 * An explicit layer SEPARATE from the signal score. The score says "the setup
 * is interesting"; this gate says "the ENTRY ITSELF is clean enough to act on".
 * Deterministic inputs, deterministic decision, machine-readable reasons.
 *
 * Required decision states: STRONG_PASS | GRAY_ZONE | STRONG_REJECT.
 *
 * GRAY_ZONE is a terminal research state, never an eligibility: the constant
 * GRAY_ZONE_BECOMES_LIVE_ELIGIBLE is `false` and no code path may flip it —
 * low deployment volume must never promote ambiguity (task rule).
 *
 * Tagging doctrine: thresholds below are HEURISTIC (research-informed, not yet
 * VALIDATED under Phase 7). They gate paper flow; they are NOT evidence.
 */

import type { EntryQualityDecision, RejectionReason } from "./types";

export const GRAY_ZONE_BECOMES_LIVE_ELIGIBLE = false as const;

export interface EntryQualityInput {
  /** how far price has traveled from the signal's reference, % */
  chasePct: number;
  /** entry-zone half width, % (overextension is relative to this) */
  entryZoneHalfPct: number;
  /** largest 1-minute impulse move into the entry, % */
  impulsePct1m: number;
  /** measured spread at decision time, bps */
  spreadBps: number;
  /** flow spike seen in exactly ONE snapshot (non-persistent) */
  oneShotFlowSpike: boolean;
  /** flow confirmation persisted across ≥N independent snapshots */
  persistentFlowConfirmation: boolean;
  /** seconds since the signal fired (late-entry detection) */
  ageSeconds: number;
}

export type EntryQualityAssessment =
  | { decision: "STRONG_PASS"; reasons: string[] }
  | { decision: "GRAY_ZONE"; reasons: string[] }
  | ({ decision: "STRONG_REJECT" } & RejectionReason);

/** HEURISTIC thresholds — research defaults, pending Phase 7 validation. */
export const HEURISTIC_THRESHOLDS = {
  maxChasePct: 0.6,
  chaseToZoneRatio: 2.0,
  maxImpulsePct1m: 0.8,
  maxSpreadBps: 12,
  minAgeSeconds: 0,
  maxAgeSeconds: 240,
} as const;

export function assessEntryQuality(input: EntryQualityInput): EntryQualityAssessment {
  const T = HEURISTIC_THRESHOLDS;
  const rejects: string[] = [];
  const grays: string[] = [];
  const passes: string[] = [];

  // late entry / overextension (relative to the zone)
  if (Math.abs(input.chasePct) > T.maxChasePct || Math.abs(input.chasePct) > T.chaseToZoneRatio * input.entryZoneHalfPct) {
    rejects.push(`OVEREXTENDED: chase ${input.chasePct.toFixed(2)}% exceeds limits (max ${T.maxChasePct}% or ${T.chaseToZoneRatio}× zone half ${input.entryZoneHalfPct.toFixed(2)}%)`);
  } else {
    passes.push(`chase ${input.chasePct.toFixed(2)}% within limits`);
  }

  // impulse exhaustion
  if (Math.abs(input.impulsePct1m) > T.maxImpulsePct1m) {
    if (input.oneShotFlowSpike && !input.persistentFlowConfirmation) {
      rejects.push(`IMPULSE_EXHAUSTION: 1m impulse ${input.impulsePct1m.toFixed(2)}% > ${T.maxImpulsePct1m}% with ONE-SHOT flow spike`);
    } else {
      grays.push(`IMPULSE_ELEVATED: 1m impulse ${input.impulsePct1m.toFixed(2)}% > ${T.maxImpulsePct1m}% (flow ${input.persistentFlowConfirmation ? "persistent" : "unclear"})`);
    }
  } else {
    passes.push(`1m impulse ${input.impulsePct1m.toFixed(2)}% acceptable`);
  }

  // execution quality
  if (input.spreadBps > T.maxSpreadBps) {
    rejects.push(`SPREAD_TOO_WIDE: ${input.spreadBps}bps > ${T.maxSpreadBps}bps`);
  } else {
    passes.push(`spread ${input.spreadBps}bps acceptable`);
  }

  // age
  if (input.ageSeconds < T.minAgeSeconds || input.ageSeconds > T.maxAgeSeconds) {
    grays.push(`AGE_OUT_OF_BAND: ${input.ageSeconds}s outside [${T.minAgeSeconds},${T.maxAgeSeconds}] — late-entry risk`);
  }

  // one-snapshot flow spike without persistence → never a PASS
  if (input.oneShotFlowSpike && !input.persistentFlowConfirmation) {
    grays.push("ONE_SHOT_FLOW_SPIKE: single-snapshot flow spike — persistence required");
  }

  if (rejects.length > 0) {
    return { decision: "STRONG_REJECT", code: "ENTRY_QUALITY_REJECT", detail: rejects.join(" · ") };
  }
  if (grays.length > 0) {
    return { decision: "GRAY_ZONE", reasons: grays };
  }
  return { decision: "STRONG_PASS", reasons: passes };
}
