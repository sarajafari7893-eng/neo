# ARCHITECTURE-MAP.md — NEXUS//SIGNALS
**Task:** NEXUS-LIVE-HARDENING-MASTER-v1.0 · Phase 1 deliverable
**Written:** 2026-09-26 (Tehran) · **By:** Z.ai Code (session web-83162d89) · **After:** rollback #4 recovery (Task 30)
**Method:** live inspection of the actual repository (not from memory). Evidence commands cited inline.

---

## 1. Process inventory (stateful services)

| Process | Port | Role | State held | Exchange-facing? |
|---|---|---|---|---|
| Next.js dev (`next dev`, Turbopack) | 3000 | Dashboard + control-plane API (~47 routes) | Prisma/SQLite (`db/custom.db`), `.data/*` | Read-only market fetch |
| price-ws (mini-services/price-ws) | 3003 | socket.io price stream relay | in-mem ring buffers | Binance WS (public, key-less) |
| telegram-bridge | 3005 | TG ⇄ NEXUS bridge, TQ queue + ACK | `.data` queue files, sqlite | Telegram API only |
| liq-service | 3010 | liquidation feed | in-mem + telemetry | Binance WS (public) |
| trade-service | 3011 | **REAL aggressor tape** → CVD / divergence / VPIN (v4.7 dual-ingest WS+REST) | in-mem 120-min buckets | Binance **public** streams only |
| warm-loop | 3012 | engine cadence driver (sampling/settlement uniformity) | `.data/warm*` | none (drives engine internally) |
| push-armor v2.0 | 3016 | external git armor: auto commit+push to `github.com/sarajafari7893-eng/neo` every 10 min; preflight secret-leak guard | `.data/push-armor/state.json` | GitHub (token via in-memory header) |
| p0-watchdog v1.3.0 | 3020 | probes 7 services every 15s, heal-spawn; fail-open (never kills) | `.data/p0-watchdog/*`, sqlite | none |
| sentinel-service | 3030 | deep system audits, verdict AMBER/GREEN, backups | `.data/sentinel/*`, sqlite | none |

**Boot reality (post Task 30):** services are spawned by the platform boot (mini-services/* dirs) and/or by watchdog heal-spawn / `POST /api/nexus/armor-boot` (survivor-spawn from the Next.js process). Processes spawned from agent tool-shells die at call end — documented constraint.

## 2. API surface (src/app/api — 47 routes)

**Mutating (POST/PUT/PATCH/DELETE) — full enumeration for Phase 2:**
`bridge` POST · `bridge/send` POST · `bridge/read-all` POST · `terminal` POST · `verdict-core` POST · `settings` PUT · `telegram/bridge` POST · `notify` POST · `futures` POST · `governors` POST · `signals` POST · `signals/[id]` PATCH · `rawcal` POST · `advisor` POST · `strategy-weights` POST · `backup` POST · `modules` POST · `ai/deep-learn` POST · `ai/signal-scan` POST · `ai/neural-link` POST · `ai/shadow-veto` POST+telemetry POST · `ai/governor` POST · `ai/analyze` POST · `ai/chat` POST · `backtest` POST · `nexus/armor-boot` POST (x-nexus-key double-gated, Task 30)

**Auth model (src/middleware.ts):** mutating `/api/*` requires `x-nexus-key === NEXUS_CONTROL_KEY` (env, constant-time). GETs pass. → Phase 2 must verify per-endpoint *authorization depth* (key gates mutation, but any GET that mutates indirectly via side effects must be audited).

**Reverse proxy (Caddyfile):** `:81` → Next :3000; `XTransformPort` query forwarding is **allow-listed to :3003 only**, every other value → 403. *Prior hardening survived rollback; re-verify with runtime tests in Phase 2.*

## 3. Exchange-facing code — ORDER PATH AUDIT (critical finding)

Greps executed: `fapi|/order|TESTNET|signature|BINANCE.*KEY|createOrder` across `src/lib/`, `src/app/api/`, `mini-services/`.

- **NO signed order-submission path exists.** No HMAC signing, no `/fapi/v1/order` POST, no API-key/secret use anywhere in the tree. ✅ consistent with `live_auto_deployment: SUPPRESSED`.
- Exchange-touching libs are **read-only market data**: `market-feed.ts`, `flow-scanner.ts`, `oi-funding.ts`, `liq-heatmap.ts`, `whales.ts`, `multi-exchange.ts`, `futures-taxonomy.ts`, `vol-*`, `research-factors.ts`, `accounting.ts` (modeled), `backtest.ts` (modeled).
- `trade-service` consumes **public** aggTrade stream (WS + REST fallback) — tape analysis, not trading.
- **Consequence for Phase 4:** the execution state machine must be *built* (signal→…→CLOSED) as a dry-run/paper-capable module with an explicit `real_orders_enabled=false` hard flag; there is currently nothing to harden on the real-order path — the path itself is absent, which is the correct starting state.

## 4. Paths that change trading behavior (behavior-mutation surface)

1. `src/lib/engine.ts` — the signal engine; learned-gate auto-deployment suppression (lines ~1501–1505: `auto-deployment SUPPRESSED — … operator-forced deploys bypass`); G4 probe re-arm logic.
2. `src/app/api/settings` PUT + `src/app/api/ai/settings` PUT — runtime settings mutation (x-nexus-key gated).
3. `src/lib/governor.ts` + `/api/governors` POST — governor rules journal.
4. `src/lib/raw-cal.ts` (TARGET 1000) + `/api/rawcal` POST — RAW-CAL retarget.
5. `src/lib/strategy-weights` + `/api/strategy-weights` POST — weight mutation (⚠️ Phase 8 target: freeze/governance).
6. `src/lib/advisor.ts` + `/api/advisor` POST — advisor proposals.
7. `src/lib/shadow-veto.ts` — shadow adjudication (paper-only, evidence rails).
8. `src/lib/env-guard.ts` — environment guard rails.
9. **LLM layer** (`src/lib/ai.ts` + `/api/ai/*`): 429 budget-shield degrades to heuristic fallback (observed live in dev.log). Phase 9 must verify: LLM output ⇒ research/explanation only, zero execution authority. Current code has no LLM→order path (nothing to place orders with) — preserve this invariant.

## 5. Armed / disarmed state — every read & write point (evidence: grep `armed|disarm|SUPPRESSED`)

| File | Nature |
|---|---|
| `src/lib/engine.ts:1501,1505` | WRITE+READ: auto-deployment suppression (learned gate), operator-forced bypass exists ⚠️ |
| `src/lib/raw-cal.ts` | READ: RAW-CAL gate state |
| `src/lib/governor.ts` | READ/WRITE: governor allow/deny state |
| `src/lib/env-guard.ts` | READ: environment safety guards |
| `src/lib/near-miss.ts`, `shadow-veto.ts` | paper-only gates (no live effect) |
| `src/lib/lifecycle-learning.ts` | READ/WRITE: learning lifecycle state |
| `src/lib/triggers.ts` | READ: trigger arming conditions |
| `mini-services/warm-loop` | cadence arming of engine ticks |
| `.data/fourpack-*`, `.data/gate-journal.jsonl` | persisted gate/verdict journals (append-only-ish) |

⚠️ There is **no single canonical `armed/disarmed` master switch**. The task's Phase 4 "independent kill-switch" must introduce one, plus fail-closed semantics on unknown state.

## 6. Database & shared resources

- **Prisma/SQLite** `db/custom.db` (+`-wal`/`-shm`), 11 models: `Signal, AdvisorProposal, SignalEvent, AgentThought, MarketAsset, EngineSetting, PricePoint, FlowScan, VolCauseEvent, FuturesSnapshot, PumpTrack`.
- **57 files** access DB (`@/lib/db` or `bun:sqlite`); raw sqlite in `p0-watchdog`, `sentinel-service`, `telegram-bridge`.
- **NO `prisma/migrations/`** — schema is push-synced (`bun run db:push`). Phase 3 must introduce migration-based change control.
- **No DB-level uniqueness on signal serials** (to verify precisely in Phase 3; concurrency-safe serial generation unproven).
- Shared state files: `.data/*` (telemetry/journals/backups), `.env` (secrets, chmod 600, **now untracked + scrubbed from all git history** — Task 30), git repo w/ external remote (armor).
- Watchers of shared files: engine + warm-loop + sentinel + watchdog (concurrent `.data` writers — Phase 3/12 concurrency tests target).

## 7. Schedulers / background workers

- In-service loops: liq, watchdog, price-ws, push-armor (10 min), sentinel, trade-service (all `setInterval`).
- Engine cadence: driven by warm-loop (:3012) + 2 intervals in `engine.ts`.
- **No OS-level cron** on the sandbox; `supervisor-cron :3015` and TG 6h report are LOST components (see worklog Task 30 / backlog C) — rebuild decision belongs to Phase 11/12 scoping, not silently.

## 8. Recovery assets (survived rollback #4)

`RECOVERY-RUNBOOK.md` (placeholder — needs real content in Phase 11), `backups/MANIFEST.json` + `backups/calibration-latest.json`, sentinel backup chain, push-armor external remote (the ONLY real anti-restore armor).

---

## Phase-1 acceptance self-check (task §1)

- [x] All applications/services/schedulers/API routes/DB paths/workers/watchdogs/adapters/exchange-facing code mapped
- [x] Stateful processes + shared resources enumerated
- [x] Behavior-changing paths enumerated (§4)
- [x] Order submit/modify/cancel paths enumerated — **finding: none exist (paper/research only)** (§3)
- [x] Every armed/disarmed read/write point listed (§5)

**Phase 1 status: DONE (evidence-based).** Next: Phase 2 security boundary audit (middleware per-route auth-depth matrix, Caddy runtime verification, CSRF/CORS/replay, secret staging hygiene) → `SECURITY-HARDENING.md`.
