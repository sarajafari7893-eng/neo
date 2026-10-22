# NEXUS//SIGNALS — CRON REGISTRY (P1-9, task 5-d, 2026-09-20)

**Why this file exists (audit 3-b / P1-9):** the platform cron jobs live OUTSIDE the
repo (platform scheduler tool, not in any sandbox file) and were repeatedly LOST or
silently re-pointed across platform rollbacks and restores — 349943/352567/353472
(webDevReview lineage), 367116→369735 (monthly drill) all had to be re-created by
hand, and job 364970 shipped with a broken hour field. This registry is the
source-of-truth inventory for **recreation after a wipe**. IDs marked **verify**
must be confirmed against the live platform cron list before trusting them.

> NOTE: nothing in this repo *schedules* anything — the platform scheduler does.
> When recreating, copy `kind`, `expr`/cadence, `tz` and the payload text EXACTLY,
> then watch one fire before declaring done.

## Job table

| Job ID | Name | Schedule (tz) | Kind / payload | Last-known behavior | Status |
|---|---|---|---|---|---|
| **354312** | NEXUS keep-alive ping | every 15min @ :00:30/:15:30/:30:30/:45:30 Asia/Tehran | probe turn: GET :3000/api/pulse (drives engine scan tick) + :3010/health + :3003 price-ws; retry-once; error triage (dev.log tail → dev-up.sh if down) | Working; fires every 15min, app:200 liq:200 ws:400(expected). Powers the engine heartbeat AND the watchdog self-arm hook (`/api/pulse` → `ensureP0Watchdog`). | active (verify id) |
| **352556** | auto-backup snapshot | every 3h, Asia/Tehran | agentTurn → `bash scripts/backup.sh` (v3.4: full-tree zip → /tmp/my-project/backups, AES-256 .enc, off-site + @mytradeneo channel parts + RECOVERY-INDEX, SNAP-RESTART canary) | Working; last good snapshot on PolarFS ring. Aborted loudly 10:30Z Sep-19 on disk floor (fail-loud by design). | active (verify id) |
| **368159** | disk hygiene | daily 03:14 Asia/Tehran | one-line turn → `bash scripts/cache-hygiene.sh` (thin wrapper → `scripts/disk-hygiene.sh`), reports one line | Working; wrapper kept for this job's compatibility. | active (verify id) |
| **376843** | telegram-bridge-watch | every 30min | agentTurn: read :3005 unread inbox (now token-gated: `x-bridge-token`/`?token=`), act on operator directives, reply via bridge, heal app if bridge heartbeat stale | Working; this is the channel that pulls operator messages into a work session. | active (verify id) |
| **380065** | RAW-CAL pace watcher | every 30min | agentTurn: probe pulse, GET /api/rawcal, parse armed/settledN/openRaw/issuedTotal/cadence/issue3h/spacing/eta; milestone + stall (issueStallMin) + lift-fail triggers → ONE Persian Telegram alert, else SILENT; append worklog section | Working (post-completion cycles SILENT when disarmed). | active (verify id) |
| **384822** | RAW-CAL run watch (supervised capture-run) | ~30min (verify exact cadence — observed fires at :01/:31+) | agentTurn: GET /api/rawcal + shadow-veto arm evidence; alerts on real-arm count increase, openRaw cap, stalls; 2h heartbeat tracker; anti-spam (no re-send for already-reported triggers) | Working; SILENT post-run-complete. | active (verify id + cadence) |
| **364970** | daily report | daily 00:00 Asia/Tehran (recreate with expr `0 0 * * *`, tz Asia/Tehran) | agentTurn → `POST :3000/api/report/daily?force=1` (photo + Persian digest) | **KNOWN BAD SCHEDULE**: shipped with hour field lost → fired HOURLY at :30:01. Route-level dedup guard (v6.4.4 forceBlocked) holds duplicates to zero; do NOT remove the guard if the misfire recurs. Reschedule needs the platform cron tool. | active, schedule broken (verify id) |
| **387205** | webDevReview | every 15min fixed_rate (verify current id — lineage: 349943 → 352567 → 353472 → 358070 → 368281 → 381810 → 387205) | kind=`webDevReview`, standing operator mandates embedded + MEMORY-BUDGET addendum (skip chrome when MemAvailable <900MB, run `disk-hygiene.sh --force` first; NEVER restart while :3000 answers; NEVER `bun run build`) + :81-gateway testing note | Working; recreated 2026-09-15 after keep-alive msg referenced stale 353472. | active (verify id) |
| **387118** | SUPERVISOR deep-audit | fixed_rate 14400s (4h) | agentTurn: deep-read modules + web research, append terminal thoughts, Telegram ONLY on material findings, never mutates trading state | Working. | active (verify id) |
| **369735** | monthly RESTORE-DRILL | 1st of month 06:00 Asia/Tehran (`0 0 6 1 * *`) | agentTurn → `bash scripts/restore-drill.sh`; demands PASS or fix-and-rerun; Telegram PASS report | Earlier id 367116 lost in a resync → recreated as 369735. Verify current existence after each rollback. | **verify** (may be lost) |

## Recreation checklist (after wipe / rollback)

1. **List the live platform crons** and diff against this table — recreate only what is missing; never duplicate a live id.
2. **Recreate in this order** (dependency-driven):
   - `354312` keep-alive 15min (it arms the watchdogs via `/api/pulse` and is the heartbeat everything else assumes);
   - `352556` backup 3h (protection of the restored state);
   - `368159` disk-hygiene daily (ENOSPC class guard);
   - `376843` bridge-watch 30min (operator's inbound channel);
   - `380065` + `384822` rawcal watchers (only while a capture-run is relevant);
   - `364970` daily report — **expr `0 0 * * *`, tz Asia/Tehran** (historically mis-authored: verify the hour field survives);
   - `387205` webDevReview 15min (paste the standing mandates + memory-budget addendum verbatim);
   - `387118` SUPERVISOR 4h;
   - `369735` monthly drill (`0 0 6 1 * *` Asia/Tehran).
3. **Copy payloads verbatim** — each job's payload text embeds operator mandates (Persian directives) that were accumulated over incidents; a paraphrased payload loses them.
4. **Watch one fire per job** and confirm its worklog section appears (each watcher appends a `Task ID:` block).
5. **Update this registry** if an id changed — this file is append/update-on-evidence, keep the lineage column honest.
6. Bridge-watch note: since task 5-d the :3005 relay requires `x-bridge-token` (or `?token=`) with `BRIDGE_TOKEN` from `.env` on `/send`, `/inbox`, `/read`; `/health` stays open. Watchers that read the inbox must send the header.

## Historical lost-id ledger (evidence for "verify" flags)

- webDevReview: 349943 (lost) → 352567 → 353472 (lost) → 358070 → 368281 → 381810 → **387205** (2026-09-15).
- monthly drill: 367116 (lost in resync) → 369735 → current **verify**.
- daily report 364970: schedule bug documented 2026-09-07 (`CRON-364970-HOURLY-MISFIRE-0907`, `CRON-364970-GUARD-V2-0907`).
- keep-alive 354312 incident log: `354312-incident-20260904-1345` (OOM while ping-OK — ping ≠ health; keep the triage step).
