# Five-Panel Feedback-Loop Audit — 2026-09-07 (post-restore)

Scope: the five operator surfaces of NEXUS-LIVE and whether each one's data
flows form closed loops (panel → API → DB → telemetry → governor/learner → engine).
Executed after the Sep-5 snapshot merge (137 signals) on v6.3 + VOL-ONSET.

## Panel read map

| Panel | Reads | Freshness | Verdict |
|---|---|---|---|
| HeroPanel | usePulse(15s) → /api/pulse (stats, feed, market) | 15s | ✅ live |
| MARKET MATRIX (MarketMovers) | pulse market data (props) + VolOnsetRadar → /api/vol-onset | 5s / 60s (90s server cache) | ✅ live — vol-onset cold 1.09s, warm 42ms |
| Signals (SignalsSection + cards + detail dialog) | usePulse(5s) + /api/signals (cap 100/page) + /api/signals/[id] PATCH + /api/ai/signal-scan + /api/market/history | 5s | ✅ live |
| Terminal | usePulse + /api/events?limit=120 (SignalEvent stream) | 5s + 120-event window | ✅ live |
| Analytics + AI Core | usePulse + /api/ai/analyze · /api/ai/chat · /api/ai/governor · /api/backtest · /api/ai/memory · /api/ai/agent · /api/settings · /api/ai/signal-scan · /api/ai/deep-learn · /api/notify | 5s + card polls | ✅ live |

## Feedback loops measured LIVE (EngineSetting updatedAt, all fresh at audit time)

| Loop | Path | Evidence (2026-09-06 23:2x–23:3x UTC) |
|---|---|---|
| L1 Calibration | settles → profit ledger → factor weights → engine | `calibration` settled=132, criterion NET-PNL-EXPECTANCY, ACTIVE ✅ |
| L2 Regime | close → bumpRegimeTelemetry → REGIME LEDGER → thrAdj/guard | `regime.telemetry` CHOP n=4 / TREND-UP n=1 ✅ (counters will grow with new settles) |
| L3 Governor | LEDGERs → LLM decisions → gate knobs | `governor` cycles=78 + hysteresis + log; gate.minScore=45 ✅ |
| L4 Backtest/Learner | replay → sweep → adopt-if-better → weights | `backtest.autotune` adoptedAt 23:32Z ✅ |
| L5 TTL gate | expiry attempts → extend/deny ledger → TTL decisions | extended=35, capturedUsd=10.1, denied=17 ✅ |
| L6 VOL-ONSET learning | tagged settles vs rest → radar footer | settled=132, tagged=0 (awaiting first tagged settle — honest) ✅ |
| L7 Deep-learn | outcome patterns → lessons → prompts | runs=40, casesLearned=69 ✅ |
| L8 Supervisor | self-monitoring findings | checks=1349, findings logged ✅ |
| L9 Operator journal | card NOTES → PATCH → ??? | **WAS OPEN-ENDED — FIXED (see F2)** |
| L10 Telegram relay | fireEvent → notify → operator chat | /api/notify 200, chatId persisted; E2E proven Sep 5 (R28) ✅ |

## Findings & actions

- **F1 (fixed)**: `scripts/filter-calibration-audit.ts` / `vol-onset-detect.ts` /
  `verify-calibration-claim.ts` had no module scope → duplicate `FAPI` broke
  project-wide `tsc --noEmit` (bun runtime unaffected). Added `export {}` — tsc clean.
- **F2 (fixed — the loop audit's main catch)**: operator journal was write-only
  for the AI. Notes were saved (PATCH verified 200 + DB readback) and shown on
  cards, but no AI path consumed them. Closed both ends:
  - `analyst-context.ts`: new `OPERATOR JOURNAL` grounding line (last 5 notes,
    symbol + text) → chat/analytics answers now acknowledge operator notes.
  - `/api/ai/signal-scan`: per-card context now carries `operatorNotes`.
- **F3 (fixed earlier same day)**: dashboard clock drift — all TTL countdowns/ages
  were client-clock based. Server-anchored clock shipped (pulse `ts` → EMA offset;
  `useNow`/`serverNow`), Header shows a SYNC badge only when drift ≥ 2s.
- **F4 (ops risk, mitigated)**: next-server was OOM-killed during heavy parallel
  dev tooling (tsc ×2) on the 4GB box. `dev-up.sh` heap cap (768MB) held on
  restart; discipline recorded: avoid parallel heavy tsc/eslint while engine runs.
- **F5 (observation)**: vol-onset cold recompute 1.09s vs 42ms cached — healthy
  with the restored corpus (132 settled); no action.

## Verdict

All five panels read live engine data; ten feedback loops traced, nine were
already closed and live, one (operator journal → AI) was closed in this audit.
No broken read paths, no stale-data panels found post-restore.
