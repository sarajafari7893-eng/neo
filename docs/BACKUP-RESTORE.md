# NEXUS//SIGNALS — BACKUP & RESTORE RUNBOOK (v6.7.3)

Operator-approved package: suggestions 1+2+3+4 + `.env` included (persian: «پیشنهادهای 1+2+3+4 رو انجام بده .env رو هم بزار»).

## What is backed up (every 3h — cron job 352556 → `scripts/backup.sh`)
| Layer | Content |
|---|---|
| Code + config | `src/` `prisma/` `scripts/` `mini-services/` `docs/` `.zscripts/` `Caddyfile` `package.json` `bun.lock` tsconfig/next/postcss/eslint/components configs |
| **Secrets** | `.env` (TELEGRAM_BOT_TOKEN, BACKUP_PASSPHRASE, DATABASE_URL) — **archive is encrypted**, see below |
| State | `db/custom.db` (signals, ledger, EngineSettings = live calibration, events, AI reports) · `worklog.md` · `dev.log` |
| Intelligence | `backups/MANIFEST.json` (git HEAD, content fingerprint, row counts) · `backups/calibration-latest.json` (ALL EngineSetting rows, diffable calibration history) |

## Consistency guarantee
The archived DB is a **SQLite `VACUUM INTO` copy** (only committed transactions, taken while the
engine writes — never a mid-write file copy). Status appears as `wal:VACUUM-COPY-CONSISTENT` in
`backups/latest.json`.

## Encryption (suggestion 2)
- Cipher: `AES-256-CBC`, `PBKDF2` 200k iterations (openssl 3.x).
- Passphrase: lives in `.env` as `BACKUP_PASSPHRASE` — **the operator holds a separate copy**.
- ONLY the `.enc` archive goes to Telegram; the plain zip never leaves the sandbox.
- Post-zip guard: an archive missing db/.env/MANIFEST/calibration is deleted and NEVER uploaded.

## Restore procedure (full sandbox wipe)
```bash
# 1. pull newest nexus-snapshot-*.zip.enc from the Telegram relay chat
# 2. decrypt (passphrase = BACKUP_PASSPHRASE from your password manager)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in nexus-snapshot-X.zip.enc -out restore.zip -pass pass:'YOUR_PASSPHRASE'
# 3. extract over a fresh project dir (bun + prisma available)
unzip restore.zip -d /home/z/my-project
# 4. verify integrity (should print RESTORE-DRILL PASS)
bash scripts/restore-drill.sh
# 5. boot
bun install && bunx prisma generate && bun run dev
```

## Restore drill (suggestion 4)
`scripts/restore-drill.sh` — runs 13 checks: zip integrity → full inventory → **content-fingerprint
match** (manifest vs extracted db, byte-layout independent) → row-count consistency vs live →
**encryption round-trip** (proves the passphrase actually decrypts). Result → Telegram + `backups/drill.log`.
Scheduled monthly (cron, 1st of month 06:00 Tehran). A backup chain is UNPROVEN until this passes.

## Calibration history (suggestion 3)
`backups/calibration-latest.json` is also sent standalone to Telegram (few KB) on every snapshot —
diff any two snapshots to see exactly which knob changed when; a fresh sandbox can be re-calibrated
from this JSON alone even if the SQLite file is lost.

## Known-good reference
`backups/latest.json` carries `encryptedSha256` of the last uploaded archive — compare with the
downloaded file before restoring.

---

# v10.16 — full-tree restore contract · control-plane auth keys · passphrase rotation · S3 third tier
(audit task 4-g, 2026-09: deep-audit P1/P2 recovery + ops fixes)

## (a) Full-tree restore contract — `scripts/recovery-restore.sh` v10.16
The audit found the old restore script recovered only db/.env/.data-journals/scripts — a wiped tree
restored that way could never `bun install` (no package.json, no src). The v10.16 contract:

- The snapshot zip (backup.sh v3.4 inventory) carries the **FULL environment**. The restore rebuilds
  the WHOLE tree into `${NEXUS_ROOT:-/home/z/my-project}`:
  - dirs (merge, `copytree(dirs_exist_ok=True)`): `src/` `prisma/` `scripts/` `mini-services/` `docs/`
    `assets/` `.zscripts/` `public/` (when present in the zip)
  - root files (`copy2`, mtimes/perms preserved): `package.json` `bun.lock` `next.config.ts`
    `tsconfig.json` `components.json` `eslint.config.mjs` `postcss.config.mjs` `Caddyfile`
  - state: `db/custom.db` (existing db backed aside as `db/custom.db.pre-recovery-<ts>` first),
    `.env` (chmod 0600), all `.data` journals **including rotated `.old`/`.old.<ts>` rings**,
    `backups/MANIFEST.json`, `backups/calibration-latest.json`, `worklog.md`
- Inventory is guided by MANIFEST `expectInZip` (handles the `zscripts-marker:` hidden-dir
  convention) unioned with the static v3.4 list. **Absent optional item → `[WARN]`, restore
  continues**; absent CORE item (`src/` `prisma/` `scripts/` `package.json` `next.config.ts`
  `tsconfig.json`) → `[FAIL]` + `RESTORE INCOMPLETE` + exit 1.
- **MODE 1 (local archive path) is fully tokenless** — needs only `BACKUP_PASSPHRASE`.
  `TELEGRAM_BOT_TOKEN` is prompted ONLY in `--from-channel` mode.
- Final boot contract: `cd $ROOT && bun install && bunx prisma generate && bash scripts/dev-up.sh`,
  then canaries `/api/pulse` `/api/advisor` `/api/terminal` `/api/rawcal` all 200.
- The exact running copy is mirrored at `upload/recovery-restore.sh` (also shipped in the Telegram
  recovery kit by backup.sh).

## (b) Control-plane auth keys (v10.15/v10.16 — must survive every restore)
Two keys were added to `.env` beyond the classic secrets — **they live ONLY in `.env` (and the
operator's private records), and `.env` is already in every snapshot + the versioned env chain**:

| Key | Guards | Consumed by |
|---|---|---|
| `NEXUS_CONTROL_KEY` | mutating API requests — header `x-nexus-key` (timing-safe compare) | middleware + mini-services (e.g. p0-watchdog `POST /pause`) |
| `BRIDGE_TOKEN` | Telegram bridge relay — header `x-bridge-token` (or `?token=`), fail-closed when unset | `/api/telegram/bridge` guard + bridge `POST /send` · `GET /inbox` · `POST /read` |

Rule: any restore that replaces `.env` automatically restores both keys; any manual `.env` edit that
drops them re-opens the control plane. `restore-drill.sh` [6] verifies the archived `.env` chain.

## (c) Passphrase rotation runbook — `scripts/rotate-backup-pass.sh` (NEW, dormant)
The chain used to be self-encrypted with one never-rotated passphrase. Rotation is now a verified,
interactive, **dormant** tool (never scheduled — operator-run only):

```bash
bash scripts/rotate-backup-pass.sh          # rotate the newest snapshot archive only (.env untouched)
bash scripts/rotate-backup-pass.sh --apply  # additionally rewrite .env BACKUP_PASSPHRASE after verified roundtrip
```

Contract: reads the OLD `BACKUP_PASSPHRASE` from `.env` → prompts for a NEW passphrase (silent,
min 24 chars, confirmed) → finds the newest `nexus-snapshot-*.zip.enc` in the backup ring (same
resolution as backup.sh v3.4: `NEXUS_BACKUP_DIR` → `/tmp/my-project/backups` → legacy `backups/`)
→ decrypts with OLD → re-encrypts with NEW (`AES-256-CBC/PBKDF2-200k`, identical parameters) →
sha256-verifies a decrypt-roundtrip of the NEW file against the plaintext → writes
`nexus-snapshot-<stamp>.rotated.zip.enc` **beside the untouched original**. Any failure aborts with
no side effects. Secrets are never printed — only sha256 8-char fingerprints link archives to
passphrases. After running: verify the rotated archive yourself, update private records, re-run
`bash scripts/restore-drill.sh` (must PASS). Old archives keep decrypting with the OLD passphrase.

## (d) Optional S3/R2 third tier (backup.sh v3.5 — dormant until provisioned)
Telegram is a single-provider SPOF (alerts + commands + both backup copies). backup.sh now supports
a NON-FATAL third off-site tier, active only when the operator exports BOTH envs:

```
S3_BACKUP_URL    # bucket/base URL, e.g. https://<account>.r2.cloudflarestorage.com/<bucket>
S3_BACKUP_TOKEN  # bearer credential sent as: Authorization: Bearer …
```

When both are set, after the Telegram dual-upload: `curl -X PUT --data-binary @<snap>.zip.enc
$S3_BACKUP_URL/nexus-snapshot-<stamp>.zip.enc` (120s timeout). Result is logged as `S3-TIER OK` /
`S3-TIER FAIL (non-fatal)` and surfaced in `backups/latest.json` as `"s3": "OK|FAIL|DORMANT"` — a
failure here never invalidates the snapshot (local PolarFS ring + Telegram tiers remain the truth).
