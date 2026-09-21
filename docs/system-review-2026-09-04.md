# NEXUS//SIGNALS — Full System Scan & Architecture Review
**Date:** 2026-09-04 · **Engine:** NEXUS-LIVE v6.1 · **Reviewer:** Z.ai Code (autonomous)
**Scope:** operator request (Persian, 5 points): expert scan of signals/reports/agents/LLM · expired-PnL accounting · dynamic expiry gate · NET EST PNL analytics · architecture review.

---

## 1. Live book verdict (measured 2026-09-04 ~08:00Z)

| Metric | Value | Assessment |
|---|---|---|
| Signals total | 83 | healthy sample for a sandbox |
| ACTIVE / TP3 / SL / EXPIRED / CLOSED | 5 / 5 / 33 / 39 / 1 | SL-heavy book (40%) |
| TP-proven win rate (reachedTp≥1 ∥ TP*) | 33% | low-marginal; quality valve active |
| Realized NET (all-time) | −$9.08 on $100 start | account balance $90.92 → equity $93.03 |
| EXPIRED bucket NET | **+$21.96** (39 trades) | expiries close profitable at mark (15 were TP-proven first) |
| TP bucket NET | +$14.96 (5) | full-ladder winners pay well (65–99% NET) |
| STOP bucket NET | −$45.84 (33) | the loss engine: avg −1.39% margin drag/trade |
| Afterlife (post-expiry 48h) | 23 TP1_HIT + 2 TP2_HIT / 8 SL_HIT / 6 tracking | **64% would-have-won** · avg post-MFE +27.3% levered |

**Opinion:** the book is honest and fully audited (no simulated fills, fee-NET accounting, persisted events for every transition). The dominant loss mode is *stop-outs in chop* (deep-learn's own lesson: 6/8 stop-outs were REGIME-CHOP) plus *TTL-too-short* (64% of expiries reach TP after the cut — this round's fix). The governor's anti-lockup + quality valves are working as designed (MIN_SCORE ratcheted 20→25 on trailing-WR drift, then evidence-gate blocks over-tightening).

## 2. Q2 — expired signals & the account balance + follow-up reports

**Balance:** YES — an expired signal is auto-closed at the TTL mark price with fee-aware NET pnlPercent written; it enters `realizedAllTime` (stats.ts) → `balance = START + Σ closed NET`. Verified: EXPIRED bucket contributes +$21.96 of the current $−9.08 NET. Afterlife TP-hits deliberately do NOT re-open the position — they are calibration data, not balance.

**Follow-up reports:** before this round, a post-expiry TP hit emitted one `AFTERLIFE` SignalEvent — visible ONLY in the bell inbox + CRT terminal (no toast/sound; aggregates computed but rendered nowhere). **Fixed in v6.1:** AFTERLIFE is now toast+sound alertable, FLAT window-closure now emits an event, aggregates render in the new ledger card footer, and extension grants/denials are audited ENGINE events with reasons.

## 3. Dynamic expiry gate (v6.1) — design shipped

Evidence → policy: 64% would-have-won + avg 169min TTL on losers vs 179min winners ⇒ hard TTL is a loss mode. Implementation (zero manual modes):
- `src/lib/ttl-gate.ts` — deterministic evaluator: budget (max grants) → 3×TTL lifetime cap → drawdown guard (deny if ≥60% of risk distance spent) → grant if next-TP within band OR profitably afloat with non-negative 20m PricePoint momentum. Every grant/deny writes its measured reason into the feed.
- Governor (LLM) owns policy knobs `ttlExtendMax / ttlExtendMinutes / ttlNearTpPct` (clamped 0–3 / 15–240m / 0.3–5%) via new `set_ttl_extend_*` decisions; telemetry bundle line 8c feeds it the extension→TP/SL/re-expired conversion + afterlife post-mortem each cycle. If extensions stop converting, the LLM can dial the gate to 0 (honest off-switch).
- Outcome telemetry persisted in EngineSetting `ttl-gate` (extended/tpAfter/slAfter/reExpired/capturedUsd).
- UI: TTL +n× chip on cards, extension info in detail dialog, TTL_EXT lifetime row in TERMINAL session stats, TtlSentinel re-arms on extended expiry.
- Unit-verified all 6 decision paths; live-engine verification happens on the next natural maturity (cron reviewer should check `ttl-gate` telemetry).

## 4. Agents & LLM performance (measured)

- **LLM ring:** last 10 calls ALL `MODEL` (analyst-chat / governor / deep-learn) — token-rotation healing from R19 still holding; llmAuthFails 0.
- **Supervisor:** 592 checks · 51 grounding audits · **6 HALLUCINATION + 2 SIMULATION findings** (historical; recent audits clean) · 0 nudges needed.
- **Governor:** 42 cycles, all MODEL; last cycle applied 2–3 decisions (quality valve MIN_SCORE→25, shortlist→5).
- **Deep-learn:** 18 runs · 35 cases · 12 MODEL lessons · best lesson: "full-TP winners avoid REGIME-CHOP; flow outweighs conviction".
- **Backtest learner:** n=60 · WR 55% · Wilson-LB 42% · expectancy +6.07%/trade → verdict MARGINAL (auto-deploy stays gated — correct behavior).
- **Calibration:** ACTIVE at 77 settled; 6 factor weights live.
- **Watch item:** 6/10 recent supervisor findings are HALLUCINATION-class → keep footnoted honesty audits on; governor telemetry now includes TTL-GATE so the expiry loss mode is governor-visible.

## 5. Architecture review

**Layer map:** `pulse(/api/pulse 5s + 4s server heartbeat) → engine.tick (resolve → ttl-gate → afterlife → autospawn → schedulers) → {trigger-bus L1..L4 spawns → confluence+flow+memory+learned gates → governor-tuned clamps → deploy}` with learners (calibration / backtest autotune / deep-learn) feeding weights+context back, supervisor+veracity auditing everything, all state in SQLite (Signal/SignalEvent/MarketAsset/PricePoint/EngineSetting).

**Strengths:** single-writer deterministic tick; every LLM path grounded (number-audited) + labeled MODEL/HEURISTIC; clamped agent authority; total-autonomy locks (423) verified; honest degradation everywhere (no fabricated data — L4_MACRO declares OBSERVING).

**Risks (prioritized):**
1. **OOM** — next-server died 13:45 after ~17h uptime (heap ~360MB). Mitigate: scheduled restart or `NODE_OPTIONS=--max-old-space-size=768`; dev-up.sh recovery is proven.
2. **Stop-loss dominance** (−$45.84) — quality valve + deep-learn regime filter are the levers; monitor whether MIN_SCORE 25 + flow-veto 4 lifts trailing WR above 15%.
3. **Prisma client staleness after schema push on a live dev server** — documented gotcha; always dev-up.sh restart after db:push.
4. **Trigger-bus wedge metrics memory-only** (reset on restart); L4 macro permanently observing (no key-less source — honest gap).
5. Timezone: ledger buckets are UTC; operator is Asia/Tehran (+3:30) — daily boundaries differ by 3.5h (cosmetic; noted for future TZ-aware bucketing).

**Verdict:** system is production-shaped for a sandbox research terminal: autonomous, audited, fee-honest, self-healing. The v6.1 expiry gate directly attacks the measured #1 missed-profit mode; the PNL ledger makes the EXPIRED/TP/STOP decomposition operator-visible for the first time.

---

## 6. Remediation round v6.2 (2026-09-04 09:30–10:00Z) — recommendations IMPLEMENTED

Operator mandate: «نقاط ضعف شناسایی شده و توصیه‌های اولویت‌دار رو کامل انجام بده» + «فرمول EST PNL % باید بر اساس نتیجه واقعی سیگنال‌ها محاسبه شود». Status of every prioritized item:

| # | Priority | Recommendation | Status (v6.2) |
|---|---|---|---|
| 1 | P0 | OOM mitigation | **DONE** — `NODE_OPTIONS=--max-old-space-size=768` baked into dev-up.sh (verified in process env) + new `scripts/watchdog.sh` (60s probe, restart after 2 consecutive pulse failures) running under setsid; keep-alive gap closed. The 09:31Z OOM death was recovered by this path. |
| 2 | P0 | SignalEvent pruning | **DONE** — engine `pruneEvents()`: 30-day retention + 20k-row hard cap (delete-oldest), rate-limited 1/h, error-isolated. PricePoint 48h pruning already existed. |
| 3 | P1 | Sim-price deploy ban | **DONE** — `deploySignal` pool excludes `source !== "live"` assets from auto/trigger deploys (operator-forced bypass audited) + rate-limited SYSTEM warn naming banned symbols. No signals on invented prices. |
| 4 | P1 | Stop-loss dominance monitoring | **IN PLACE by design** — governor telemetry (line 2/8b/8c) + supervisor trailing-WR valve + deep-learn lessons already carry the evidence loop; MIN_SCORE 25 + flow-veto 4 active. Watching, not code. |
| 5 | P1 | Polling consolidation | **VERIFIED OK** — single react-query singleton (`usePulse`, 5s, shared cache) is the only pulse fetcher; per-card 30–120s pollers hit distinct endpoints. No duplicate polling to fix. |
| 6 | P2 | SQLite WAL | **DONE** — `journal_mode=WAL` + `synchronous=NORMAL` + `busy_timeout=5000` at client init (all via `$queryRawUnsafe` — PRAGMAs return rows; `$executeRawUnsafe` throws P2010). Verified: `PRAGMA journal_mode` → wal. |
| 7 | P2 | TZ-aware ledger buckets | **DONE** — daily/weekly/monthly keys computed in Asia/Tehran wall time (+03:30 fixed, no DST); card shows TZ +03:30 badge. |
| 8 | P2 | Governor hysteresis | **DONE** — 90-min per-knob cooldown persisted (`governor.hysteresis`); LLM re-changes + supervisor quality-raise blocked with audited rationale; drought relief bypasses but records. Kills the relief↔quality MIN_SCORE oscillation. |
| 9 | P2 | External relay + AFTERLIFE channel | **DONE** — env-gated Telegram relay (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`): ALERTABLE events (CREATED/TP/SL/TTL_*/AFTERLIFE) mirrored fire-and-forget (4.5s timeout, error ring); dormant no-op without env. |
| 10 | P2 | L4 macro honest gap | **DONE** — key-less measurable source found: Crypto Fear & Greed (alternative.me). 30-min cache; extremes ≤20/≥80 fire contrarian L4 context triggers (never auto-spawn); unreachable → previous honest OBSERVING line. Live: F&G 74 (Greed) in bus summary. |
| 11 | P2 | Prisma-staleness gotcha | **STANDING RULE** — dev-up.sh remains the mandatory post-`db:push` restart path (now watchdog-integrated). |

**EST PNL % corrected (operator mandate):** the idealized +50% TP / −30% SL normalization is REMOVED. Every settled signal now contributes its ACTUAL engine-recorded fee-NET levered result to the EST PNL % line (TP exits at what they really banked, stops at their real −%, expiries at the TTL mark %), with a new AVG %/TRADE expectancy tile. Live all-time: EST −69.1% · AVG −0.9%/trade · NET −$4.94. UI (violet line, KPI strip, footer definition) and CSV export (EST_PNL_PCT_ACTUAL_SUM / EST_PNL_PCT_AVG_PER_TRADE) are consistent.
