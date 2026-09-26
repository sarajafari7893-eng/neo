# EXECUTION-STATE-MACHINE.md — NEXUS//SIGNALS
**Task:** NEXUS-LIVE-HARDENING-MASTER-v1.0 · Phase 4 deliverable
**Implementation:** `src/lib/execution/state-machine.ts` (+ `types.ts`, `kill-switch.ts`, `risk-engine.ts`) — real, tested code (42/42), not prose-only.

---

## 1. State machine (exactly the 13 task-required states)

```
SIGNAL → ELIGIBLE → RISK_APPROVED → ORDER_SUBMITTED → ACKNOWLEDGED
      → PARTIALLY_FILLED → FILLED → PROTECTED → EXITING → CLOSED
Bypass/terminal: RECONCILING · QUARANTINED · FAILED
```

- Full transition table: `ALLOWED_TRANSITIONS` (state-machine.ts) — anything not listed is **rejected with a machine-readable code** (`ILLEGAL_TRANSITION`, `UNKNOWN_STATE`).
- Terminal: `CLOSED`, `FAILED` (no exits; post-mortem only).
- `RECONCILING` resolves to the true external state or `QUARANTINED`; `QUARANTINED` releases only through `RECONCILING` (operator-assisted).
- Every accepted transition appends to `order.history` (at/from/to) — **observable + auditable** (observability req §engineering).

## 2. Fail-closed semantics (all unit-tested)

`entryGate(ctx)` — the ONLY door to a new entry; blocks on:
| Condition | Code |
|---|---|
| kill-switch engaged | `KILL_SWITCH` |
| unresolved open states (restart with open orders) | `UNRECONCILED_OPEN_STATE` |
| startup reconciliation not passed | `STARTUP_NOT_RECONCILED` |
| stale market data | `STALE_DATA` |
| exchange/feed disconnected | `DISCONNECTED` |
| **any unknown state value** | `UNKNOWN_STATE` (transition table) |

**Position health** = `PROTECTED` only (a valid protective exit exists). `FILLED` without `PROTECTED` is explicitly unhealthy — the machine forces the `FILLED → PROTECTED` step.

## 3. Idempotency & restart safety

- `clientOrderId = NX-${signalId}-${attempt}` — deterministic per signal/attempt.
- `OrderBook.getOrSubmit` returns the SAME record for a repeated id (`created:false`) — duplicate submission structurally impossible (tested).
- Restart: persisted open states force `UNRECONCILED_OPEN_STATE` block until reconciliation passes — restart cannot silently duplicate positions (tested: book with `ORDER_SUBMITTED` open blocks the gate).

## 4. Non-bypassable risk gate (Phase 10 coupling)

`ELIGIBLE → RISK_APPROVED` is the ONLY transition gated on `riskEngine.assess()`:
- `promoteToRiskApproved("ELIGIBLE", assessment)` refuses when `assessment.approved === false` (deterministic reason surfaces, e.g. `DAILY_LOSS_STOP`);
- refusal is impossible to route around — strategy code has no other transition into `RISK_APPROVED` (table-encoded; tested).
Risk engine limits are clamp-locked (`clampLimits`): per-trade 0.10–0.25% equity, daily stop 0.5–1.5% (default 1.0), weekly 1.5–3.0% (default 2.5), aggregate 0.75%, per-symbol 0.40%, correlated-group 0.60% — sizing from invalidation distance, never leverage preference.

## 5. Independent kill-switch (`kill-switch.ts`)

- Dedicated flag file `.data/execution/kill-switch.json` (outside engine ownership) + `engage/release` API.
- **Fail-closed:** unreadable/corrupt file ⇒ treated ENGAGED with `degraded:true` (tested).
- Watchdog/operator can engage even if the engine is wedged — the gate consults the file, not engine memory.

## 6. Real orders remain structurally absent

`ExecutionAdapter.kind: "PAPER" | "LIVE"` — this repository ships **no** LIVE adapter, reads **no** exchange credentials, and signs **nothing**. Creating one requires: every Phase-13 gate PASS + explicit operator action + a code review introducing HMAC signing (currently nonexistent). This is the enforced default, not a promise.

## 7. Integration status (honest)

- The machine, kill-switch, risk engine, idempotency and gates are **implemented and tested** as an independent domain (`src/lib/execution/`, 42/42 green).
- The live paper engine (`engine.ts`) predates this domain and runs its own suppression logic (`auto-deployment SUPPRESSED`). Wiring `entryGate` into the engine's deploy path is the single highest-value next action (see LIVE-READINESS remaining_blockers) — deliberately NOT done mid-session to avoid untested changes to a live 2,100-line engine (change_control).

**Phase-4 acceptance self-check:** duplicate submission prevented ✅ (tested) · restart cannot duplicate positions ✅ (tested) · deterministic reconciliation path ✅ (`RECONCILING` semantics; exchange-side N/A until adapter exists) · unknown state fails closed ✅ (tested).
