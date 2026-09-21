# RESEARCH — Signal Tracking & Valid Financial Flow Detection
## NEXUS//SIGNALS · EPOCH-2 · 2026-09-08 · feed for the Multi-TF Flow Scanner architecture

> Operator mandate (directive 2): «تحقیق و جستوجوی عمیق و مهندسی کن تا روند ردیابی دقیق و
> نحوه تشخیص جریانات مالی معتبر آشنا بشه» — this document is the evidence base the
> v8.0 Flow Scanner is built on. Sources: live web research (2026-09-08) + existing
> codebase forensics (flow.ts, triggers.ts, volCause.ts, backtest.ts).

---

## 1) What makes a flow signal "valid" (قابلیت اعتبار جریان)

Research consensus across SMC/order-flow literature and practice:

1. **Flow is only valid when it explains price, not when it merely exists.**
   The OI×price matrix (already in flow.ts) is the canonical validity test:
   - price↑ + OI↑ = fresh conviction (valid continuation)
   - price↑ + OI↓ = short covering (weaker, exhaustion-prone)
   - price↓ + OI↑ = fresh opposing conviction (valid threat)
   - price↓ + OI↓ = washout (no thesis)
2. **Aggression must be measured, not inferred.** CVD (cumulative volume delta =
   taker buys − taker sells) is the direct read of *who is paying the spread*.
   Delta-based strategies use: direction, exhaustion, and **divergence**
   (price makes a new extreme while delta does not → the move has no fuel).
3. **Liquidity sweeps are context, not entries.** A sweep (wick through the
   obvious swing that closes back inside with ≥50% rejection) is the footprint
   of stop-runs. It is valid ONLY relative to a higher-timeframe level —
   research explicitly warns: marking every minor LTF break as a structure
   shift produces "reversal signals several times an hour, nearly all false".
   **Anchor rule adopted: CHoCH/BOS are computed on closed bars of each TF and
   only trusted when the HTF (1h/4h) context agrees.**
4. **Positioning extremes are contrarian fuel.** Funding extremes (>±0.05%/8h),
   retail crowd L/S extremes (>2.2 :1 long / <0.5 heavy short) and the
   top-trader-vs-retail divergence (where SIZE sits vs where the CROWD sits)
   are the smart-money reads already proven in our own v6.7 SMC package.
5. **Liquidation cascades are exhaustion tails, not trends.** Real forceOrder
   cascades (≥$400K/10m, one side >60%) mark blow-off points — supportive for
   the *reversal* direction, risk for the trend direction (liq.ts R16 logic).

## 2) Multi-timeframe doctrine (چارچوب تایم‌فریمی)

Standard professional stack = HTF bias → LTF timing:

| TF | Role in the scanner | Weight |
|----|--------------------|--------|
| 4h | REGIME BIAS — trend + structure of the swing thesis | 0.35 |
| 1h | OPERATIONAL BIAS — where trades are hunted; cascade/Funding context | 0.30 |
| 15m | EXECUTION STRUCTURE — BOS/CHoCH that actually setups fire on | 0.20 |
| 5m | TRIGGER TIMING — sweep/CVD ignition, fastest decay, lowest trust | 0.15 |

Design laws derived from the research:
- **HTF dominance**: LTF signals against the 1h/4h bias are down-weighted, never
  boosted (prevents the "CHoCH noise" failure mode the research flagged).
- **Alignment is the edge**: NEXUS rewards candidates where ≥3 TFs agree; it
  surcharges candidates where the HTF board actively conflicts (±40 net score).
- **Closed bars only** — no intrabar repainting; every structure call is made on
  candles that have already closed (no lookahead, honest by construction).

## 3) Per-TF measurable vector (each TF, closed bars, per symbol)

| Metric | Definition | Source |
|--------|-----------|--------|
| cvdPct | Σ(2×takerBuy − vol)/Σ(vol)×100 over last 12 closed bars | kline field 9 (fapi) |
| trend | EMA20 vs EMA50 on TF closes (UP/DOWN/FLAT) | computed |
| structure | BOS_UP/BOS_DOWN (close beyond last pivot in trend) · CHOH_UP/CHOH_DOWN (against prior trend) · SWEEP_HIGH/SWEEP_LOW · RANGE | pivots on last 30 bars |
| sweep | last closed bar wicked through prior 24-bar swing and closed back inside, ≥50% rejection wick | computed (generalizes flow.ts detectLiquiditySweep) |
| volZ | (last bar vol − μ30)/σ30 — ignition/conviction flag | computed |
| atrPct | 14-bar ATR as % — regime scaling | computed |
| funding8h / oiDelta1h | TF-agnostic derivatives context | flow.ts metrics (shared fetch) |

Per-TF score −100..+100 = clamp(cvd 0.35×±100 + trend ±20 + structure
BOS ±20 / CHoCH ±15 / sweep-aligned +15 + volZ·dir ±10). Symbol rollup =
Σ(TF score × weight) → netBias (LONG/SHORT/NEUTRAL @ |net|≥20) + alignment count.

## 4) Tracking doctrine (ردیابی — directive 1 & 3)

Signal tracking is a *state machine over the ledger*, and the scanner extends it:
- Deploy-time: MTF board snapshot frozen onto the signal (mtfJson) for post-mortems.
- Live-time: an ACTIVE signal whose 1h+4h bias FLIPS against its direction raises a
  `FLOW-SHIFT` warn event (rate-limited 1/2h/signal) — the operator sees regime
  damage before the stop, and BE-TRAIL/TTL gates get an auditable evidence trail.
- Post-settle: scanner rows stay in `FlowScan` (unique per symbol+tf, upserted) so
  the calibration lab can attribute outcomes to flow states — the same
  profit-first expectancy doctrine the v6.3 calibrator established.

## 5) Calibration doctrine (directive 4) — anti-overfit rules

From walk-forward best practices + our own v5.0 learner architecture:
1. Real kline replay through the EXACT production scorer (no simplified sim) —
   backtest.ts already replays candle-by-candle with the real fee ladder.
2. **Wilson lower-bound as the primary objective** (penalizes small n), expectancy
   as tiebreaker — never raw win-rate.
3. Adoption margin: a swept calibration must beat baseline by ≥3 objective points
   with n ≥ 0.8×baseline — otherwise baseline stands (already enforced in autotune).
4. Independent senior-engineer verification pass BEFORE activation: recompute all
   reported stats from raw trades, verify fee math > 0, cooldown integrity,
   threshold monotonicity, and the no-lookahead property (snapshot uses
   `candles.slice(0, i+1)` — decision only sees the past).
5. Activation only on PASS: n≥20 · Wilson-LB ≥45% · avg NET expectancy > 0 —
   the same thresholds the learned gate (backtest.ts learnedGateAllows) enforces
   for live auto-deployment.

## 6) Implications for the v8.0 architecture (what we ship)

1. `FlowScan` table — per (symbol, tf) upserted row (no write-race churn).
2. `flow-scanner.ts` — rotating batch scanner on the engine tick (48-symbol
   domain in ~10min, per-TF kline caches, OI/funding shared from flow.ts).
3. Engine gate integration — MTF-CONFLICT surcharge (+5 thrAdj) and
   MTF-ALIGNED bonus (−4 thrAdj, alignment ≥3) inside the existing dynamic
   MIN_SCORE pipeline; snapshot persisted on every deployed signal.
4. `FLOW-SHIFT` tracking events for live books.
5. `/api/flows` + FLOW SCANNER dashboard card — the full multi-TF heat grid.
6. EPOCH-2 protocol: wipe → replay calibration grid (minScore axis) →
   senior-engineer verification → apply best calibration → engine ACTIVE.

— compiled by main agent loop, EPOCH-2 build session 2026-09-08
