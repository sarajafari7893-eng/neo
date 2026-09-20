# NEXUS//SIGNALS — AUDIT WORKLOG (shared)

---
Task ID: 1+2
Agent: Z.ai Code (lead senior engineer)
Task: Receive operator backup upload, verify integrity, decrypt snapshot for inspection-only audit

Work Log:
- Operator uploaded 8 files to /home/z/my-project/upload (RECOVERY-INDEX-latest.txt, RECOVERY-RUNBOOK.md, recovery-restore.sh, calibration-latest.json, backup passphrase file, snapshot .enc + 2 parts)
- Verified sha256 of full archive (3eb22090… matches index) and both parts (b2faa3e8…, cc3b12be… match) — integrity PASS
- Decrypted AES-256-CBC/PBKDF2-200k with operator passphrase into /home/z/audit-staging (NOT restored into project — operator approval pending)
- Extracted snapshot (60MB): src/, prisma/, scripts/ (180 files), mini-services/ (5), docs/, .data/ journals, db/custom.db, .env, worklog.md (1.7MB), dev.log, MANIFEST.json (gitHead 775b14ec, 611 signals / 20767 events / 111673 price points / 37 assets)
- Identified system: NEXUS//SIGNALS v10.15 AI trading-signal terminal (Next.js 16 + Prisma/SQLite + 5 bun mini-services + Telegram bridge + two-layer watchdog)

Stage Summary:
- Snapshot integrity verified, staged read-only at /home/z/audit-staging/snapshot
- No execution/restoration performed — awaiting operator approval
- Deep audit dispatched: 3-a tracking, 3-b wiring, 3-c core intelligence, 3-d architecture/ops

---
Task ID: 3-a
Agent: Explore (tracking audit)
Task: READ-ONLY audit of tracking subsystem (Signal lifecycle, settlement, TTL, afterlife, pump radar, events, PricePoint)

Work Log:
- Read engine.ts fully (2264 lines), verdict/accounting/ttl-gate/seq-stop/lifecycle-learning/pump-dump/backtest, prisma schema; inspected SQLite read-only
- Mapped tick loop (3.5s), settlement priority chain, tranche-weighted v6.6 NET accounting, afterlife 48h window, pump radar stage-1/2 + honest criterion, event retention (30d/20k policy)

Stage Summary:
- P0: settlement can run on simulated/random prices when feed degrades (sim fallback consumed by resolveSignals/trackAfterlife/pumpTick without source check)
- P1: spot-vs-perp basis (settlement on spot median for perp signals; BINANCE venue price always null); backtest not parity with live rules (TP3 overstated ~68%, no tranche/BE-trail); SignalEvent 20k cap truncates history to ~19h; missing signalId index; PumpTrack leak on universe exit; serial race; Float money; tag editor can erase cohort tags
- Strengths: tranche math correct, honest pump scoring, seq-stop textbook, deploy honesty rails, restart-tolerant gates

---
Task ID: 3-b
Agent: Explore (wiring audit)
Task: READ-ONLY audit of wiring/infra (mini-services, watchdogs, gateway, telegram, crons, journals, heartbeats)

Work Log:
- Audited all 5 mini-services (ports 3003/3005/3010/3011/3020), dev-up.sh, watchdog.sh v3.1, boot-kit.sh, Caddyfile, telegram-bridge.ts poller (instrumentation.ts), notify.ts, .data journals, cron job inventory from worklog

Stage Summary:
- P0: control plane unauthenticated (57 routes; only optional BRIDGE_TOKEN which is unset) + Caddy XTransformPort forwards to ANY localhost port (bridge send/inbox, watchdog pause, rawcal arm/disarm exposed)
- P1: cold-boot recovery depends on platform-level crons (no IaC in repo); memory headroom thin (RSS up to 2912MB on 4GB no-swap, alert-only); layer-1 watchdog lacks circuit breaker; pause contract covers app only (sidecar heal races)
- P2: bridge ndjson unbounded + full re-parse per request; /api/pulse many-hats chokepoint; hardcoded /home/z/my-project in 56 files; dev.log unrotated
- Verdict: excellent process-level self-healing (two-layer watchdog + pulse re-arm); cold-boot is operator/cron-dependent; filesystem is weakest link

---
Task ID: 3-c
Agent: Explore (core intelligence audit)
Task: READ-ONLY audit of AI/decision/learning stack (ai.ts, governor, advisor, gates, shadow-veto, near-miss, rawcal, memory, statistics)

Work Log:
- Read all ~35 intelligence modules in full incl. shadow-veto.ts (1528 lines), gate-settings/gate-journal, calibration, seq-stop, strategy-probation, raw-cal/rawcal-quality; cross-checked live .data journals and telemetry

Stage Summary:
- Strengths: LLM cannot move money directly (clamps + veto-only + operator approval verified across 7 call sites); veracity/grounding audits real; seq-stop + EB-shrinkage probation genuinely rigorous; counterfactual paper cohorts for every rejection layer; anti-lockup engineering measured
- P1: R6 calibration unfroze on censored book (informative 43.4% AMBER but n-count lift fired); edge pockets trade at n>=6 with +8..10 score bonus (multiple-comparisons); capture-observe pollutes shadow-veto A/B arms; real-arm feed leak (125 unlinked PASS verdicts >24h)
- P2: governor loosens gate on bad BACKTEST; prompt bug (maxActions literal); inconsistent WR definitions; no zod/max_tokens on LLM JSON; time-governor 24 buckets at n=8; in-memory LLM budgets
- Statistical verdict: instrumentation real and honest, but learning is currently hypothesis-generating machinery wearing hypothesis-testing clothes; ~10 independent loops, no unified error budget; base process marginal (raw WR 18.7%)

---
Task ID: 3-d
Agent: Explore (architecture/ops/security audit)
Task: READ-ONLY audit of architecture, ops history forensics, backup/recovery, security, resilience

Work Log:
- Read docs, worklog forensics (14381 lines; 12 major incidents incl. 2 OOMs, 2 platform rollbacks, ENOSPC, SST corruption x3, secrets-scrub), dev.log tail (7376 lines), backup.sh v3.4 chain, recovery-restore.sh, hygiene scripts, .env keys (masked), versioning

Stage Summary:
- P0: dev server (next dev + Turbopack) is the production runtime — root cause of OOM/ENOSPC/split-brain incident class
- P1: recovery-restore.sh cannot actually restore a wiped tree (never copies src/prisma/package.json/mini-services); restore-drill.sh path regression (reads backups/ but ring moved to /tmp); Telegram single-provider SPOF for off-site+commands+alerts; self-referential passphrase chain, no rotation
- Security top5: unauthenticated mutating API; open localhost proxy; soft Telegram operator identity (impersonation path after env loss — already happened 0912); single-passphrase self-encrypted chain; healthz info disclosure
- Resilience: MTTR process-level 30s-2min auto; platform rollback ~1h; full wipe 1-3h manual; SPOF #1 = single sandbox (4GB no-swap)
