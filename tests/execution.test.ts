/**
 * LIVE-HARDENING Phase 12 — execution state machine tests.
 * Run: bun test tests/execution.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  ALLOWED_TRANSITIONS,
  OrderBook,
  clientOrderId,
  entryGate,
  isPositionHealthy,
  promoteToRiskApproved,
  transition,
} from "../src/lib/execution/state-machine";
import { EXECUTION_STATES } from "../src/lib/execution/types";

describe("state machine — deterministic table", () => {
  test("happy path SIGNAL→…→CLOSED is legal", () => {
    const path = ["SIGNAL", "ELIGIBLE", "RISK_APPROVED", "ORDER_SUBMITTED", "ACKNOWLEDGED", "FILLED", "PROTECTED", "EXITING", "CLOSED"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      const r = transition(path[i], path[i + 1]);
      expect(r.ok).toBe(true);
    }
  });

  test("partial fills path legal, including self-loop", () => {
    expect(transition("ACKNOWLEDGED", "PARTIALLY_FILLED").ok).toBe(true);
    expect(transition("PARTIALLY_FILLED", "PARTIALLY_FILLED").ok).toBe(true);
    expect(transition("PARTIALLY_FILLED", "FILLED").ok).toBe(true);
    expect(transition("PARTIALLY_FILLED", "EXITING").ok).toBe(true);
  });

  test("illegal jumps are rejected with machine-readable code", () => {
    const r = transition("SIGNAL", "ORDER_SUBMITTED");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ILLEGAL_TRANSITION");
  });

  test("terminal states cannot leave", () => {
    expect(transition("CLOSED", "SIGNAL").ok).toBe(false);
    expect(transition("FAILED", "SIGNAL").ok).toBe(false);
  });

  test("UNKNOWN state fails closed", () => {
    // @ts-expect-error — deliberately unknown state at runtime (corrupt persistence)
    const r = transition("GARBAGE", "ELIGIBLE");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_STATE");
  });

  test("every listed state has a table entry (13 states, task-required)", () => {
    expect(EXECUTION_STATES.length).toBe(13);
    for (const s of EXECUTION_STATES) expect(ALLOWED_TRANSITIONS[s]).toBeDefined();
  });
});

describe("position health & entry gate — fail closed", () => {
  test("position healthy ONLY when PROTECTED", () => {
    for (const s of EXECUTION_STATES) expect(isPositionHealthy(s)).toBe(s === "PROTECTED");
  });

  test("entry gate blocks on every fail-closed condition", () => {
    const base = { killSwitchEngaged: false, unresolvedOpenStates: [], startupReconciled: true, dataFresh: true, exchangeConnected: true };
    expect(entryGate(base).ok).toBe(true);
    expect(entryGate({ ...base, killSwitchEngaged: true }).ok).toBe(false);
    expect(entryGate({ ...base, unresolvedOpenStates: ["ORDER_SUBMITTED"] }).ok).toBe(false);
    expect(entryGate({ ...base, startupReconciled: false }).ok).toBe(false);
    expect(entryGate({ ...base, dataFresh: false }).ok).toBe(false);
    expect(entryGate({ ...base, exchangeConnected: false }).ok).toBe(false);
  });

  test("gate rejections carry deterministic reason codes", () => {
    const r = entryGate({ killSwitchEngaged: true, unresolvedOpenStates: [], startupReconciled: true, dataFresh: true, exchangeConnected: true });
    if (!r.ok) expect(r.code).toBe("KILL_SWITCH");
  });
});

describe("idempotent submission", () => {
  test("same clientOrderId returns the SAME record — no duplicate", () => {
    const book = new OrderBook();
    const a = book.getOrSubmit("sig-1", 0);
    expect(a.created).toBe(true);
    const b = book.getOrSubmit("sig-1", 0);
    expect(b.created).toBe(false);
    expect(b.record.clientOrderId).toBe(a.record.clientOrderId);
    expect(clientOrderId("sig-1", 0)).toBe(b.record.clientOrderId);
  });

  test("different attempt → different key (bounded retry)", () => {
    expect(clientOrderId("sig-1", 0)).not.toBe(clientOrderId("sig-1", 1));
  });

  test("restart cannot create duplicate positions: open states force reconciliation", () => {
    const book = new OrderBook();
    const { record } = book.getOrSubmit("sig-9", 0);
    book.advance(record, "ELIGIBLE");
    book.advance(record, "RISK_APPROVED");
    book.advance(record, "ORDER_SUBMITTED");
    const open = book.allOpen();
    expect(open.length).toBe(1);
    const gate = entryGate({ killSwitchEngaged: false, unresolvedOpenStates: open.map((o) => o.state), startupReconciled: true, dataFresh: true, exchangeConnected: true });
    expect(gate.ok).toBe(false); // a "restarted" book with open state blocks new entries
  });
});

describe("risk-engine is non-bypassable at the transition", () => {
  test("ELIGIBLE→RISK_APPROVED blocked without approval", () => {
    const r = promoteToRiskApproved("ELIGIBLE", { approved: false, reasonCode: "DAILY_LOSS_STOP", detail: "halted" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DAILY_LOSS_STOP");
  });

  test("approval advances, and further path stays table-bound", () => {
    const r = promoteToRiskApproved("ELIGIBLE", { approved: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.to).toBe("RISK_APPROVED");
    expect(transition("RISK_APPROVED", "ORDER_SUBMITTED").ok).toBe(true);
    // but SIGNAL can never jump to RISK_APPROVED even with approval
    expect(promoteToRiskApproved("SIGNAL", { approved: true }).ok).toBe(false);
  });
});
