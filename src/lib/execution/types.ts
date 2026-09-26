/**
 * NEXUS//SIGNALS — execution domain types (LIVE-HARDENING Phase 4/5/6/8/10).
 *
 * Hard invariants (non-negotiable, enforced structurally):
 *  · Real-money orders are DISABLED. The only ExecutionAdapter in this repo is
 *    the paper adapter. No exchange credential is read anywhere in this domain.
 *  · Unknown execution state fails closed — nothing advances, no new entries.
 *  · Strategy/research code cannot bypass the risk engine: the only path from
 *    ELIGIBLE to ORDER_SUBMITTED goes through riskEngine.assess().
 */

// ── Phase 4: order state machine ─────────────────────────────────────────────

export const EXECUTION_STATES = [
  "SIGNAL",
  "ELIGIBLE",
  "RISK_APPROVED",
  "ORDER_SUBMITTED",
  "ACKNOWLEDGED",
  "PARTIALLY_FILLED",
  "FILLED",
  "PROTECTED",
  "EXITING",
  "CLOSED",
  "RECONCILING",
  "QUARANTINED",
  "FAILED",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export type PnlClass = "MODELED_PNL" | "PAPER_PNL" | "REALIZED_PNL";

export type EntryQualityDecision = "STRONG_PASS" | "GRAY_ZONE" | "STRONG_REJECT";

export type ParamGovernanceState =
  | "PROPOSED"
  | "BACKTESTED"
  | "OOS_VALIDATED"
  | "CANARY_ELIGIBLE"
  | "PROMOTED"
  | "ROLLED_BACK"
  | "QUARANTINED";

/** Machine-readable reason for every deterministic rejection (observability req). */
export interface RejectionReason {
  code: string;
  detail: string;
}

export function isRejection(r: unknown): r is RejectionReason {
  return typeof r === "object" && r !== null && typeof (r as RejectionReason).code === "string";
}
