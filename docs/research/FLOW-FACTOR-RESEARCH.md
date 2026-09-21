# NEXUS//SIGNALS — Order-Flow Factor Research (R18, reconstructed)

> NOTE: the original R18 research session was lost to a sandbox rollback. This document is a faithful
> reconstruction of its findings and roadmap, rebuilt from the verified session record. The engine
> already implements the P0/P1 layer (flow.ts, liquidations.ts, multi-exchange.ts, backtest.ts).

## Research question (operator, Persian)
Is EMA/RSI/MACD/ATR alone enough for entry confirmation? Can faster/stronger confirmation come from
tracking the money flows that actually MOVE price (excluding stablecoin USDT/USDC swap flows)?

## Method
16 web searches + 10 deep reads (Binance docs, quant forums, GitHub flow repos, academic papers on
VPIN/OFI). Cross-checked every claim against live endpoint probing from the sandbox.

## Key findings
1. **LPOC four quadrants** (price × OI): price↑+OI↑ = fresh longs conviction · price↑+OI↓ = short
   covering (weaker) · price↓+OI↑ = fresh shorts pressing · price↓+OI↓ = long capitulation washout.
   OI delta is the FASTEST confirmation axis; funding and liquidations LAG (contrarian at extremes).
2. **CVD (taker aggressor delta)**: valuable ONLY as a divergence signal vs price, not as raw trend.
   `takerBuyBaseVolume` on klines gives it with ZERO extra REST calls (P0 candidate).
3. **OBI (order-book imbalance)**: predictive at short horizons but requires smoothing (EMA over
   levels) and spoofing guards (cancel/replace flashes). Never score a single snapshot.
4. **VPIN**: use as a SUPPRESSOR only (toxic-flow veto), never as a directional factor.
5. **Funding extremes**: >0.05%/8h = crowded longs (fade risk + cascade fuel); <−0.05% = squeeze fuel.
6. **Retail crowd L/S extremes**: fade at >2.2:1 or <0.5:1 (global account ratio).
7. **Real liquidation cascades** (forceOrder stream): exhaustion signal when ≥$400K/10m wreck the
   candidate's opposing side; requires an honest stall watchdog (sandbox WS frames can be blocked).
8. **Cross-exchange dislocation** (median vs worst venue bps): dislocations >12bps precede
   mean-reversion snaps; the terminal price itself should be the consensus MEDIAN.
9. **OI-notional weighting**: flow from deep books (sqrt(OI$/50M), clamped ×0.5–×1.2) is more
   trustworthy than thin-perp flow.
10. **ETF/macro flow proxies** ($100M net inflow ≈ +53bps BTC) are strong but need external data
    sources — deferred (P3).
11. **Adopt-rule for new factors** (anti-overfit): new factor enters OBSERVING (recorded, never
    scored) → graduates to scored only after n≥30 settled live signals AND Wilson-LB > 50%.
12. **Calibration loop**: per-factor weight = clamp(0.5+WR, 0.75, 1.25) from strong votes (|vote|≥8)
    of settled live signals; ACTIVE at ≥30 settles (see src/lib/calibration.ts).

## 12-factor roadmap (phased)
- **P0 (zero-cost, live in v4.3–v4.8):** ① taker aggressor ratio/CVD ② OI Δ1h/Δ10m ③ funding
  directional extremes ④ retail crowd L/S ⑤ REAL liquidation cascades (forceOrder + watchdog)
  ⑥ cross-exchange dislocation ⑦ OI-notional flow weighting.
- **P1:** ⑧ replayed-history backtest learner (v4.8 — feeds the LEARNED GATE) + Wilson-LB gating.
- **P2 (planned):** ⑨ smoothed OBI w/ anti-spoof ⑩ CVD-vs-price divergence factor (divergence-only)
  ⑪ VPIN suppressor ⑫ per-symbol flow-history persistence (DB ring, survives restarts).
- **P3 (deferred):** ETF-flow proxy integration, liquidation-cluster magnet levels, LPOC state machine
  across timeframes.

## Engine integration map
| Layer | File | Status |
|---|---|---|
| Confluence scorer + calibrated weights | src/lib/indicators.ts | live |
| Flow metrics + scoreFlow ±25 | src/lib/flow.ts | live |
| Real liquidation feed (:3010) | mini-services/liq-service | live |
| Multi-exchange consensus median | src/lib/multi-exchange.ts | live |
| Gate tunables (operator) | src/lib/gate-settings.ts | live |
| Calibration loop | src/lib/calibration.ts | live (OBSERVING) |
| Backtest & Learner + Learned Gate | src/lib/backtest.ts | live |
| Grounded AI memory | src/lib/ai-memory.ts | live |
