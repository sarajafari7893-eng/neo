# NEXUS//SIGNALS — WIPE-RECOVERY RUNBOOK (v10.11, 2026-09-17)

Purpose: full system recovery after sandbox reset/wipe, using the @mytradeneo
channel as the off-site recovery space. This file + `recovery-restore.sh` +
`RECOVERY-INDEX.txt` are uploaded to the channel every snapshot cycle — they
survive sandbox death. AUTONOMOUS: no human is needed beyond two secrets.

## 0. SECRETS (never stored in this public channel — operator holds them)
- `TELEGRAM_BOT_TOKEN` — the @Neo_agentaibot token (operator's records / private chat with the bot)
- `BACKUP_PASSPHRASE` — AES-256 snapshot passphrase (operator's records; also
  referenced by `passphraseSha8` in MANIFEST.json to identify the right version)

## 1. WHAT THE SNAPSHOT CONTAINS (restorable state, AES-256-CBC PBKDF2-200k)
db/custom.db (VACUUM-consistent) · .env (0600, sha256-verified) · src · prisma ·
scripts · mini-services · docs · .zscripts · assets · Caddyfile · configs ·
bun.lock · worklog.md · dev.log · .data journals: shadow-veto rings (+rotated
.old), fourpack (+rotated), gate-journal, rawcal-telemetry, rawcal-run-
heartbeat, sv-cohort-freeze · backups/MANIFEST.json (git HEAD, db fingerprint,
env sha, row counts) · backups/calibration-latest.json (EngineSetting rows).

## 2. CHANNEL FILE CONVENTION (@mytradeneo)
- `nexus-snapshot-<stamp>.zip.enc` — full encrypted snapshot (archive copy)
- `nexus-snapshot-<stamp>.zip.enc.part-NNN` — 19MB split parts (bot-API
  re-downloadable; getFile caps at 20MB — parts are the AUTONOMOUS path)
- `env-<sha8>-<stamp>.enc` — versioned .env (same passphrase)
- `RECOVERY-INDEX.txt` — append-only machine index; LAST `====` block = latest
  (contains: encFile, encSha256, encBytes, parts[{name,fileId,sha256}])
- `recovery-restore.sh` + this runbook — the kit itself

## 3. RECOVERY ON A FRESH SANDBOX (autonomous, ~10 min)
1. From the operator get: bot token + passphrase + the latest RECOVERY-INDEX.txt
   (operator copies it from the channel on any device; or if the sandbox is
   merely degraded, it is at backups/RECOVERY-INDEX-latest.txt).
2. Fetch the kit from the channel (any Telegram client → save file) — or with
   the bot token via getFile using the file_ids inside the index.
3. Run:
     python3 scripts/recovery-restore.sh --from-channel RECOVERY-INDEX.txt
   It downloads the parts, reassembles, sha256-verifies, decrypts, unzips,
   restores db/.env/.data/worklog/scripts, and prints per-step PASS/FAIL.
4. Install + boot:
     cd /home/z/my-project && bun install && bunx prisma generate && bash scripts/dev-up.sh
5. Canary verify (all must be 200):
     pulse advisor terminal rawcal  →  http://localhost:3000/api/<route>
6. Watchdogs: bash scripts/watchdog-up.sh (if present) ; bridge relay on :3005
   comes up with dev-up; heartbeat tracker resumes at .data/rawcal-run-heartbeat.txt.

## 4. RECOVERY ON ANY LINUX BOX (deep inspection, no restore)
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in <part-joined.enc> \
     -pass pass:<BACKUP_PASSPHRASE> -out snapshot.zip && unzip snapshot.zip

## 5. POST-RESTORE VERIFICATION CHECKLIST
- [ ] MANIFEST.json db fingerprint matches restored db (calibration-snapshot.ts --fingerprint-only)
- [ ] /api/rawcal: armed state + target visible (state may be disarmed — re-arm is an operator decision)
- [ ] /api/ai/shadow-veto: armEpoch E-20260915, arms hydrated from rings
- [ ] /api/pulse: stats populated, engine ticking (3.5s cadence)
- [ ] bridge :3005/health armed=true, inbox polling fresh
- [ ] run one manual snapshot: bash scripts/backup.sh → SNAPSHOT OK line

## 6. CADENCE & GOVERNANCE
- Snapshots: every 3h (cron job 352556), 12 retained locally, dual off-site
  (operator private chat + @mytradeneo channel) since v3.3.
- The index is the single source of truth for which channel files belong to
  the newest restorable snapshot. Old blocks above the latest are history.
- Engine state (armed/target) is restored AS SNAPSHOTED; re-arming after a
  wipe requires an explicit operator mandate (observer never arms/disarms).
