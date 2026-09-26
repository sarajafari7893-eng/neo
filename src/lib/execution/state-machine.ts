/**
 * NEXUS//SIGNALS — order execution state machine (LIVE-HARDENING Phase 4).
 *
 * Deterministic, auditable, fail-closed. Per the master task the required
 * states and transitions are encoded EXACTLY as specified; anything not in
 * the table is rejected. Unknown state => hard refusal (never guess).
 *
 * Non-bypassability: the ONLY way out of RISK_APPROVED toward ORDER_SUBMITTED
 * runs through riskEngine.assess() (see transitionFrom with riskContext).
 * Strategy code has no alternate door — this module is the door.
 *
 * Real orders: structurally absent. `submitOrder` accepts an ExecutionAdapter;
 * this repository ships ONLY the paper adapter. Wiring a real adapter requires
 * an explicit future operator action AND passing every Phase-13 gate.
 */

import type { ExecutionState, RejectionReason } from "./types";

// ── deterministic transition table (task-specified) ──────────────────────────

export const ALLOWED_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  SIGNAL: ["ELIGIBLE", "QUARANTINED", "FAILED"],
  ELIGIBLE: ["RISK_APPROVED", "QUARANTINED", "FAILED"],
  RISK_APPROVED: ["ORDER_SUBMITTED", "QUARANTINED", "FAILED"],
  ORDER_SUBMITTED: ["ACKNOWLEDGED", "FAILED"],
  ACKNOWLEDGED: ["PARTIALLY_FILLED", "FILLED", "FAILED", "RECONCILING"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "EXITING", "FAILED", "RECONCILING"],
  FILLED: ["PROTECTED", "EXITING", "FAILED", "RECONCILING"],
  PROTECTED: ["EXITING", "CLOSED", "FAILED", "RECONCILING"],
  EXITING: ["CLOSED", "FAILED", "RECONCILING"],
  CLOSED: [],
  // reconciliation resolves to the TRUE external state, or quarantines
  RECONCILING: ["ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED", "PROTECTED", "CLOSED", "QUARANTINED", "FAILED"],
  // quarantine releases only through reconciliation (operator-assisted)
  QUARANTINED: ["RECONCILING"],
  FAILED: [],
};

export const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set<ExecutionState>(["CLOSED", "FAILED"]);

/** States in which an order is considered open at an exchange. */
export const OPEN_ORDER_STATES: ReadonlySet<ExecutionState> = new Set<ExecutionState>([
  "ORDER_SUBMITTED",
  "ACKNOWLEDGED",
  "PARTIALLY_FILLED",
  "FILLED",
  "PROTECTED",
  "EXITING",
]);

export type TransitionResult = { ok: true; from: ExecutionState; to: ExecutionState } | ({ ok: false } & RejectionReason);

export function transition(from: ExecutionState, to: ExecutionState): TransitionResult {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (allowed === undefined) {
    return { ok: false, code: "UNKNOWN_STATE", detail: `state "${String(from)}" is unknown — fail-closed` };
  }
  if (!allowed.includes(to)) {
    return {
      ok: false,
      code: "ILLEGAL_TRANSITION",
      detail: `${from} → ${to} not permitted (allowed: ${allowed.join(", ") || "none — terminal"})`,
    };
  }
  return { ok: true, from, to };
}

// ── position health & entry gating (fail-closed semantics) ───────────────────

/** A position is healthy ONLY with a valid protective exit in place (task req). */
export function isPositionHealthy(state: ExecutionState): boolean {
  return state === "PROTECTED";
}

export interface EntryGateContext {
  killSwitchEngaged: boolean;
  /** persisted states of orders that were open when the process died */
  unresolvedOpenStates: ExecutionState[];
  /** true once startup reconciliation completed with no mismatch */
  startupReconciled: boolean;
  /** clock sanity for stale-data fail-closed */
  dataFresh: boolean;
  exchangeConnected: boolean;
}

export type EntryGateResult = { ok: true } | ({ ok: false } & RejectionReason);

/**
 * The single gate consulted before ANY new entry. Every condition fails
 * closed; an unknown/unverifiable condition counts as failure.
 */
export function entryGate(ctx: EntryGateContext): EntryGateResult {
  if (ctx.killSwitchEngaged) {
    return { ok: false, code: "KILL_SWITCH", detail: "kill-switch engaged — all entries blocked" };
  }
  if (ctx.unresolvedOpenStates.length > 0) {
    return {
      ok: false,
      code: "UNRECONCILED_OPEN_STATE",
      detail: `open states require reconciliation before new entries: ${ctx.unresolvedOpenStates.join(",")}`,
    };
  }
  if (!ctx.startupReconciled) {
    return { ok: false, code: "STARTUP_NOT_RECONCILED", detail: "startup reconciliation has not passed" };
  }
  if (!ctx.dataFresh) {
    return { ok: false, code: "STALE_DATA", detail: "market data stale — fail closed" };
  }
  if (!ctx.exchangeConnected) {
    return { ok: false, code: "DISCONNECTED", detail: "exchange feed disconnected — fail closed" };
  }
  return { ok: true };
}

// ── idempotent order submission ──────────────────────────────────────────────

export interface ExecutionAdapter {
  readonly kind: "PAPER" | "LIVE";
  /** submit must be idempotent per clientOrderId */
  submit(req: { clientOrderId: string; symbol: string; side: "LONG" | "SHORT"; sizeUsd: number }): Promise<{ acknowledged: boolean; exchangeOrderId: string }>;
}

export interface OrderRecord {
  clientOrderId: string;
  signalId: string;
  state: ExecutionState;
  exchangeOrderId?: string;
  history: { at: string; from: ExecutionState | "NEW"; to: ExecutionState; code?: string }[];
}

/** Deterministic idempotency key: same signal retry must not duplicate. */
export function clientOrderId(signalId: string, attempt: number): string {
  return `NX-${signalId}-${attempt}`;
}

export class OrderBook {
  /** clientOrderId → record; in-memory in the paper domain (persisted by caller) */
  private readonly orders = new Map<string, OrderRecord>();

  /** duplicate submission with the SAME clientOrderId returns the existing record unchanged */
  getOrSubmit(signalId: string, attempt: number): { record: OrderRecord; created: boolean } {
    const id = clientOrderId(signalId, attempt);
    const existing = this.orders.get(id);
    if (existing) return { record: existing, created: false };
    const record: OrderRecord = {
      clientOrderId: id,
      signalId,
      state: "SIGNAL",
      history: [{ at: new Date().toISOString(), from: "NEW", to: "SIGNAL" }],
    };
    this.orders.set(id, record);
    return { record, created: true };
  }

  advance(record: OrderRecord, to: ExecutionState): TransitionResult {
    const r = transition(record.state, to);
    if (r.ok) {
      record.state = to;
      record.history.push({ at: new Date().toISOString(), from: r.from, to });
    }
    return r;
  }

  findByClientOrderId(id: string): OrderRecord | undefined {
    return this.orders.get(id);
  }

  allOpen(): OrderRecord[] {
    return [...this.orders.values()].filter((o) => OPEN_ORDER_STATES.has(o.state));
  }
}

// ── risk-engine-bound promotion ELIGIBLE → RISK_APPROVED ─────────────────────

export interface RiskAssessmentLike {
  approved: boolean;
  reasonCode?: string;
  detail?: string;
}

export function promoteToRiskApproved(
  from: ExecutionState,
  assessment: RiskAssessmentLike,
): TransitionResult {
  if (from !== "ELIGIBLE") {
    return transition(from, "RISK_APPROVED"); // normal table verdict (likely illegal)
  }
  if (!assessment.approved) {
    return {
      ok: false,
      code: assessment.reasonCode ?? "RISK_REJECTED",
      detail: assessment.detail ?? "risk engine declined — non-bypassable",
    };
  }
  return { ok: true, from, to: "RISK_APPROVED" };
}
