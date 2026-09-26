/**
 * NEXUS//SIGNALS — parameter governance (LIVE-HARDENING Phase 8).
 *
 * Separates parameter PROPOSAL from parameter ADOPTION. Every candidate
 * parameter set walks a fixed lifecycle; every transition records who/why/
 * evidence; promotion requires frozen production config AND minimum sample
 * sizes; there is NO code path by which an LLM output reaches `PROMOTED` —
 * this module is only importable from operator/CI surfaces, never from
 * ai.ts / research adapters (structural isolation, verified by test).
 *
 * Lifecycle: PROPOSED → BACKTESTED → OOS_VALIDATED → CANARY_ELIGIBLE → PROMOTED
 * Exits: ROLLED_BACK (from PROMOTED/CANARY_ELIGIBLE), QUARANTINED (from any non-terminal).
 */

import type { ParamGovernanceState } from "./types";

export const PARAM_TRANSITIONS: Record<ParamGovernanceState, ParamGovernanceState[]> = {
  PROPOSED: ["BACKTESTED", "QUARANTINED"],
  BACKTESTED: ["OOS_VALIDATED", "QUARANTINED"],
  OOS_VALIDATED: ["CANARY_ELIGIBLE", "QUARANTINED"],
  CANARY_ELIGIBLE: ["PROMOTED", "ROLLED_BACK", "QUARANTINED"],
  PROMOTED: ["ROLLED_BACK"],
  ROLLED_BACK: [],
  QUARANTINED: [],
};

export interface ParamVersion {
  id: string;
  state: ParamGovernanceState;
  createdAt: string;
  /** sha256 of the exact parameter JSON (freezing = hash-pinning) */
  paramsHash: string;
  params: Record<string, number>;
  dataWindow: { from: string; to: string };
  objective: string;
  sampleSize: { train: number; oos: number; perStrategy: Record<string, number> };
  evaluator: "human-operator" | "ci-pipeline"; // LLM is NOT a legal evaluator
  evidenceRefs: string[];
  history: { at: string; from: ParamGovernanceState | "NEW"; to: ParamGovernanceState; by: string; note: string }[];
}

export type ParamResult = { ok: true; version: ParamVersion } | { ok: false; code: string; detail: string };

export function transitionParam(
  v: ParamVersion,
  to: ParamGovernanceState,
  by: string,
  note: string,
  opts: { productionFrozen?: boolean; minOosPerStrategy?: number } = {},
): ParamResult {
  const allowed = PARAM_TRANSITIONS[v.state];
  if (!allowed) return { ok: false, code: "UNKNOWN_PARAM_STATE", detail: `state ${String(v.state)} unknown — fail closed` };
  if (!allowed.includes(to)) {
    return { ok: false, code: "ILLEGAL_PARAM_TRANSITION", detail: `${v.state} → ${to} not permitted (allowed: ${allowed.join(", ") || "terminal"})` };
  }
  if (by.startsWith("llm") || by.includes("ai")) {
    return { ok: false, code: "LLM_ADOPTION_FORBIDDEN", detail: "LLM output can never adopt parameters (Phase 9 invariant)" };
  }

  // promotion gates
  if (to === "CANARY_ELIGIBLE") {
    if (opts.productionFrozen === false) {
      return { ok: false, code: "PRODUCTION_NOT_FROZEN", detail: "production configuration must be frozen during validation" };
    }
    const minOos = opts.minOosPerStrategy ?? 60;
    const weak = Object.entries(v.sampleSize.perStrategy).filter(([, n]) => n < minOos);
    if (v.sampleSize.oos < 300) {
      return { ok: false, code: "OOS_SAMPLE_TOO_SMALL", detail: `total OOS ${v.sampleSize.oos} < 300` };
    }
    if (weak.length > 0) {
      return { ok: false, code: "PER_STRATEGY_SAMPLE_TOO_SMALL", detail: weak.map(([s, n]) => `${s}:${n}`).join(",") };
    }
    if (v.evidenceRefs.length === 0) {
      return { ok: false, code: "NO_EVIDENCE_REFS", detail: "promotion requires evidence references" };
    }
  }

  v.state = to;
  v.history.push({ at: new Date().toISOString(), from: v.state, to, by, note });
  return { ok: true, version: v };
}

/** Rollback to last known-good: operator flips PROMOTED → ROLLED_BACK and re-pins the previous hash. */
export function rollbackToKnownGood(current: ParamVersion, knownGoodHash: string, by: string, note: string): ParamResult {
  const r = transitionParam(current, "ROLLED_BACK", by, note);
  if (r.ok && current.paramsHash !== knownGoodHash) {
    r.version.history.push({ at: new Date().toISOString(), from: "ROLLED_BACK", to: "ROLLED_BACK", by, note: `re-pinned to known-good ${knownGoodHash.slice(0, 12)}…` });
  }
  return r;
}
