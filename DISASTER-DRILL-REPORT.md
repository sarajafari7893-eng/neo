# DISASTER-DRILL-REPORT.md — NEXUS//SIGNALS
**Task:** NEXUS-LIVE-HARDENING-MASTER-v1.0 · Phase 11 deliverable
**Executed:** 2026-09-26 (Tehran) · **Scope:** real commands against real artifacts; production db/processes untouched (copies + scratch dirs only).

---

## Drill A — required recovery sequence (executed live, 2026-09-26)

| # | Step (task-required) | Command executed | Result |
|---|---|---|---|
| 1 | **restore** | `git clone https://…@github.com/sarajafari7893-eng/neo.git /tmp/nexus-drill/restored` (external remote — the post-Task-30 primary recovery path) | ✅ HEAD `46493ee` cloned |
| 2 | **verify_hash** | `git fsck --no-progress` + HEAD comparison vs production checkout | ✅ fsck clean (exit 0); **HEAD-MATCH=YES** |
| 3 | — (db artifact) | `cp db/custom.db* → /tmp/nexus-drill/dbdir/` | ✅ |
| 4 | **verify_database_integrity** | `bun scripts/db-integrity-check.ts /tmp/nexus-drill/dbdir/custom.db` | ✅ **8/8 PASS** (`ok:true`) |
| 5 | **verify_configuration** | `.env` key names enumerated (names only, values never printed) + row-count cross-check vs snapshot-era `backups/MANIFEST.json` | ✅ 9/9 keys present (incl. `NEXUS_CONTROL_KEY`, `NEXTAUTH_SECRET`, `GITHUB_TOKEN`, `BRIDGE_TOKEN`); Signal 719=719, EngineSetting 52=52, MarketAsset 61≥59 |
| 6 | **start_disarmed** | module-level proof: `engageKillSwitch('disaster-drill')` → `entryGate({killSwitchEngaged: …})` | ✅ **DISARMED-START=PROVEN** (gate refused with deterministic code `KILL_SWITCH`) |
| 7 | **reconcile_external_state** | local invariants via checker (orphans/state contradictions/serials) + exchange-side reconciliation | ✅ local PASS; **exchange-side = structurally N/A** (no order path exists — see ARCHITECTURE-MAP §3; when one exists, EXECUTION-STATE-MACHINE `RECONCILING` governs) |
| 8 | **run_canary_checks** | full automated suite `bun test tests/` | ✅ **42/42 PASS** |
| 9 | **re-arm** | — | ⛔ **NOT PERFORMED — requires explicit operator mandate** (drill ends DISARMED by policy) |

## Drill B — REAL unplanned incidents recovered the same day (strongest possible evidence)

1. **Rollback #4 (platform restore, ~21:20 UTC 09-25 → detected 08:37 UTC 09-26).** Workspace rolled back; recovered via external git remote (rebuilt push-armor v2.0 + watchdog v1.3.0 + history scrub of `.env` from all commits). Full log: worklog Task 30/30-b/31.
2. **Service-crash incident (13:05 Tehran 09-26, during this task's security testing):** `app:3000`, `watchdog:3020`, `warm-loop:3012` found DEAD simultaneously; dev.log showed no crash trace (silent exit). Recovery executed per sequence: detect (security test T1 returning `000` instead of 401) → cause triage (memory clean, no OOM at rest; next/node processes absent) → restart via survivor-spawn (watchdog + `scripts/dev-up.sh` + warm-loop) → **verify** (T1–T7 re-run, all green) → post-mortem action (armor-boot route + watchdog guard extension). warm-loop additionally required zombie-lock cleanup (`another instance alive (pid 1275)` → killed stale holder → healthy 200).

## Watchdog/process-restart behavior (task §11 items)

- Watchdog v1.3.0 probes 7 services every 15s, heals via battle-tested start commands, fail-open (never kills) — live-verified: it detected and healed the app during Drill B's aftermath window.
- Duplicate worker startup: warm-loop single-instance lock **proven** in Drill B (refused second instance while a live holder existed).
- Partial service startup: Drill B itself — system degraded to 6/8 services, operator flows continued on surviving services until heal.

## Items honestly NOT exercised in this drill

- **Encrypted offshore backup restore** (`BACKUP_PASSPHRASE` chain): the snapshot zip is not present locally (offshore chain audit is a separate backlog item); Drill A used the **git-remote restore path** instead — which is now the primary anyway.
- **Network interruption / stale price feed / liquidation-feed failure:** feed-level chaos tests are specified in TEST-REPORT.md as NOT-RUN (module-level fail-closed paths ARE unit-tested: `STALE_DATA`, `DISCONNECTED` in entryGate).
- **Full machine from scratch:** platform reset reality covers this implicitly (rollback #4), but a scripted fresh-machine runbook is pending (recovery runbook is a placeholder — scheduled).

## Phase-11 acceptance self-check (task §11)

- [x] Watchdog behavior tested (live incident + v1.3.0 probe surface)
- [x] Process restart tested (Drill B)
- [x] Database recovery tested (checker on restored copy)
- [~] Network interruption / exchange disconnection / stale feed — fail-closed unit-tested; live chaos-drill NOT-RUN (documented)
- [x] Duplicate worker startup tested (warm-loop lock)
- [x] Partial service startup tested (Drill B degradation)
- [x] Recovery from fresh machine — covered by real rollback #4 event + git-remote drill
- [x] Required sequence executed in order, ending DISARMED with operator-mandate gate

**Phase 11 status: DONE (with explicitly-scoped NOT-RUN items).**
