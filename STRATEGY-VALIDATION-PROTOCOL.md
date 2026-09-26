# STRATEGY-VALIDATION-PROTOCOL.md — NEXUS//SIGNALS
**Task:** NEXUS-LIVE-HARDENING-MASTER-v1.0 · Phase 7 deliverable
**Written:** 2026-09-26 (Tehran) · **By:** general-purpose subagent (Task P7) · **After:** rollback #4 recovery (worklog Task 30/30-b), Phase 1 recon (Task 31)
**Method:** written against the live repository state; every measured number cited to its evidence anchor. No number is aspirational.
**Scope:** this document defines the ONLY path by which a strategy/parameter set may be promoted toward live eligibility. Real-money execution remains **DISABLED** throughout; live auto-deployment is currently `SUPPRESSED` (engine.ts:1501/1505) and can only change after this protocol returns PASS and the Phase 13 readiness gate accepts it.

---

## 1. Purpose & authority

1. This protocol is the gatekeeper between "a backtest looks good" and "the system is allowed to trade it". It binds:
   - the AUTO-LEARNER / calibration loop (`src/lib/calibration.ts`, `src/lib/backtest.ts`, engine learner runs every 6h),
   - weight adoption (`src/lib/strategy-weights.ts`, `/api/strategy-weights` POST — Phase 8 freeze target),
   - the learned gate verdict strings in `engine.ts` ("NO LEARNED EDGE … auto-deployment stays SUPPRESSED").
2. **Precedence:** if any other document, dashboard card, or script claims a strategy is validated, it is invalid unless it can point to a machine-readable result artifact conforming to §12 with `decision.verdict = "PROMOTE"`.
3. Status markers used throughout: **VALIDATED** = standard statistical method, mathematically defined; **HEURISTIC** = engineering threshold chosen by this protocol, may be revised only via the pre-registration rule of §10.5; **OPEN** = requirement currently unmet — current measured value stated honestly.

---

## 2. current_status — the system does NOT pass this protocol

**Gate result today: `oos_validation` = FAIL.** Live auto-deployment must remain SUPPRESSED.

| Evidence anchor | Measured value (verbatim from source) |
|---|---|
| Latest backtest run — EngineSetting key `backtest`, ranAt `2026-09-19T07:17:36.841Z`, FLOWRADAR-NEO v5.1 "AUTO-TUNE BASELINE" | `n=25`, `wins=6`, `win_rate 24%`, Wilson LB `11.5%`, `avg_net −13.05%`, `expectancyR −0.13`, `totalNetUsd −15.08`, `equity_end 84.92` (start $100) |
| Verdict string of that run | "NO LEARNED EDGE — WR 24% (LB 12%), expectancy −13.05%/trade NET — live auto-deployment stays SUPPRESSED until recalibration" |
| Calibration counter at that run | `{"status":"ACTIVE","settled":300,"target":30}` |
| By-strategy split of that run | AI-SWING n=13 avg −21.59% · AI-SCALP n=5 avg +1.36% · BREAKOUT n=4 avg −8.18% · MEAN-REVERT n=3 avg −6.54% |
| Fast-kill research (duration forensics payload, `src/lib/duration.ts`) | 28 real fast-kill cases (<15m straight-to-SL, no trail), **42.9% never went green (MFE ≤ 0)**, worst bucket **0-5m (win 8.6%)** — entry-quality problem, not exit problem |
| Live deployment state | `live_auto_deployment: SUPPRESSED` (engine.ts:1501/1505, learned gate; operator-forced deploys bypass ⚠️) |

Snapshot invariance note: later archived snapshots (`backups/calibration-latest.json`, 2026-09-25/26) contain a larger frozen-baseline replay (n=348, WR 36.5%, LB 31.6%, avg_net −1.03%, expectancyR −0.01, equity_end 81.73, verdict "NO LEARNED EDGE") and forensics n=30 / 43.3% never-green. These do **not** improve the picture: the verdict is negative at every sample size measured so far. The FAIL conclusion is invariant across snapshots.

Gap table (requirements of §9 vs today):

| Requirement | Required | Current | Status |
|---|---|---|---|
| OOS trades | ≥300 (preferred 500) | 25 | **OPEN** (8.3% of minimum) |
| Per active strategy | ≥60 where feasible | max 13 (AI-SWING) | **OPEN** |
| net_expectancy (R) | > 0 with CI LB > 0 | −0.13R | **OPEN** (negative) |
| profit_factor | ≥1.15 (see §9) | not reported by v5.1 learner output | **OPEN** (must be emitted) |
| rolling_window_expectancy | see §9 | impossible at n=25 | **OPEN** |
| drawdown_containment | see §9 | equity −15.08% start→end; maxDD not emitted | **OPEN** (must be emitted) |
| win-rate Wilson LB (secondary) | reported; no promotion power | 11.5% | reported, useless at n=25 |
| parameter freeze artifact | hash-pinned snapshot (§8) | learner sweeps/adoption SUSPENDED until n≥100 (engine learner, frozen R6/G2) but no formal freeze hash | **OPEN** |

**Consequence:** any dashboard, Telegram post, or report claiming readiness is false until §12 shows `PROMOTE`. The readiness gate (Phase 13) must read `oos_validation: FAIL` from §12-shaped artifacts, never from prose.

---

## 3. Data governance — training/tuning vs validation separation (spec §1)

1. **Three disjoint data roles, never mixed:**
   - **TRAIN** — parameter/weight fitting (calibration epochs, factor-weight learning, grid search).
   - **TUNE** — model/config selection among candidates (the "best-of-grid" pick). TUNE may reuse TRAIN-period data only for scoring, never for fitting on the same rows that will later count as OOS.
   - **OOS (validation)** — final evidence. Once a candidate is declared "frozen" for validation, the OOS window is reserved: no fitting, no weight updates, no gate-threshold changes may consume OOS rows (§10.1).
2. **Dataset registry (mandatory).** Every run must record: data source, exact window (`from`/`to` UTC), row counts, extraction script + commit hash, and a content hash of the extracted trade set. Without a registry entry the run is not admissible as evidence.
3. **Admissible sources (current):** paper-ledger settles in `db/custom.db` (Signal/PnL), shadow settle/deploy journals (`db/research-shadow/*.ndjson`), Binance Vision archived klines (as used by `scripts/flow-backtest-0908.ts`), and EngineSetting backtest payloads. Live-real settles do not exist yet (no order path — ARCHITECTURE-MAP §3).
4. **Ledger hygiene:** OOS cohorts must be clean-ledger (`qualityFlag: null`, DEGEN-STOP integrity guard per worklog Task 8) or must disclose flagged rows separately. Settlements with non-finite/contradictory stops are excluded, and the exclusion count must be reported.
5. **Leakage rules (structural, VALIDATED):**
   - signals decided only on closed bars (cutoff `t − tfMs`, as enforced in the flow backtest `noLookahead` verification);
   - conservative intrabar ordering — SL evaluated before TP within a bar;
   - OOS rows never appear in TRAIN/TUNE windows of the same candidate (enforced by window registry overlap check);
   - no transform (normalization, regime label, factor weight) may be computed over a window that includes OOS rows. Regime labels (`src/lib/regime.ts`) and flow scores must be computed causally, point-in-time.

## 4. Walk-forward evaluation (spec §2)

1. **Default windows (HEURISTIC):** TRAIN = 28 days → EMBARGO = 24 h → TEST = 7 days; step = 7 days (TEST windows do not overlap). Alternative anchored mode (expanding TRAIN, fixed start) must be reported alongside rolling mode for the final candidate.
2. **Refit cadence:** parameters/weights refit **once per fold** on that fold's TRAIN window only. Refitting more often than once per TEST window is a §10 violation.
3. **Embargo:** 24 h dead zone between TRAIN end and TEST start — exceeds the observed holding-time p95 (≈7.1 h) and covers TTL extensions; purpose is to prevent overlap leakage between the last TRAIN positions and the first TEST positions. Embargo may be raised (never lowered) for slower strategies.
4. **Fold count:** a decision (§11) requires ≥8 non-overlapping TEST folds spanning ≥1 regime transition per `src/lib/regime.ts` labels. Fewer folds ⇒ INSUFFICIENT_EVIDENCE, not PROMOTE.
5. **Per-fold reporting is mandatory:** each fold's n, expectancy (R), PF, WR, Wilson LB, maxDD. Aggregate-only reporting is not admissible.
6. **Multi-config discipline:** the flow-backtest precedent (`scripts/flow-backtest-result.json`) evaluated a 432-config grid — selection over K configs multiplies false-positive risk; the family/plateau check of §7 is the required counterweight, and the config budget is capped in §10.2.

## 5. Evaluation slices (spec §3)

Every OOS evaluation must be reported sliced by all six dimensions. A slice is **reportable** at n≥30 and **decision-bearing** at n≥60.

| Dimension | Source | Decision rule |
|---|---|---|
| Strategy | signal `strategy` field (AI-SWING, AI-SCALP, BREAKOUT, MEAN-REVERT, MOMENTUM) | no decision-bearing slice may have mean expectancy ≤ 0 |
| Symbol | per symbol | contribution concentration capped by §6.4 |
| Side | LONG vs SHORT | symmetric-report; a side with n≥60 and mean R ≤ 0 blocks PROMOTE |
| Timeframe | signal timeframe | same rule |
| Regime | `src/lib/regime.ts` labels (point-in-time) | same rule; at least 2 regimes must be represented overall |
| Time bucket (holding duration) | duration buckets `0-5m / 5-15m / 15-30m / 30-60m / 60-120m / 120m+` (`src/lib/duration.ts:116`) | report-only today; the 0-5m bucket (current win 8.6%) is a known entry-quality failure zone — a candidate whose expectancy depends on sub-5-minute closures is rejected by inspection (§10.6) |

Current-run slice evidence to keep in view: AI-SWING (n=13, −21.59%) and BREAKOUT (n=4, −8.18%) are the dominant loss carriers in the n=25 run; the fast-kill study (28 cases, 42.9% never-green, 0-5m win 8.6%) shows losses concentrate in instant-reversal entries, independent of exit logic.

## 6. Metrics (spec §4–§5)

### 6.1 Friction model (mandatory on every metric)
All reported metrics must be **NET of the validation friction model**. Any gross-quota metric is inadmissible.

- **Implemented baseline (keep):** `src/lib/accounting.ts:6-7,19-27` — round-trip taker commission `0.05% × 2` on notional, funding `0.01% / 8h` pro-rated by holding minutes, margin sized before the walk, NET on a running $100 paper account.
- **Validation-grade add-on (HEURISTIC default):** slippage `0.05% per side` on notional (10 bps round trip), applied uniformly until measured fill/slippage data exists. **OPEN:** current learner output carries no slippage term.
- **Conservative intrabar ordering:** SL before TP (already enforced in flow-backtest `intrabarOrdering` verification) — keep.
- **Funding direction:** current model uses a flat positive-rate baseline; direction-aware funding (sign of realized 8h rate at hold time) is **OPEN** and should be adopted when the oi-funding feed history is long enough.
- Sensitivity: final candidate must report expectancy at 0.5×, 1×, and 2× the slippage assumption. Promotion must survive 2× slippage with CI LB still > 0.

### 6.2 Primary metric — expectancy in R (not win rate)
- `R` per trade = realized NET PnL ÷ initial levered risk, where initial levered risk = `slDistPct × leverage` in % of margin (the system's own risk unit, cf. `leveredRiskPct` in duration forensics and the DEGEN-STOP ≥0.25% guard).
- **Win rate is NOT evidence.** It is reported with its Wilson LB and nothing more (see the n=25 run: WR 24% would be meaningless even if it were high).
- Measured today: **expectancy −0.13R** (negative) — the primary metric currently fails outright.

### 6.3 Downside & drawdown metrics (must be emitted by the learner — OPEN)
- `maxDD_pct`: peak-to-trough equity drawdown on the $100 validation account.
- `worst5_share`: share of total net loss contributed by the 5 worst trades (downside concentration).
- `tail_ratio`: mean of top-decile R ÷ |mean of bottom-decile R|; a candidate dependent on rare tails is not promotable (report-only).
- Time-under-water (days) at fold level.

### 6.4 Contribution concentration
- Share of total net R by symbol, by strategy, by regime: `top1_share`, `top2_share`, HHI per dimension.
- **HEURISTIC caps:** top symbol ≤ 40% of net R; top-2 ≤ 60%; HHI (symbol) ≤ 0.25. A strategy whose "edge" is one symbol or one regime episode fails §11 PROMOTE.

## 7. Parameter-instability detection (spec §6)

A frozen candidate must demonstrate it is not a grid-island:

1. **Neighborhood stability (HEURISTIC):** all one-step grid neighbors of the chosen config must have median NET expectancy > 0, and the chosen config must not beat its neighborhood median by more than 50% (an outlier-vs-neighbors pattern indicates overfit selection). Precedent: the flow-backtest family check required 3/3 `rrScale` siblings train-positive with a Wilson-LB plateau (family verdict `CONDITIONAL-PASS`, `scripts/flow-backtest-result.json:166-168`).
2. **Refit variance:** across walk-forward folds, `CV = std(fold expectancy) / |mean(fold expectancy)| ≤ 1.0`, and ≥70% of folds positive (HEURISTIC). A high-CV candidate is regime-dependent noise.
3. **Train→test degradation bound (HEURISTIC):** TEST-window expectancy must retain ≥50% of the TRAIN-window expectancy; degradation >50% requires the neighborhood check to rescue it, else REJECT.
4. **Selection-pressure disclosure:** every result artifact must state how many configs were evaluated (multiple-comparison exposure) and whether the adopted config was selected on the same observations now used as evidence (it must not be — §10.1).

## 8. Production parameter FREEZE during validation (spec §7)

1. **Trigger:** declaring a candidate "under validation" freezes ALL production-tunable surfaces: `strategy-weights` + factor weights, gate settings (`src/lib/gate-settings.ts`), engine flags that alter signal generation, calibration objective. The AUTO-LEARNER's sweep + weight adoption are already SUSPENDED until n≥100 (engine learner, frozen R6/G2) — during validation this suspension is extended unconditionally.
2. **Freeze artifact (mandatory):** a JSON snapshot of every frozen surface + `sha256` of the concatenation + git commit hash, stored in the dataset registry and committed (push-armor covers it within 10 min). Validation evidence is void if the freeze hash at decision time ≠ hash at declaration.
3. **Unfreeze authority:** operator only, via the same mutation surfaces listed in ARCHITECTURE-MAP §4 (all x-nexus-key gated). Unfreezing mid-validation resets the OOS evidence budget to zero for that candidate.
4. **Why this is strict:** the system's own history shows the failure mode — an "AUTO-TUNE BASELINE" run (n=25) produced from a calibration loop that was itself ACTIVE (settled 300). Parameter churn and validation evidence must never share a clock.

## 9. Minimum evidence requirements (spec §8)

| ID | Requirement | Threshold | Rationale |
|---|---|---|---|
| MIN-OOS-N | OOS trades, total | ≥300 required, 500 preferred | below ~300 the bootstrap CI on expectancy is too wide to clear §10 thresholds at this system's R-variance |
| MIN-STRAT-N | per active strategy | ≥60 where feasible | strategy-level slices must be decision-bearing (§5) |
| MET-EXPECT | `net_expectancy` (R) | mean ≥ +0.05R AND bootstrap 95% CI LB > 0 | primary metric; §10.1 |
| MET-PF | `profit_factor` | ≥ 1.15 (HEURISTIC; hard floor 1.0) | gross-win/gross-loss NET of friction |
| MET-ROLL | `rolling_window_expectancy` | rolling 30-trade windows: ≥80% of windows mean-R > 0; worst window mean-R ≥ −0.10R | edge persistence, not episode luck |
| MET-DD | `drawdown_containment` | maxDD ≤ 15% of paper equity at validation leverage mix; worst single trade ≤ 1.2R realized | survival constraint |
| MET-WR | win rate Wilson LB 95% | reported, secondary | no promotion power by itself (§10.1) |

All thresholds are **HEURISTIC** except where noted; the statistical *methods* are **VALIDATED**. Today every row of this table is **OPEN** (§2).

## 10. Statistical & anti-overfitting rules (spec §9–§10)

### 10.1 Positive mean alone is NOT evidence (VALIDATED)
- **Primary test:** block bootstrap on per-trade R multiples — resample whole UTC days (preserves intra-day autocorrelation), 10,000 resamples, 95% percentile CI. PASS requires **CI lower bound > 0**. With n=25 the mean is −0.13R: there is nothing to bound; the rule fails trivially today.
- **Secondary:** Wilson score lower bound (z = 1.96) on win rate — reported for context (currently 11.5% at 6/25). The two win definitions in the codebase must never be conflated: backtest `win = netPct > 0` vs live telemetry TP-proven `reachedTp ≥ 1` (worklog Task 8 correction; engine comment on net-based wins). The report must state which definition it uses.
- **Dependence caveat:** trades sharing a symbol/day/regime are not iid — hence day-blocks, hence fold-level reporting.

### 10.2 Tuning budget (HEURISTIC)
≤20 distinct configs per validation cycle per strategy family; every config attempt is logged in the trials registry (`src/lib/trials-registry.ts`). Silent re-rolls under new names are a REJECT condition.

### 10.3 No promotion on selection observations (VALIDATED by construction)
The observations used to choose the promoted parameters must be disjoint from the OOS evidence window (§3.1, §3.5). The dataset registry overlap check must return zero overlap, and the freeze hash (§8) must match.

### 10.4 No repeated tuning on the same small validation window (VALIDATED by construction)
A given OOS window may serve at most ONE selection→evidence cycle. Re-running selection against the same window with modifications burns the window permanently. Extensions (§11) only ever ADD new forward data.

### 10.5 Pre-registration (procedural)
Hypothesis, friction model, thresholds, and slice definitions are written into the candidate's registry entry BEFORE the OOS run. Changing any threshold after seeing results ⇒ evidence budget resets to n=0 and the change is journaled in the gate journal (`.data/gate-journal.jsonl`).

### 10.6 No promotion from one favorable episode (VALIDATED by construction)
PROMOTE requires ≥8 folds spanning ≥1 regime change (§4.4). A single good week, one pump cycle, or one symbol run is explicitly non-evidence — the 0-5m / never-green forensics (§2) is the standing reminder that single episodes here have been loss-dominated.

## 11. Decision outputs (spec §11) — exact numeric criteria

Verdicts: **PROMOTE / EXTEND_VALIDATION / REJECT**. REJECT carries a reason code: `NEGATIVE_EVIDENCE` or `INSUFFICIENT_EVIDENCE`.

### PROMOTE — requires ALL of:
| # | Criterion |
|---|---|
| P1 | n_OOS ≥ 300 (if 300–499: all other criteria must pass with zero marginal rows; 500 preferred) |
| P2 | every active strategy with feasible cohort has n ≥ 60 |
| P3 | expectancyR mean ≥ +0.05R AND block-bootstrap 95% CI LB > 0 (survives 2× slippage sensitivity, §6.1) |
| P4 | profit_factor ≥ 1.15 |
| P5 | rolling-window rule (MET-ROLL) satisfied |
| P6 | maxDD ≤ 15% AND worst trade ≤ 1.2R |
| P7 | no decision-bearing slice (n≥60) with mean R ≤ 0 across strategy/side/timeframe/regime |
| P8 | concentration caps: top symbol ≤ 40% net-R, top-2 ≤ 60%, HHI_symbol ≤ 0.25 |
| P9 | stability: neighborhood stable (§7.1), CV ≤ 1.0, ≥70% folds positive, ≥50% train→test retention |
| P10 | freeze hash verified for the entire validation period; dataset overlap check = 0; tuning budget respected |

### EXTEND_VALIDATION — requires ALL of:
- n_OOS ≥ 300; P3 bootstrap LB > 0, P4 PF > 1.0, P6 DD containment all hold (no hard failure);
- exactly 1–2 soft criteria marginal: PF in (1.0, 1.15), rolling-positive share in [70%, 80%), or a failing slice with n < 60 (non-decision-bearing);
- at most ONE extension per candidate: add ≥200 new OOS trades or span one new regime, whichever comes later. A second marginal verdict ⇒ REJECT.

### REJECT — any of:
- n < 300 at decision time (`INSUFFICIENT_EVIDENCE`);
- bootstrap CI LB ≤ 0, or mean expectancyR ≤ 0 (`NEGATIVE_EVIDENCE`);
- PF ≤ 1.0; maxDD > 25%; any decision-bearing slice mean R ≤ 0;
- top-symbol concentration > 60%; CV > 1.5 or <50% folds positive;
- freeze violation, dataset overlap > 0, post-hoc threshold change, budget breach.

**Today's verdict under these rules:** n=25 (< 300) AND mean −0.13R AND equity −15.08% ⇒ **REJECT (both reason codes)** ⇒ `oos_validation` gate = **FAIL**; auto-deployment remains SUPPRESSED. No path exists to PROMOTE without new OOS evidence gathered under §3–§8.

## 12. Machine-readable result schema (spec §12)

The Phase 13 readiness gate consumes artifacts of this exact shape (versioned `nexus.strategy-validation.v1`). Example below is populated with today's honest values:

```json
{
  "schema": "nexus.strategy-validation.v1",
  "generatedAt": "2026-09-26T00:00:00.000Z",
  "protocol": "STRATEGY-VALIDATION-PROTOCOL.md#v1.0",
  "candidate": {
    "name": "FLOWRADAR-NEO v5.1 AUTO-TUNE BASELINE",
    "paramSetHash": "sha256:TO-BE-PINNED-ON-NEXT-FREEZE",
    "frozenAt": null,
    "trainingObservations": { "source": "EngineSetting:backtest+calibration", "settledCalibration": 300, "calibrationStatus": "ACTIVE" }
  },
  "evidence": {
    "oosTrades": 25,
    "requiredOosTrades": 300,
    "preferredOosTrades": 500,
    "perStrategyMin": 60,
    "walkForwardFolds": 0,
    "datasetOverlapCheck": "NOT_RUN",
    "freezeHashMatch": null
  },
  "metrics": {
    "netExpectancyR": { "mean": -0.13, "ci95": null, "method": "block-bootstrap-10k-by-utc-day", "note": "n<300: CI not computed; mean itself negative" },
    "winRate": { "value": 24.0, "wilsonLB95": 11.5, "definition": "backtest netPct>0", "role": "secondary-only" },
    "profitFactor": { "value": null, "status": "OPEN — not emitted by learner" },
    "rollingWindowExpectancy": { "windowTrades": 30, "sharePositive": null, "worstWindowMeanR": null, "status": "OPEN — n<30" },
    "drawdown": { "maxDDEquityPct": null, "equityStartToEndDatePct": -15.08, "worstTradeR": null, "status": "OPEN — maxDD not emitted" },
    "contribution": { "topSymbolShareOfNetR": null, "topStrategyShareOfNetR": null, "hhiSymbol": null, "status": "OPEN" }
  },
  "slices": [
    { "dimension": "strategy", "value": "AI-SWING",    "n": 13, "meanNetPct": -21.59, "decisionBearing": false },
    { "dimension": "strategy", "value": "AI-SCALP",    "n": 5,  "meanNetPct": 1.36,   "decisionBearing": false },
    { "dimension": "strategy", "value": "BREAKOUT",    "n": 4,  "meanNetPct": -8.18,  "decisionBearing": false },
    { "dimension": "strategy", "value": "MEAN-REVERT", "n": 3,  "meanNetPct": -6.54,  "decisionBearing": false },
    { "dimension": "durationBucket", "value": "0-5m",  "n": 28, "note": "fast-kill cohort: 42.9% never-green, win 8.6% in worst bucket", "decisionBearing": false }
  ],
  "checks": [
    { "id": "MIN-OOS-300",   "status": "FAIL", "required": ">=300",   "measured": 25 },
    { "id": "MET-EXPECT",    "status": "FAIL", "required": "mean>=+0.05R and CI-LB>0", "measured": "-0.13R" },
    { "id": "MET-PF",        "status": "OPEN", "required": ">=1.15",  "measured": null },
    { "id": "MET-ROLL",      "status": "OPEN", "required": ">=80% windows positive", "measured": null },
    { "id": "MET-DD",        "status": "OPEN", "required": "maxDD<=15%", "measured": "start->end -15.08%" },
    { "id": "FREEZE-HASH",   "status": "OPEN", "required": "declared==verified", "measured": null }
  ],
  "decision": { "verdict": "REJECT", "reasonCodes": ["INSUFFICIENT_EVIDENCE", "NEGATIVE_EVIDENCE"], "decidedAt": "2026-09-26T00:00:00.000Z" },
  "gate": { "id": "oos_validation", "result": "FAIL" },
  "liveAutoDeployment": "SUPPRESSED"
}
```

Consumer contract (Phase 13): `gate.result = PASS` iff `decision.verdict = "PROMOTE"` and every `checks[*].status = "PASS"`. Any `OPEN` ⇒ gate result `FAIL` (OPEN is never promotable). The gate must also verify `liveAutoDeployment` is still `SUPPRESSED` at read time.

## 13. Governance & audit trail

1. Result artifacts are written under `.data/validation/` (registry + per-candidate JSON), committed to git (push-armor v2.0 covers them within 10 min — worklog Task 30 lesson: nothing survives rollback unless it is committed).
2. Every verdict (PROMOTE/EXTEND/REJECT) is appended to the worklog and to `CHANGELOG-LIVE-HARDENING.md` with the artifact path and hashes.
3. This protocol may be amended only by appending a dated section to this file; §10.5 reset rules apply to any candidate evaluated under a changed threshold.

## 14. Acceptance self-check (spec coverage)

- [x] Train/TUNE/OOS separation + dataset registry + leakage rules (§3)
- [x] Walk-forward: windows, anchoring, refit cadence, embargo, fold minimums (§4)
- [x] Six evaluation slices with decision-bearing minimums (§5)
- [x] Fees + slippage friction model stated, incl. what is implemented vs added (§6.1)
- [x] Expectancy in R, drawdown/downside metrics, contribution concentration (§6)
- [x] Parameter instability: neighborhood stability, refit variance, degradation bound (§7)
- [x] Production parameter freeze with hash artifacts (§8)
- [x] Minimums: ≥300/500 OOS, ≥60 per strategy, four required positive metrics (§9)
- [x] Bootstrap CI on R + Wilson LB secondary; HEURISTIC vs VALIDATED marked (§6.1, §9, §10)
- [x] Anti-overfitting: no promotion on selection data, no window reuse, no single-episode promotion, pre-registration, budget (§10)
- [x] PROMOTE / EXTEND_VALIDATION / REJECT with numeric criteria (§11)
- [x] Machine-readable schema for the Phase 13 gate (§12)
- [x] current_status: system does NOT pass — `oos_validation` = FAIL (§2)

**Phase 7 status: DONE (document only, no application code touched).** Next consumer: Phase 8 (freeze/governance of `strategy-weights`) and Phase 13 (readiness gate reading §12 artifacts).
