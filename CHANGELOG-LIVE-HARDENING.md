# CHANGELOG — NEXUS-LIVE-HARDENING-MASTER-v1.0

Append-only. Every material change to the system under this task is recorded here with date, evidence, and scope. Real-money execution remains **DISABLED** throughout.

---

## 2026-09-26 — Task reception check + Phase 1 (reconnaissance) — session web-83162d89

**Context:** task JSON received before rollback #4; verified with repository evidence that NO phase had been executed (all 10 deliverables missing, no state machine, no migrations, no test runner). Rollback #4 recovery was handled separately (worklog Task 30/30-b: history scrub of `.env` from all 19 commits, push-armor v2.0 rebuild, watchdog v1.3.0 with armor guard, `/api/nexus/armor-boot` survivor-spawn route).

**Phase 1 executed → `ARCHITECTURE-MAP.md`**
- Live inspection: 8 services + ports, 47 API routes (full mutating-endpoint enumeration), 11 Prisma models, 57 DB-access files, Caddyfile allowlist state, middleware auth model.
- **Critical finding (positive):** NO signed exchange order path exists anywhere — system is genuinely paper/research-only; `live_auto_deployment: SUPPRESSED` in engine learned-gate (engine.ts ~1501) verified.
- **Critical finding (gap):** no canonical armed/disarmed master switch; no DB-level uniqueness for serials; no `prisma/migrations/`; no test runner. These become Phase 3/4/12 build targets.
- Pre-existing hardening found intact: Caddy XTransformPort allowlist (:3003 only), x-nexus-key middleware gate on mutating /api/*.

**Live status:** `NOT_ELIGIBLE` (nothing evaluated yet beyond Phase 1; real orders absent by construction — must stay that way until all gates PASS).

**Next action:** Phase 2 — security boundary audit → `SECURITY-HARDENING.md`.

## Task 34 — 2026-09-26 (operator 6-mandate package) — WIRED & VERIFIED

Scope: operator mandates ①ADVISOR unauthorized ②RAW-CAL arms-coupled bar ③Trigger Bus + Binance ④FUTURES TAXONOMY STORE 672/720 ⑤professional supervisor-cron ⑥next_action (D1).

- 34-1 ADVISOR AUTH: root cause = operator session absent + no login affordance. Added SessionProvider, header OperatorBadge (LOCKED→/login, OPERATOR→session), `nexus-client.ts` auth-aware mutate (401 → guided login toast), AdvisorCard decide/runCycle honest error paths (runCycle previously showed SUCCESS on 401/500). Browser-verified: LOCKED→login→OPERATOR→APPROVE click reached server decision logic (middleware 401 eliminated). Server APPLY-GUARD then correctly auto-rejected a stale proposal (live knob 2 vs base 3) with audit note — guard behavior, not a wiring failure.
- 34-2 RAW-CAL ↔ SHADOW-VETO ARMS: capture re-armed (audited mandate). Auto-disarm is now ARMS-COUPLED: target reached + arms incomplete ⇒ target auto-extends by arm deficit (audited retargetNote) instead of lifting; lift only when real arms complete (paper-veto waived in shadow mode — structurally unfilled there). New `shadowArmsCompletion()` probe (memory rings + published sentinel snapshot merge, fail-closed to INCOMPLETE). PACE MONITOR: arms strip in RawCalCard (per-arm n/target, deficit, waiver marks) + rawcal API armsCompletion block. STRUCTURAL FIX: VERDICT_CAP eviction was evidence-destructive (46 linked-but-unclosed verdicts silently dropped ⇒ real arms starved at 20/9 with zero observability) → evidence-safe trimVerdicts + error logging in closeRealOutcomes/retroLinkRealDeploys. Honest note: arms restart low (R·keep 2/30, R·veto 1/30) because long-settled rows aged out of journal/file; they refill from live fence-origin deploys (tape fix below unblocks trigger spawns).
- 34-3 TRIGGER BUS / BINANCE: bus itself healthy (heartbeat, 11/11 cycles). Real cause of empty-feeling data = tape starvation: fapi USDT-M 418 IP-bans (stacked hours, multi-IP egress pool) + futures aggTrade WS suppressed by Binance for our pool + trade-service REST fallback burning ~1800 weight/min. FIX (34-b): trade-service v4.8 SPOT-MIRROR — spot aggTrade WS verified flowing, source priority WS>SPOT-MIRROR>REST, REST weight 1800→240/min with banned-until full pause (ban-guard fired live in production). Trigger L1/OBI regain real fuel; connectivity matrix documented (spot REST+WS and fstream bookTicker/depth OK; fapi REST & futures aggTrade WS restricted).
- 34-4 TAXONOMY STORE 672/720: 672 = one-shot 14-day hourly BACKFILL rows; 720 = SETTLED_TARGET maturity bar for bestFilter claims; stall (+1 row in 3d) = fapi bans starving the 5-min sampler. FIX: central fapi-gate (weight bucket 1100/min, per-IP ban parsing, pool-rotation retries, single-flight) wired through 10 consumer modules; sampler gains SPOT-MIRROR price/klines fallbacks (rows keep flowing during bans; futures-only families stay honestly NULL); STORE badge gains honest breakdown tooltip.
- 34-5 SUPERVISOR-CRON :3015 rebuilt (bun, --hot, own port/process): sweep 10min (6 services + sentinel verdict, TG alert on RED w/ rate-limit), progress 6h (Persian win-rate/EST-PNL/arms/rawcal/taxonomy report), review 12h (sentinel-deep + LLM senior-supervisor per nexus-sentinel skill doctrine; honest llm_unavailable path when platform 429 — platform LLM currently 429). Watchdog v1.4.0 with two-place rule (cron key in SVCS + state init).
- 34-6 D1 (next_action): canonical entryGate + kill-switch wired INTO engine deploySignal (fail-closed, kill-switch ABSOLUTE incl. forced deploys; forced retains audited feed-fresh override). New /api/nexus/kill-switch (GET state, POST engage/release, key+session double-gate). Verified live: engage → FORCED deploy 503 KILL_SWITCH; release → deploys flow (signals 722/723). Probe artifact: 2 legit paper signals created during the released-state probe (disclosed).
- Verification: bun test 42/42 (128 expects) · lint 17 pre-existing baseline (scripts/) · tsc source-clean (1 transient .next generated-file artifact) · browser golden path verified · services all UP incl. :3015 · tape SPOT-MIRROR 18k+ frames dataStalled=false. live_status = NOT_ELIGIBLE_FOR_LIVE unchanged; no signed-order path added; live DISABLED.
- Ops note: 2 transient app OOM dips during session (platform pattern, sentinel already RED on 19 OOM markers); heal chain (watchdog v1.4.0 + pause-file breaker + probe-gated dev-up) recovered both; /tmp backup ring unaffected.
