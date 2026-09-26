# LIVE-READINESS.md — NEXUS//SIGNALS
**Task:** NEXUS-LIVE-HARDENING-MASTER-v1.0 · Phase 13+14 deliverable
**Generated:** 2026-09-26 (Tehran) · **deployment_commit:** `see §machine block` · **evidence:** every gate below cites executed commands/files, not optimism.

---

## machine-readable readiness state (`nexus.live-readiness.v1`)

```json
{
  "schema": "nexus.live-readiness.v1",
  "generatedAt": "2026-09-26",
  "current_state": "NOT_ELIGIBLE",
  "deployment_commit": "HEAD of main @ push-armor remote (neo.git) — see git rev-parse HEAD at read time; last verified 46493ee-era",
  "schema_version": "prisma/migrations/20260926000000_init (baseline, zero drift)",
  "configuration_version": "git-pinned (NEXUS_CONTROL_KEY/NEXTAUTH_SECRET/GITHUB_TOKEN in .env, chmod 600, untracked, history-scrubbed)",
  "gates": {
    "security":                   "PASS",
    "database_integrity":         "PASS",
    "migration_integrity":        "PASS",
    "execution_reconciliation":   "DEGRADED",
    "real_pnl_ledger":            "PASS",
    "recovery_drill":             "PASS",
    "market_feed_health":         "UNKNOWN",
    "risk_engine":                "PASS",
    "oos_validation":             "FAIL",
    "parameter_freeze":           "UNKNOWN",
    "llm_execution_authority":    "OFF",
    "auto_tune_live_mutation":    "OFF",
    "kill_switch":                "ARMED_AND_TESTED"
  },
  "failed_gates": ["oos_validation"],
  "degraded_gates": ["execution_reconciliation"],
  "unknown_gates": ["market_feed_health", "parameter_freeze"],
  "evidence": {
    "security": "SECURITY-HARDENING.md §2 — forged-Origin bypass PoC'd then CLOSED (middleware v2 + NextAuth); T1/T2/T3b/T6b/T7 runtime evidence",
    "database_integrity": "scripts/db-integrity-check.ts 8/8 PASS on production + restored copy; 0 dup serials; 0 drift",
    "migration_integrity": "prisma migrate status 'up to date'; baseline 20260926000000_init recorded non-destructively",
    "execution_reconciliation": "state machine + entryGate + kill-switch 42/42 unit-tested; ENGINE INTEGRATION PENDING (D1)",
    "real_pnl_ledger": "accounting.ts class-separation tested; MIXED_PNL_CLASSES/NO_FILLS enforced; 8 required metrics",
    "recovery_drill": "DISASTER-DRILL-REPORT.md Drill A 9-step + 2 real same-day incidents recovered",
    "risk_engine": "risk-engine.ts: clamp-locked pilot limits; breakers/caps tested; non-bypassable via transition table",
    "oos_validation": "STRATEGY-VALIDATION-PROTOCOL.md current_status=FAIL (n=25≪300; expectancy −0.13R; Wilson LB 11.5%)",
    "kill_switch": "kill-switch.ts ARMED_AND_TESTED incl. corrupt-file fail-closed; drill step 6 PROVEN",
    "llm_isolation": "zero LLM→execution paths (grep-verified); grounding-audit discards hallucinated verdicts (shadow-veto v8.2.1); param adoption LLM-forbidden (tested)"
  },
  "exact_tests_run": ["bun test tests/ → 42/42", "bun scripts/db-integrity-check.ts (prod + copy) → 8/8", "prisma migrate status → up to date", "git fsck → clean", "runtime auth PoCs T1–T7 (SECURITY-HARDENING §2)", "disaster drill steps 1–9 (DISASTER-DRILL-REPORT.md)"],
  "exact_tests_not_run": ["TP/SL collision + TTL unit tests (settlement harness D2)", "live chaos: network/stale-feed/liq-feed outage", "encrypted offshore backup restore", "fresh-machine scripted runbook", "walk-forward OOS evaluation (needs ≥300 settled OOS trades — weeks of data)"],
  "remaining_blockers": [
    "D1: wire entryGate+kill-switch into engine.ts deploy path (single highest-value action)",
    "D2: transactional settlement (db-tx wrap of 8 update sites, tests-first)",
    "W1: service-level auth on mini-service mutating endpoints",
    "OOS: accumulate ≥300 clean OOS trades under frozen parameters, then re-evaluate per STRATEGY-VALIDATION-PROTOCOL.md"
  ],
  "operator_approval_required": true,
  "whether_real_orders_are_enabled": false
}
```

## gate semantics (task §13)

- **No numeric score exists.** Each gate is independently PASS / FAIL / DEGRADED / UNKNOWN / OFF / ARMED_AND_TESTED.
- Any gate not PASS ⇒ `current_state = NOT_ELIGIBLE`. Five gates are non-PASS right now (1 FAIL, 1 DEGRADED, 2 UNKNOWN) — hence the state below.
- `llm_execution_authority: OFF` and `auto_tune_live_mutation: OFF` are **structural** (no code path exists; param-governance rejects LLM adoption — tested) and must REMAIN OFF for eligibility.

---

## ⛔ MANDATORY FINAL STATEMENT

**Any critical gate is not PASS ⇒ NOT_ELIGIBLE_FOR_LIVE.**

Real-money trading is **DISABLED** and structurally absent (no order-signing code, no exchange credentials). The system must earn eligibility through the gates above; feature count, optimism, or any single backtest does not qualify it.

---

## Phase 14 — canary & limited-live protocol (defined; NOT activatable today)

| Stage | Purpose | Exit criteria (all required) |
|---|---|---|
| **SHADOW** (4–6 wks min) | strategy behavior under realistic costs, zero orders | clean ledger; entry-quality telemetry; no `qualityFlag` regressions; feed health PASS sustained |
| **CANARY** (20–30 trades) | validate ORDER MECHANICS, not edge | every fill reaches `PROTECTED`; reconciliation mismatches = 0; accounting ledger completes per-trade (8 metrics); kill-switch drill re-proven; modeled-vs-realized drag reported honestly |
| **LIMITED_LIVE** (30–100 trades) | stability under restricted risk | risk-engine rejections audited; daily/weekly breakers never bypassed; OOS gate stays PASS on accumulating data |
| **FULL_LIVE** | only after all independent gates PASS | machine-readable v1 block = eligible; **explicit operator mandate still required** (recovery_policy §rearm) |

Size increases only when the previous stage's exit criteria hold **and** the readiness block is regenerated from fresh evidence. GRAY_ZONE entries never count toward promotion volume (Phase 6 rule).

---

## next_action (single highest-value)

**D1 — wire `entryGate` + kill-switch into `engine.ts` deploy path** (tests-first, one session): converts the tested domain into the engine's actual gate, closing the last DEGRADED gate.
