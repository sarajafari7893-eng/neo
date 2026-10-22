#!/usr/bin/env bash
# ── RECOVERY one-shot resurrection hook (flag-gated, self-removing) ──
if [ -f /home/z/my-project/.data/RESURRECT.flag ]; then
  rm -f /home/z/my-project/.data/RESURRECT.flag
  bash /home/z/my-project/scripts/resurrect.sh >> /home/z/my-project/logs/resurrect.log 2>&1
fi
# ── NEXUS//SIGNALS sandbox snapshot v3.1 (v3 + operator-approved hardening 2026-09-08) ──
# v1: full-project zip → backups/ (12 retained)
# v2: off-site tier — Telegram sendDocument upload (45MB gate)
# v3: operator-approved upgrade:
#   (1a) Caddyfile + .zscripts + .env added to the zip (full-environment coverage)
#   (1b) PRAGMA wal_checkpoint(TRUNCATE) before zip → atomic, consistent SQLite snapshot
#   (2)  AES-256-CBC (PBKDF2, 200k iters) encryption — ONLY the .enc archive goes off-site
#   (3)  calibration-snapshot.ts → backups/calibration-latest.json (all EngineSetting rows
#        = live calibration, diffable across time) — included in zip AND sent separately
#   (4)  MANIFEST.json (git HEAD, db sha256, row counts) inside every zip; restore-drill verifies
# Plain zip never leaves the sandbox; passphrase lives ONLY in .env (BACKUP_PASSPHRASE) + operator.
# v3.1 pre-flight + WAL hardening (post disk-full drill):
#   (0) pre-flight: wipe oversized .next/dev/cache (drill-vetted 6.2G incident), abort on <600MB free
#   (1b) wal_checkpoint via bun:sqlite with busy_timeout — Prisma path raced engine writes (NONZERO)
# v3.3 channel recovery tier (operator mandate 2026-09-17 «از این فضا استفاده کن و بصورت
#   خودمختار برای بازیابی استفاده کن»): dual off-site — @mytradeneo channel gains the .enc
#   PLUS 19MB split parts (bot getFile caps 20MB → parts are the autonomous re-download path)
#   PLUS the recovery kit (runbook + restore script) PLUS an append-only RECOVERY-INDEX with
#   part file_ids/sha256. Uploads ride scripts/tg-upload.py (python multipart — curl -F broke
#   in-shell 2026-09-17, drill-vetted exit 26). Secrets NEVER enter the public channel.
# v3.2 .env engineering (operator mandate 2026-09-12: «افزودن .env به backup.sh»):
#   (1c) .env pre-flight HARD gate (missing/empty → abort — an un-restorable snapshot must
#        not ship) + chmod 600 secrets hygiene + single-parse TOKEN/PASS + audit hashes
#   (1d) MANIFEST.json gains envSha256 / envBytes / envPerm / passphraseSha8 (audit trail)
#   (1e) post-zip: archived .env bytes verified sha256-equal to the live file (abort on drift)
#   (5)  dedicated versioned .env history → backups/env/env-<sha8>-<stamp>.enc
#        AES-256-CBC PBKDF2(200k) with the SAME passphrase, hash-deduped (a new version is
#        written only when content actually changes), 12 retained, tiny .enc uploaded
#        off-site on change; passphraseSha8 links each version to its decrypting passphrase
#   latest.json gains an "env" audit block; restore-drill [6] verifies the env chain end-to-end
set -uo pipefail

ROOT="/home/z/my-project"
# v3.4 (operator mandate 2026-09-19 msg 861802421: «استفاده از فضای PolarFS»):
# snapshots build on the PolarFS mount (/tmp/my-project — ~30GB free) instead of
# the 9.9G rootfs, whose base image leaves <400MB for runtime. Ring-keeping and
# the recovery flow operate on $BACKUPS directly; nothing else changed.
BACKUPS="/tmp/my-project/backups"
KEEP=12
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$BACKUPS/nexus-snapshot-$STAMP.zip"
OUT_ENC="$OUT.enc"

mkdir -p "$BACKUPS"
cd "$ROOT" || exit 1

# ── (0) DISK PRE-FLIGHT — never snapshot on a starving filesystem ──
# 2026-09-08 drill: turbopack dev-cache grew unbounded to 6.2G → rootfs 100%
# → ENOSPC mid-stage. Three defense layers (consolidated, single source of truth):
#   L1  size-gated cache hygiene EVERY cycle (scripts/disk-hygiene.sh, silent)
#   L2  if rootfs ≥92% used → force-clean the dev cache (cheap escape hatch)
#   L3  hard abort if <600MB free on the OUTPUT fs (PolarFS) even after hygiene
#       (fail LOUD, write NOTHING) — v3.4: guard moved to output fs; rootfs only
#       needs a 50MB sanity floor now that the archive is built off-rootfs
bash "$ROOT/scripts/disk-hygiene.sh" >/dev/null 2>&1 || true
DISK_PCT=$(df --output=pcent "$ROOT" 2>/dev/null | tail -1 | tr -dc '0-9')
if [ "${DISK_PCT:-100}" -ge 92 ]; then
  bash "$ROOT/scripts/disk-hygiene.sh" --force >/dev/null 2>&1 || true
fi
FREE_MB=$(df -Pm "$BACKUPS" 2>/dev/null | tail -1 | awk '{print $4}')
if [ "${FREE_MB:-0}" -lt 600 ]; then
  echo "SNAPSHOT ABORTED — low disk on output fs (${FREE_MB}MB free < 600MB) even after hygiene. Free space manually, then retry."
  exit 1
fi
FREE_MB_ROOT=$(df -Pm "$ROOT" 2>/dev/null | tail -1 | awk '{print $4}')
if [ "${FREE_MB_ROOT:-0}" -lt 50 ]; then
  echo "SNAPSHOT ABORTED — rootfs sanity floor (${FREE_MB_ROOT}MB free < 50MB); runtime writes at risk."
  exit 1
fi

# ── (1c) .env pre-flight — v3.2 (operator mandate): the archive is only as restorable as its
# secrets. Missing/empty .env = hard abort (never ship an un-restorable archive), 0600 perms
# enforced (secrets hygiene — was world-readable 0755), and the audit hashes are parsed ONCE
# here so every later stage reads the same single source of truth.
if [ ! -s "$ROOT/.env" ]; then
  echo "SNAPSHOT ABORTED — .env missing/empty; a restorable snapshot is impossible. Nothing written."
  exit 1
fi
chmod 600 "$ROOT/.env" 2>/dev/null || true
ENV_SHA=$(sha256sum "$ROOT/.env" | cut -d' ' -f1)
ENV_BYTES=$(stat -c%s "$ROOT/.env")
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ROOT/.env" | cut -d= -f2-)
PASS=$(grep '^BACKUP_PASSPHRASE=' "$ROOT/.env" | cut -d= -f2-)
PASS_SHA8="none"; [ -n "$PASS" ] && PASS_SHA8=$(printf '%s' "$PASS" | sha256sum | cut -c1-8)

# ── (1b) atomic DB: consistent snapshot via SQLite "VACUUM INTO" (b-native, works while the
# engine writes — copies only committed transactions into a fresh, defragmented db file).
WAL_STATUS="VACUUM-COPY-FAILED"
STAGE="$BACKUPS/.stage-$STAMP"
mkdir -p "$STAGE/db"
for i in 1 2 3; do
  rm -f "$STAGE/db/custom.db"
  BK=$(bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('db/custom.db', { readonly: true });
db.exec('VACUUM INTO \"' + process.argv[1] + '\"');
db.close();
console.log('VACUUM-COPY-OK');
" "$STAGE/db/custom.db" 2>/dev/null || echo "VACUUM-COPY-FAILED")
  [ "$BK" = "VACUUM-COPY-OK" ] && [ -s "$STAGE/db/custom.db" ] && WAL_STATUS="VACUUM-COPY-CONSISTENT" && break
  sleep 1
done
# WAL housekeeping on the LIVE db (best-effort, cosmetic — consistency comes from VACUUM copy).
# v3.1: bun:sqlite + busy_timeout=3000 — the Prisma path hit engine write locks (CHECKPOINT-NONZERO).
CK=$(bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('db/custom.db');
db.exec('PRAGMA busy_timeout=3000');
const r = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
console.log(r && r.busy === 0 ? 'CHECKPOINTED' : 'CHECKPOINT-NONZERO');
db.close();
" 2>/dev/null || echo "CHECKPOINT-FAILED")
WAL_STATUS="$WAL_STATUS+$CK"

# ── (3+4) calibration snapshot + manifest (best-effort; failure never blocks the snapshot)
CAL_STATUS="OK"
bun scripts/calibration-snapshot.ts >/dev/null 2>&1 || CAL_STATUS="FAILED"
# Patch MANIFEST contentFingerprint to the fingerprint of the ARCHIVED (VACUUM) copy —
# the live db keeps moving, the archived copy is what the drill must verify against.
if [ -s "$STAGE/db/custom.db" ] && [ -f "$BACKUPS/MANIFEST.json" ]; then
  ARCH_FP=$(DATABASE_URL="file:$STAGE/db/custom.db" bun scripts/calibration-snapshot.ts --fingerprint-only 2>/dev/null)
  if [ -n "$ARCH_FP" ] && [ "${#ARCH_FP}" = "64" ]; then
    bun -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
m.contentFingerprint = process.argv[2];
m.archivedDbBytes = fs.statSync(process.argv[3]).size;
m.envSha256 = process.argv[4];
m.envBytes = Number(process.argv[5]);
m.envPerm = '0600';
m.passphraseSha8 = process.argv[6];
fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2));
" "$BACKUPS/MANIFEST.json" "$ARCH_FP" "$STAGE/db/custom.db" "$ENV_SHA" "$ENV_BYTES" "$PASS_SHA8" 2>/dev/null
  else
    CAL_STATUS="FP-FAILED"
  fi
fi

# ── v10.4 shadow-veto MANIFEST audit keys — the manifest now verifies the arm
# evidence chain end-to-end (restore-drill can assert ring presence + integrity,
# not just the DB/env): live ring bytes+sha256 and every rotated predecessor ring.
bun -e "
const fs = require('fs'), crypto = require('crypto');
try {
  const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const f = '.data/shadow-veto.jsonl';
  const oldRings = fs.readdirSync('.data').filter(n => n.startsWith('shadow-veto.jsonl.old')).sort();
  m.shadowVeto = {
    fileBytes: fs.existsSync(f) ? fs.statSync(f).size : 0,
    sha256: fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null,
    rotatedRings: oldRings,
    rotatedBytes: oldRings.reduce((a, n) => a + (fs.statSync('.data/' + n).size || 0), 0)
  };
  const fp = '.data/fourpack-journal.jsonl';
  const fpOld = fs.readdirSync('.data').filter(n => n.startsWith('fourpack-journal.jsonl.old')).sort();
  m.fourPack = {
    fileBytes: fs.existsSync(fp) ? fs.statSync(fp).size : 0,
    sha256: fs.existsSync(fp) ? crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex') : null,
    rotatedRings: fpOld,
    rotatedBytes: fpOld.reduce((a, n) => a + (fs.statSync('.data/' + n).size || 0), 0)
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2));
} catch {}
" "$BACKUPS/MANIFEST.json" 2>/dev/null || true

# ── (1a) full-environment zip — explicit paths only (never the backups/ dir itself).
# db/custom.db comes from the staging dir (backup-API copy) so the archived db is
# the CONSISTENT snapshot, not the live file mid-write.
# v10.3 (operator mandate 2026-09-15 «ماژول Shadow veto باید با اسنپ شات سیستم ذخیره و
# هماهنگ باشد»): .data state journals ride every snapshot — the shadow-veto A/B arm
# evidence rings (jsonl, boot-hydrated), the SV telemetry snapshots, the gate journal
# and RAW-CAL telemetry. Without them a rollback wipes the 30/30 promotion cohorts.
# ── v11.2 MANIFEST AUTHORITY SYNC (restore-drill finding 2026-10-07) ──
# calibration-snapshot.ts writes its manifest to ROOT/backups (rootfs) while
# backup.sh patches the RING manifest on PolarFS ($BACKUPS) with the ARCHIVED
# copy's contentFingerprint + archivedDbBytes — so the zipped copy used to ride
# the LIVE fingerprint and the drill had no authoritative anchor inside the
# archive. The patched ring manifest is the audit truth: it now RIDES the zip.
cp -f "$BACKUPS/MANIFEST.json" "$ROOT/backups/MANIFEST.json" 2>/dev/null || true

zip -q -r "$OUT" \
  src prisma mini-services docs scripts .zscripts assets \
  package.json bun.lock tsconfig.json next.config.ts postcss.config.mjs components.json eslint.config.mjs \
  Caddyfile .env \
  worklog.md dev.log \
  .data/gate-journal.jsonl .data/rawcal-telemetry.jsonl \
  .data/shadow-veto.jsonl .data/shadow-veto-latest.json \
  .data/shadow-veto-telemetry.json .data/shadow-veto-telemetry.jsonl \
  .data/fourpack-journal.jsonl .data/fourpack-latest.json \
  backups/MANIFEST.json backups/calibration-latest.json \
  -x "*/node_modules/*" "*/.next/*" "*/tool-results/*" 2>/dev/null
(cd "$STAGE" && zip -q "$OUT" db/custom.db 2>/dev/null)
rm -rf "$STAGE"

# ── v10.4 SHADOW-VETO RING CONTINUITY (operator mandate 2026-09-16 «یکپارچه
# سازی snapshot ماژول Shadow veto با اسنپ شات کلی سیستم»). The rotated
# predecessor ring(s) (.old, .old.<ts> from the 6MB rotation / evidence reset)
# ride every snapshot too: hydration reads the live file only, so a restore of
# a post-rotation snapshot WITHOUT the .old ring would silently drop the
# pre-rotation half of the arm evidence chain. Conditional — often absent.
for f in .data/shadow-veto.jsonl.old*; do
  [ -f "$f" ] && zip -q "$OUT" "$f" 2>/dev/null
done

# ── v10.5 FOUR-PACK JOURNAL CONTINUITY (operator mandate 2026-09-16 — JSON
# journal doctrine for the GOVERNOR MODULES FOUR-PACK). Same rule as the
# shadow-veto rings: the rotated predecessor rides every snapshot when present.
for f in .data/fourpack-journal.jsonl.old*; do
  [ -f "$f" ] && zip -q "$OUT" "$f" 2>/dev/null
done

# ── v3.3 recovery-critical state files — heartbeat tracker + cohort-freeze snapshot
# (wipe-recovery mandate: journals needed for system recovery ride every snapshot)
[ -f .data/rawcal-run-heartbeat.txt ] && zip -q "$OUT" .data/rawcal-run-heartbeat.txt 2>/dev/null
[ -f .data/sv-cohort-freeze.json ] && zip -q "$OUT" .data/sv-cohort-freeze.json 2>/dev/null

# ── post-zip guard: an incomplete archive must NEVER be encrypted/uploaded (drill-vetted rule)
ZIP_OK="PASS"
for req in "db/custom.db" ".env" "backups/MANIFEST.json" "backups/calibration-latest.json" "Caddyfile" \
           ".data/shadow-veto.jsonl" ".data/shadow-veto-telemetry.json"; do
  # NO grep -q here: early exit SIGPIPEs unzip, and pipefail turns 141 into a false
  # guard failure (drill-vetted: plain grep reads to EOF — deterministic result).
  unzip -l "$OUT" 2>/dev/null | grep " $req" >/dev/null || { ZIP_OK="FAIL:$req"; break; }
done
# v10.5 fourpack entries — enforced ONLY when the live files already exist (a
# freshly restored environment may not have produced its first module cycle yet;
# a missing pre-first-cycle journal must never abort the snapshot itself).
if [ "$ZIP_OK" = "PASS" ] && [ -f .data/fourpack-journal.jsonl ]; then
  unzip -l "$OUT" 2>/dev/null | grep " .data/fourpack-journal.jsonl" >/dev/null || ZIP_OK="FAIL:.data/fourpack-journal.jsonl"
fi
if [ "$ZIP_OK" = "PASS" ] && [ -f .data/fourpack-latest.json ]; then
  unzip -l "$OUT" 2>/dev/null | grep " .data/fourpack-latest.json" >/dev/null || ZIP_OK="FAIL:.data/fourpack-latest.json"
fi
if [ "$ZIP_OK" != "PASS" ]; then
  echo "SNAPSHOT ABORTED — post-zip guard failed ($ZIP_OK). Bad archive deleted, nothing uploaded."
  rm -f "$OUT" "$OUT_ENC"
  exit 1
fi

# ── (1e) .env archive-content verification — v3.2: presence is not integrity. The .env bytes
# inside the archive must be sha256-equal to the live file (silent-corruption detector for
# the single most restorative-critical small file in the whole snapshot).
ENV_ZIP_SHA=$(unzip -p "$OUT" ".env" 2>/dev/null | sha256sum | cut -d' ' -f1)
if [ "$ENV_ZIP_SHA" != "$ENV_SHA" ]; then
  echo "SNAPSHOT ABORTED — archived .env content mismatches live file (archive:${ENV_ZIP_SHA:0:12}… live:${ENV_SHA:0:12}…). Bad archive deleted, nothing uploaded."
  rm -f "$OUT" "$OUT_ENC"
  exit 1
fi

# retention: keep newest KEEP snapshots (both plain + encrypted) — runs BEFORE
# the manifest count so "N snapshots retained" reflects the post-trim truth
ls -1t "$BACKUPS"/nexus-snapshot-*.zip 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old" "${old}.enc"; done

SIZE=$(du -h "$OUT" 2>/dev/null | cut -f1)
COUNT=$(ls -1 "$BACKUPS"/nexus-snapshot-*.zip 2>/dev/null | wc -l)

# ── (2) encrypt: AES-256-CBC + PBKDF2(200k) — passphrase from .env (operator holds a copy);
# v3.2: TOKEN/PASS are parsed once in the (1c) pre-flight — single read, one source of truth.
ENC_STATUS="NO_PASSPHRASE"
SHA_ENC="unavailable"
if [ -n "$PASS" ] && [ -s "$OUT" ]; then
  export BACKUP_PASSPHRASE="$PASS"   # openssl -pass env:<NAME> reads the ENVIRONMENT variable
  if openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
       -in "$OUT" -out "$OUT_ENC" -pass "env:BACKUP_PASSPHRASE" 2>/dev/null && [ -s "$OUT_ENC" ]; then
    ENC_STATUS="ENCRYPTED"
    SHA_ENC=$(sha256sum "$OUT_ENC" 2>/dev/null | cut -d' ' -f1)
  else
    ENC_STATUS="FAILED"
  fi
fi

# ── off-site tier: upload ONLY the encrypted archive (plain zip never leaves the sandbox)
# ── v3.4 TELEGRAM OFF-SITE RETIREMENT (operator order 2026-10-22
# «بک‌اپ‌گیری در تلگرام رو لقو کن», trace 1a165f73a1dfc38d) ────────────────────
# ALL telegram upload tiers below (main .enc + calibration, @mytradeneo
# channel parts/kit/index, .env version push) are RETIRED by default.
# Recovery truth now = ① backup ring /tmp/my-project/backups (PolarFS)
# ② golden repo.tar on /home/sync (OSS — auto-restored by /start.sh at every
# boot) ③ git bundles ④ GitHub origin/main (credential store, RECOVERY-20261022b).
# Export NEXUS_BACKUP_OFFSITE=1 to explicitly re-enable the telegram tiers.
OFFSITE_ENABLED=0
[ "${NEXUS_BACKUP_OFFSITE:-0}" = "1" ] && OFFSITE_ENABLED=1
OFFSITE_STATUS="SKIPPED"
[ "$OFFSITE_ENABLED" = "0" ] && OFFSITE_STATUS="DISABLED(operator-order-20261022)"
BYTES=$(stat -c%s "$OUT_ENC" 2>/dev/null || echo 0)
# v3.2: CHAT is fetched ONCE here and reused by BOTH off-site tiers (main snapshot AND the
# .env versioning tier below) — env history keeps its off-site coverage even when the main
# zip upload is gated out (e.g. >45MB), instead of silently inheriting NO_CHAT.
CHAT=$(cd "$ROOT" && bun -e "
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const r = await db.engineSetting.findUnique({ where: { key: 'telegram.chatId' } });
console.log(r?.value ?? '');
await db.\$disconnect();
" 2>/dev/null)
# Telegram bot upload hard limit = 50MB; gate at 45MB for headroom
if [ "$OFFSITE_ENABLED" = "1" ] && [ -n "$TOKEN" ] && [ "$ENC_STATUS" = "ENCRYPTED" ] && [ "$BYTES" -gt 0 ] && [ "$BYTES" -lt 47185920 ]; then
  if [ -n "$CHAT" ]; then
    RES=$(curl -s -m 120 -X POST "https://api.telegram.org/bot$TOKEN/sendDocument" \
      -F "chat_id=$CHAT" \
      -F "document=@$OUT_ENC" \
      -F "caption=NEXUS//SIGNALS off-site snapshot (AES-256) — $(basename "$OUT_ENC") ($SIZE) · wal:$WAL_STATUS · cal:$CAL_STATUS · $(date -u '+%Y-%m-%d %H:%M UTC')" 2>/dev/null)
    if echo "$RES" | grep '"ok":true' >/dev/null; then
      OFFSITE_STATUS="UPLOADED"
    else
      OFFSITE_STATUS="FAILED"
    fi
    # (3) calibration JSON — few KB, always passes the gate; the diffable calibration history
    if [ -s "$BACKUPS/calibration-latest.json" ]; then
      curl -s -m 60 -X POST "https://api.telegram.org/bot$TOKEN/sendDocument" \
        -F "chat_id=$CHAT" \
        -F "document=@$BACKUPS/calibration-latest.json" \
        -F "caption=NEXUS calibration snapshot — EngineSettings + rowCounts + git HEAD · $(date -u '+%Y-%m-%d %H:%M UTC')" >/dev/null 2>&1
    fi
  else
    OFFSITE_STATUS="NO_CHAT"
  fi
fi

# ── v3.3 CHANNEL RECOVERY TIER (@mytradeneo) — full .enc + 19MB parts + kit + index.
# Parts make recovery AUTONOMOUS: bot getFile re-download caps at 20MB, so any wiped
# sandbox (or any machine) can rebuild the archive from parts alone using only the
# bot token + passphrase. Index = append-only, LAST block is the latest truth.
CHANNEL_STATUS="SKIPPED"
[ "$OFFSITE_ENABLED" = "0" ] && CHANNEL_STATUS="DISABLED(operator-order-20261022)"
CHANNEL="@mytradeneo"
INDEX_FILE="$BACKUPS/RECOVERY-INDEX-latest.txt"
if [ "$OFFSITE_ENABLED" = "1" ] && [ "$ENC_STATUS" = "ENCRYPTED" ] && [ -s "$OUT_ENC" ]; then
  # kit files must exist before uploads (self-heal: recreate runbook if missing)
  [ -f "$ROOT/RECOVERY-RUNBOOK.md" ] || echo "# RECOVERY-RUNBOOK missing at $(date -u +%FT%TZ)" > "$ROOT/RECOVERY-RUNBOOK.md"
  IDX_BLOCK=""
  if [ "$BYTES" -gt 0 ] && [ "$BYTES" -lt 47185920 ]; then
    R1=$(python3 "$ROOT/scripts/tg-upload.py" "$CHANNEL" "$OUT_ENC" "NEXUS full encrypted snapshot — $(basename "$OUT_ENC") · sha256:${SHA_ENC:0:12} · $(date -u '+%Y-%m-%d %H:%M UTC')" 2>/dev/null || echo '{"ok":false}')
    # split parts — bot-API re-downloadable (19MB < 20MB getFile cap); prior cycles' parts purged (disk hygiene)
    rm -f "$BACKUPS"/nexus-snapshot-*.zip.enc.part-* 2>/dev/null
    split -b 19922944 -d "$OUT_ENC" "$OUT_ENC.part-"
    PARTS_JSON=""
    PART_OK=0
    PART_N=0
    for P in "$OUT_ENC".part-*; do
      [ -s "$P" ] || continue
      PART_N=$((PART_N + 1))
      P_SHA=$(sha256sum "$P" | cut -d' ' -f1)
      PR=$(python3 "$ROOT/scripts/tg-upload.py" "$CHANNEL" "$P" "snapshot part $(basename "$P") — sha256:${P_SHA:0:12}" 2>/dev/null || echo '{"ok":false}')
      P_FID=$(echo "$PR" | python3 -c "import json,sys; print(json.load(sys.stdin).get('file_id') or '')" 2>/dev/null)
      if [ -n "$P_FID" ]; then
        PART_OK=$((PART_OK + 1))
        PARTS_JSON="$PARTS_JSON${PARTS_JSON:+,}{\"name\":\"$(basename "$P")\",\"fileId\":\"$P_FID\",\"sha256\":\"$P_SHA\"}"
      fi
    done
    # recovery kit — runbook + restore script (survive the wipe, live in the channel)
    KR1=$(python3 "$ROOT/scripts/tg-upload.py" "$CHANNEL" "$ROOT/RECOVERY-RUNBOOK.md" "RECOVERY RUNBOOK — wipe-recovery procedure · $(date -u '+%Y-%m-%d %H:%M UTC')" 2>/dev/null || echo '{"ok":false}')
    KR2=$(python3 "$ROOT/scripts/tg-upload.py" "$CHANNEL" "$ROOT/scripts/recovery-restore.sh" "RECOVERY RESTORE SCRIPT — autonomous re-download + decrypt + restore" 2>/dev/null || echo '{"ok":false}')
    # append-only index — LAST block is the latest restorable snapshot
    if [ "$PART_OK" -gt 0 ]; then
      IDX_BLOCK="{\"stamp\":\"$STAMP\",\"encFile\":\"$(basename "$OUT_ENC")\",\"encSha256\":\"$SHA_ENC\",\"encBytes\":$BYTES,\"fullUpload\":\"$(echo "$R1" | grep -c '"ok": true')\",\"parts\":[$PARTS_JSON]}"
      printf '%s\n%s\n' "================================================" "$IDX_BLOCK" >> "$INDEX_FILE"
      IR=$(python3 "$ROOT/scripts/tg-upload.py" "$CHANNEL" "$INDEX_FILE" "RECOVERY-INDEX — append-only; LAST block = latest snapshot (parts file_ids + sha256)" 2>/dev/null || echo '{"ok":false}')
      if echo "$IR" | grep -q '"ok": true' && [ "$PART_OK" = "$PART_N" ]; then
        CHANNEL_STATUS="UPLOADED($PART_OK parts,full,kit,index)"
      elif [ "$PART_OK" -gt 0 ]; then
        CHANNEL_STATUS="PARTIAL($PART_OK/$PART_N parts)"
      else
        CHANNEL_STATUS="FAILED"
      fi
    else
      CHANNEL_STATUS="FAILED(parts)"
    fi
  else
    CHANNEL_STATUS="TOO_BIG"
  fi
fi

# ── v3.5 OPTIONAL S3/R2 THIRD TIER (audit task 4-g: Telegram is the only off-site provider —
# single-provider SPOF for alerts + commands + both backup copies). DORMANT until the operator
# provisions an S3/R2 bucket and exports BOTH envs: S3_BACKUP_URL (bucket base URL) and
# S3_BACKUP_TOKEN (bearer credential). NON-FATAL by contract: any failure here must NEVER
# invalidate the snapshot — the local PolarFS ring + both Telegram tiers remain the truth.
S3_STATUS="DORMANT"
if [ -n "${S3_BACKUP_URL:-}" ] && [ -n "${S3_BACKUP_TOKEN:-}" ]; then
  if [ "$ENC_STATUS" = "ENCRYPTED" ] && [ -s "$OUT_ENC" ]; then
    if curl -sS --max-time 120 -X PUT \
         -H "Authorization: Bearer $S3_BACKUP_TOKEN" \
         --data-binary @"$OUT_ENC" \
         "$S3_BACKUP_URL/nexus-snapshot-$STAMP.zip.enc" >/dev/null 2>&1; then
      echo "S3-TIER OK — nexus-snapshot-$STAMP.zip.enc"
      S3_STATUS="OK"
    else
      echo "S3-TIER FAIL (non-fatal) — snapshot remains valid on local ring + Telegram tiers"
      S3_STATUS="FAIL"
    fi
  else
    S3_STATUS="SKIPPED(no-enc)"
  fi
fi

# ── (5) .env versioned history — v3.2 (operator mandate 2026-09-12). Point-in-time copies of
# .env with real engineering properties:
#   • hash-deduped: newest version is decrypt-checked; a new artifact is written ONLY when
#     the live .env content actually differs (no duplicate noise, and the decrypt-check
#     doubles as a continuous passphrase-validity probe for the env chain)
#   • content-addressed name env-<sha8>-<stamp>.enc → identity + time in one glance
#   • passphraseSha8 bookkeeping → if BACKUP_PASSPHRASE is ever rotated, each old version
#     remains mappable to the passphrase that decrypts it (rotation-safe audit)
#   • AES-256-CBC + PBKDF2(200k) — IDENTICAL parameters to the main snapshot tier
#   • 12 retained, and the tiny .enc goes off-site on change (secrets NEVER leave unencrypted)
ENV_STATUS="NO-PASS"
ENV_VER_OFFSITE="SKIPPED"
ENV_VER_COUNT=0
ENV_LAST_FILE=""
ENVDIR="$BACKUPS/env"
mkdir -p "$ENVDIR"
if [ -n "$PASS" ]; then
  export BACKUP_PASSPHRASE="$PASS"   # openssl -pass env:<NAME> reads the ENVIRONMENT variable
  NEWEST_ENV=$(ls -1t "$ENVDIR"/env-*.enc 2>/dev/null | head -1)
  SAME=0
  if [ -n "$NEWEST_ENV" ]; then
    DEC_SHA=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$NEWEST_ENV" -pass "env:BACKUP_PASSPHRASE" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$DEC_SHA" = "$ENV_SHA" ] && SAME=1
  fi
  if [ "$SAME" = "1" ]; then
    ENV_STATUS="NO-CHANGE"                       # newest version already matches live .env
    ENV_LAST_FILE=$(basename "$NEWEST_ENV")
  else
    ENV_ENC="$ENVDIR/env-${ENV_SHA:0:8}-$STAMP.enc"
    if openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
         -in "$ROOT/.env" -out "$ENV_ENC" -pass "env:BACKUP_PASSPHRASE" 2>/dev/null && [ -s "$ENV_ENC" ]; then
      ENV_STATUS="VERSIONED"
      ENV_LAST_FILE=$(basename "$ENV_ENC")
      ls -1t "$ENVDIR"/env-*.enc 2>/dev/null | tail -n +13 | while read -r old; do rm -f "$old"; done
      ENV_VER_COUNT=$(ls -1 "$ENVDIR"/env-*.enc 2>/dev/null | wc -l)
      if [ "$OFFSITE_ENABLED" = "1" ] && [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
        ENVRES=$(curl -s -m 60 -X POST "https://api.telegram.org/bot$TOKEN/sendDocument" \
          -F "chat_id=$CHAT" \
          -F "document=@$ENV_ENC" \
          -F "caption=NEXUS//SIGNALS .env versioned backup (AES-256) — $(basename "$ENV_ENC") · passphraseSha8:$PASS_SHA8 · $(date -u '+%Y-%m-%d %H:%M UTC')" 2>/dev/null)
        if echo "$ENVRES" | grep '"ok":true' >/dev/null; then
          ENV_VER_OFFSITE="UPLOADED"
        else
          ENV_VER_OFFSITE="FAILED"
        fi
      else
        ENV_VER_OFFSITE="NO-CHANNEL"
      fi
    else
      ENV_STATUS="FAILED"
      rm -f "${ENV_ENC:-}" 2>/dev/null || true
    fi
  fi
  ENV_VER_COUNT=$(ls -1 "$ENVDIR"/env-*.enc 2>/dev/null | wc -l)
fi

# manifest for the UI (what /api/backup GET reads — legacy fields preserved, new fields added)
cat > "$BACKUPS/latest.json" <<EOF
{
  "file": "$(basename "$OUT")",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sizeHuman": "$SIZE",
  "snapshots": $COUNT,
  "offsite": "$OFFSITE_STATUS",
  "channel": "$CHANNEL_STATUS",
  "s3": "$S3_STATUS",
  "includes": ["src", "prisma", "mini-services", "docs", "scripts", ".zscripts", "Caddyfile", ".env", "worklog.md", "db/custom.db", "MANIFEST.json", "calibration-latest.json", ".data/shadow-veto.jsonl", ".data/shadow-veto.jsonl.old (rotated ring, when present)", ".data/shadow-veto-telemetry.json", ".data/shadow-veto-telemetry.jsonl", ".data/shadow-veto-latest.json", ".data/gate-journal.jsonl", ".data/rawcal-telemetry.jsonl", ".data/fourpack-journal.jsonl", ".data/fourpack-journal.jsonl.old (rotated ring, when present)", ".data/fourpack-latest.json"],
  "walStatus": "$WAL_STATUS",
  "calibrationStatus": "$CAL_STATUS",
  "encrypted": "$ENC_STATUS",
  "encryptedFile": "$(basename "$OUT_ENC")",
  "encryptedSha256": "$SHA_ENC",
  "env": {
    "included": true,
    "perm": "0600",
    "sha256": "$ENV_SHA",
    "bytes": $ENV_BYTES,
    "versionedStatus": "$ENV_STATUS",
    "versionsRetained": $ENV_VER_COUNT,
    "lastVersionFile": "$ENV_LAST_FILE",
    "offsite": "$ENV_VER_OFFSITE",
    "passphraseSha8": "$PASS_SHA8"
  }
}
EOF

echo "SNAPSHOT OK — $(basename "$OUT") ($SIZE) · $COUNT snapshots retained (max $KEEP) · wal:$WAL_STATUS · cal:$CAL_STATUS · enc:$ENC_STATUS · off-site: $OFFSITE_STATUS · channel: $CHANNEL_STATUS · s3:$S3_STATUS · env:$ENV_STATUS($ENV_VER_COUNT)·$ENV_VER_OFFSITE"

# ── v10.6 SNAP-RESTART CONTRACT (operator-approved 2026-09-17, blanket
# supervisor approval «تمام تصمیمات و پیشنهادات سوپروایزر را تایید می کنم»).
# History: the pre-flight disk-hygiene cache wipe corrupted the LIVE turbopack
# SST cache 3× (19:34Z / 22:45Z / 01:32Z) → /api/terminal (and friends) 500
# until manual repair (pause watchdog → stop app → purge cache → dev-up).
# Contract: after EVERY snapshot, canary-probe the 4 core routes (retry once
# after 5s to skip mid-compile false positives); on real failure run the
# drill-vetted repair ONCE, re-probe, and notify via the bridge relay.
CANARY=""
for attempt in 1 2; do
  CANARY=$(for r in pulse advisor terminal rawcal; do
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://localhost:3000/api/$r" 2>/dev/null || echo 000)
    printf '%s:%s ' "$r" "$code"
  done)
  echo "$CANARY" | grep -q 'pulse:200' && break
  [ "$attempt" = "1" ] && sleep 5
done
if ! echo "$CANARY" | grep -q 'pulse:200'; then
  echo "SNAP-RESTART canary FAILED [$CANARY] — running drill-vetted repair"
  # v10.7 (Task 73): repair now rides the CANONICAL guarded purge
  # (scripts/dev-cache-purge.sh: flock → pause → kill-safe → wipe → dev-up).
  # The old inline dance had no process-exit wait (double-writer race) and
  # duplicated the contract in a 3rd place. Single source of truth now.
  bash "$ROOT/scripts/dev-cache-purge.sh" >> "$ROOT/dev.log" 2>&1
  CANARY2=$(for r in pulse advisor terminal rawcal; do
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://localhost:3000/api/$r" 2>/dev/null || echo 000)
    printf '%s:%s ' "$r" "$code"
  done)
  echo "SNAP-RESTART repaired — canary after: [$CANARY2]"
  bash "$ROOT/scripts/telegram-send.sh" "SNAP-RESTART auto-heal: canary پس از اسنپ‌شات ناموفق بود ($CANARY) — ترمیم استاندارد اجرا شد. نتیجه: $CANARY2" >/dev/null 2>&1
fi
