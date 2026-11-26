// ── NEXUS//SIGNALS — EXECUTION STATE MACHINE (LIVE-HARDENING phase 4) ───────
// WHY: the master spec mandates an EXPLICIT order state machine with fail-
// closed semantics: unknown execution state prevents new entries, duplicate
// submission is prevented, restart cannot duplicate positions, and every
// transition is auditable. Today the paper ledger uses Signal.status strings
// (ACTIVE|TP1|TP2|TP3|SL|EXPIRED|CLOSED). This module formalizes the FULL
// lifecycle from the spec so that (a) paper deploys carry a journaled chain,
// and (b) any FUTURE real-money executor inherits the same law — the machine
// is pure, deterministic, and authority-free (no LLM, no strategy code can
// widen the legal edges).
//
// Fail-closed doctrine: an UNKNOWN state is never treated as a legal source
// or target; assertTransition() throws; reconcile functions classify unknown
// rows as QUARANTINED. Idempotency: executionKey() derives a deterministic
// per-(symbol,direction,bucket) key; the paper ledger's UNIQUE(serial) +
// P2002 retry remains the DB-level backstop (v10.16).

export type TradeExecState =
  | "SIGNAL"
  | "ELIGIBLE"
  | "RISK_APPROVED"
  | "ORDER_SUBMITTED"
  | "ACKNOWLEDGED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "PROTECTED"
  | "EXITING"
  | "CLOSED"
  | "RECONCILING"
  | "QUARANTINED"
  | "FAILED";

export const TRADE_EXEC_STATES: readonly TradeExecState[] = [
  "SIGNAL", "ELIGIBLE", "RISK_APPROVED", "ORDER_SUBMITTED", "ACKNOWLEDGED",
  "PARTIALLY_FILLED", "FILLED", "PROTECTED", "EXITING", "CLOSED",
  "RECONCILING", "QUARANTINED", "FAILED",
];

function isKnown(s: string): s is TradeExecState {
  return (TRADE_EXEC_STATES as readonly string[]).includes(s);
}

/** Legal edges — the ONLY transitions the system may take. Anything else is a
 * defect and must fail closed, not guess. */
const LEGAL_EDGES: Record<TradeExecState, readonly TradeExecState[]> = {
  SIGNAL: ["ELIGIBLE", "FAILED", "QUARANTINED"],
  ELIGIBLE: ["RISK_APPROVED", "QUARANTINED", "FAILED"],
  RISK_APPROVED: ["ORDER_SUBMITTED", "QUARANTINED", "FAILED"],
  ORDER_SUBMITTED: ["ACKNOWLEDGED", "FAILED", "QUARANTINED", "RECONCILING"],
  ACKNOWLEDGED: ["PARTIALLY_FILLED", "FILLED", "FAILED", "RECONCILING"],
  PARTIALLY_FILLED: ["FILLED", "EXITING", "RECONCILING", "FAILED"],
  FILLED: ["PROTECTED", "EXITING", "RECONCILING", "FAILED"],
  PROTECTED: ["EXITING", "RECONCILING", "QUARANTINED"], // lost protective exit ⇒ QUARANTINE
  EXITING: ["CLOSED", "RECONCILING", "FAILED"],
  CLOSED: [], // terminal
  RECONCILING: ["PROTECTED", "EXITING", "CLOSED", "QUARANTINED", "FAILED"],
  QUARANTINED: ["RECONCILING", "CLOSED"], // only reconciliation may leave quarantine
  FAILED: ["RECONCILING"], // post-mortem path only
};

export function canTransition(from: string, to: string): boolean {
  if (!isKnown(from) || !isKnown(to)) return false; // unknown ⇒ fail-closed
  return (LEGAL_EDGES[from] as readonly string[]).includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`EXEC-SM illegal transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: string, to: string): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** Paper ledger (Signal.status) ↔ exec-state projection. The paper deploy
 * path is atomic (entry + SL + TP3 ladder set at create) so its create chain
 * is SIGNAL→ELIGIBLE→RISK_APPROVED→ORDER_SUBMITTED→ACKNOWLEDGED→FILLED→PROTECTED. */
export const PAPER_STATUS_MAP: Record<string, TradeExecState> = {
  ACTIVE: "PROTECTED", // entry + protective ladder exist from birth
  TP1: "EXITING", // tranche banking in progress
  TP2: "EXITING",
  TP3: "EXITING",
  SL: "CLOSED",
  EXPIRED: "CLOSED",
  CLOSED: "CLOSED",
};

export function projectPaperStatus(status: string): TradeExecState | "QUARANTINED" {
  const m = PAPER_STATUS_MAP[status];
  return m ?? "QUARANTINED"; // unknown ledger status ⇒ quarantine, never guess
}

/** Deterministic idempotency key for an intended order (phase 4 acceptance:
 * duplicate submission is prevented). Two submissions with the same key in
 * the same window are the SAME intent. */
export function executionKey(symbol: string, direction: "LONG" | "SHORT", refPrice: number, bucketMs = 60_000): string {
  const bucket = Math.floor(Date.now() / bucketMs);
  return `${symbol}:${direction}:${bucket}:${Math.round(refPrice * 100)}`;
}

export interface EntryPreconditions {
  feedFresh: boolean; // feed-fresh guard passed
  execStateKnown: boolean; // current exec state is a known enum value
  protectiveExitPresent: boolean; // SL/TP ladder defined
  clockSkewMs: number; // |local − reference| clock drift
  maxClockSkewMs: number;
  reconciliationClean: boolean; // startup reconciliation found no mismatch
}

/** Fail-closed entry gate — EVERY precondition must be provably true. */
export function evaluateEntryAllowed(p: EntryPreconditions): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!p.feedFresh) reasons.push("feed not fresh (stale data fail-closed)");
  if (!p.execStateKnown) reasons.push("execution state UNKNOWN (fail-closed)");
  if (!p.protectiveExitPresent) reasons.push("no protective exit state (position would be unprotected)");
  if (!Number.isFinite(p.clockSkewMs) || Math.abs(p.clockSkewMs) > p.maxClockSkewMs) reasons.push(`clock skew ${p.clockSkewMs}ms > ${p.maxClockSkewMs}ms`);
  if (!p.reconciliationClean) reasons.push("startup reconciliation mismatch unresolved");
  return { allowed: reasons.length === 0, reasons };
}

export interface PaperOpenRow {
  serial: number;
  symbol: string;
  status: string;
  stopLoss: number | null;
  tp3: number | null;
  qualityFlag: string | null;
}

export type ReconcileAction = "OK" | "QUARANTINE" | "CLOSE";

export interface ReconcileRow { serial: number; symbol: string; action: ReconcileAction; why: string }

/** Deterministic reconciliation over open paper rows (phase 4: startup
 * reconciliation + orphaned-state checks). Pure — the caller applies actions
 * and journals them. */
export function reconcilePaperOpen(rows: PaperOpenRow[]): { rows: ReconcileRow[]; clean: boolean } {
  const out: ReconcileRow[] = [];
  for (const r of rows) {
    const known = ["ACTIVE", "TP1", "TP2", "TP3"].includes(r.status);
    if (!known) { out.push({ serial: r.serial, symbol: r.symbol, action: "QUARANTINE", why: `unknown open status '${r.status}'` }); continue; }
    if (r.stopLoss === null || !Number.isFinite(r.stopLoss) || r.stopLoss <= 0) { out.push({ serial: r.serial, symbol: r.symbol, action: "QUARANTINE", why: "open row without finite stopLoss (no protective exit)" }); continue; }
    if (r.tp3 === null || !Number.isFinite(r.tp3) || r.tp3 <= 0) { out.push({ serial: r.serial, symbol: r.symbol, action: "QUARANTINE", why: "open row without finite tp3 rung" }); continue; }
    if (r.qualityFlag && r.qualityFlag.startsWith("INVERTED_STOP")) { out.push({ serial: r.serial, symbol: r.symbol, action: "QUARANTINE", why: `ledger integrity flag ${r.qualityFlag}` }); continue; }
    out.push({ serial: r.serial, symbol: r.symbol, action: "OK", why: "" });
  }
  return { rows: out, clean: out.every((x) => x.action === "OK") };
}

/** The journaled deploy-time chain for a paper deploy (one audit line). */
export const PAPER_DEPLOY_CHAIN = "SIGNAL→ELIGIBLE→RISK_APPROVED→ORDER_SUBMITTED→ACKNOWLEDGED→FILLED→PROTECTED" as const;
