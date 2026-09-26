# ACCOUNTING-SPEC.md — NEXUS//SIGNALS
**Task:** NEXUS-LIVE-HARDENING-MASTER-v1.0 · Phase 5 deliverable
**Implementation:** `src/lib/execution/accounting.ts` — real, tested code.

---

## 1. The three PnL classes — never mixed

| Class | Meaning | Source of truth |
|---|---|---|
| `MODELED_PNL` | What the model predicts (backtest/simulation assumptions) | model output |
| `PAPER_PNL` | What the paper engine would have achieved on live data (no real orders) | paper engine records |
| `REALIZED_PNL` | What an exchange actually returned: **actual fill prices, actual fees, actual funding** | exchange fills (none exist today) |

**Enforcement (runtime, tested):**
- `computeClassMetrics(entries)` **throws `MIXED_PNL_CLASSES`** if entries of different classes are combined — a modeled number can never be averaged into a realized one.
- `makeLedgerEntry` **throws `NO_FILLS`** if a `REALIZED_PNL` entry has zero actual fills (fill prices are mandatory).
- Classes are fixed at creation; downstream analytics must request per-class metrics.

## 2. Required metrics (task §5 — all eight, emitted per class)

`computeClassMetrics` returns exactly:
`gross_pnl · fees · funding · slippage · realized_pnl · realized_R · execution_latency_ms · model_vs_realized_error`

- `realized_pnl = gross − fees − funding − slippage` (deterministic).
- `realized_R` = Σ realized_pnl ÷ per-trade risk (requires the risk budget map from the risk engine; `null` when not attributable — never guessed).
- `slippage` = measured USD drag vs model price at execution time.
- `execution_latency_ms` = mean observed order round-trip.
- `model_vs_realized_error` = mean (gross − modeled) — the *predicted-vs-real execution drag* the task requires.
- Partial fills: `partialFillVwapUsd` = volume-weighted average across fills (tested).

## 3. What exists vs what awaits real trading (honest)

- **Today:** the paper engine (`engine.ts`/`aftermath.ts`) records paper outcomes; backtests produce modeled outcomes. The ledger module now gives both a class-safe home, and `REALIZED_PNL` has a strict, fill-demanding schema ready for the day a canary trades — **no realized entries exist and none may be fabricated**.
- Modeled assumptions presented as realized results are structurally impossible via this ledger; any external surface doing so is a violation to be flagged in review.

**Phase-5 acceptance:** separation enforced at type + runtime ✅ · fills/fees/funding/partial-VWAP/slippage/latency/drag fields present ✅ · 8 required metrics emitted ✅ · no fake realized data ✅.
