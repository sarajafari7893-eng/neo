#!/usr/bin/env bash
# ── NEXUS//SIGNALS RESTORE DRILL (operator-approved suggestion 4) ──
# A backup chain is UNPROVEN until restored. This drill:
#   [1] integrity-tests the newest local snapshot (unzip -t)
#   [2] extracts it to a temp dir and verifies the expected full-environment inventory
#   [3] verifies MANIFEST.json dbSha256 against the extracted db (silent-corruption detector)
#   [4] compares table row counts: extracted db vs LIVE db (Prisma, DATABASE_URL override)
#   [5] encryption round-trip: decrypt the newest .enc with BACKUP_PASSPHRASE → sha256 must
#       equal the plain zip sha256 (proves the passphrase actually works — the #1 restore killer)
#   [6] .env versioned chain (v3.2, operator mandate 2026-09-12): newest backups/env/env-*.enc
#       decrypts with the same passphrase AND manifest envSha256 matches the archived .env
# Best-effort Telegram report → backups/drill.log. Exit 0 = PASS, 1 = FAIL.
set -uo pipefail

ROOT="/home/z/my-project"
# ── ring resolution (audit task 4-g P1-12 regression fix) ──
# MUST match scripts/backup.sh v3.4: the ring lives on the PolarFS mount at
# /tmp/my-project/backups (BACKUPS="/tmp/my-project/backups", backup.sh:39) — the drill
# used to read the legacy $ROOT/backups dir and silently reported "no local snapshot found".
# Resolution order: NEXUS_BACKUP_DIR env override → canonical PolarFS ring → legacy
# $ROOT/backups ONLY when the canonical ring holds no snapshots and the legacy one does.
CANONICAL="/tmp/my-project/backups"
LEGACY="$ROOT/backups"
if [ -n "${NEXUS_BACKUP_DIR:-}" ]; then
  BACKUPS="$NEXUS_BACKUP_DIR"
elif ls "$CANONICAL"/nexus-snapshot-*.zip >/dev/null 2>&1; then
  BACKUPS="$CANONICAL"
elif ls "$LEGACY"/nexus-snapshot-*.zip >/dev/null 2>&1; then
  BACKUPS="$LEGACY"
else
  BACKUPS="$CANONICAL"   # default to canonical so the failure message points at the live ring
fi
echo "[restore-drill] scanning ring: $BACKUPS"
mkdir -p "$BACKUPS"
TMP=$(mktemp -d "$BACKUPS/drill-XXXXXX")
RESULT="PASS"
DETAILS=()

fail() { RESULT="FAIL"; DETAILS+=("✗ $1"); }
pass() { DETAILS+=("✓ $1"); }

LATEST=$(ls -1t "$BACKUPS"/nexus-snapshot-*.zip 2>/dev/null | grep -v '\.enc$' | head -1)
LATEST_ENC="${LATEST}.enc"

# [1] integrity
if [ -z "$LATEST" ]; then
  fail "no local snapshot found in $BACKUPS"
else
  if unzip -tq "$LATEST" >/dev/null 2>&1; then pass "zip integrity OK ($(basename "$LATEST"))"; else fail "zip integrity test failed"; fi

  # [2] extract + inventory
  unzip -q "$LATEST" -d "$TMP" 2>/dev/null
  for f in src prisma/schema.prisma db/custom.db package.json worklog.md Caddyfile .env backups/MANIFEST.json backups/calibration-latest.json; do
    if [ -e "$TMP/$f" ]; then pass "present: $f"; else fail "MISSING in snapshot: $f"; fi
  done

  # [3] manifest content-fingerprint vs extracted db (byte-layout independent — a VACUUM copy
  # differs in raw bytes from the live file by design, so we verify CONTENT, not bytes)
  if [ -f "$TMP/backups/MANIFEST.json" ]; then
    MAN_FP=$(bun -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).contentFingerprint || '')" "$TMP/backups/MANIFEST.json" 2>/dev/null || echo "")
    if [ -n "$MAN_FP" ] && [ -f "$TMP/db/custom.db" ]; then
      EXT_FP=$(DATABASE_URL="file:$TMP/db/custom.db" bun scripts/calibration-snapshot.ts --fingerprint-only 2>/dev/null)
      if [ "$MAN_FP" = "$EXT_FP" ]; then
        pass "content fingerprint matches archived db (${MAN_FP:0:12}…)"
      else
        fail "content fingerprint MISMATCH (manifest:${MAN_FP:0:12}… extracted:${EXT_FP:0:12}…) — silent corruption"
      fi
    else
      pass "fingerprint check skipped (legacy manifest without contentFingerprint)"
    fi
  fi

  # [4] row-count comparison extracted vs live
  if [ -f "$TMP/db/custom.db" ]; then
    COUNTS=$(DATABASE_URL="file:$TMP/db/custom.db" bun -e "
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const out = {
  Signal: await db.signal.count(),
  SignalEvent: await db.signalEvent.count(),
  EngineSetting: await db.engineSetting.count(),
  AdvisorProposal: await db.advisorProposal.count(),
};
await db.\$disconnect();
console.log(JSON.stringify(out));
" 2>/dev/null || echo "{}")
    LIVE=$(bun -e "
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const out = {
  Signal: await db.signal.count(),
  SignalEvent: await db.signalEvent.count(),
  EngineSetting: await db.engineSetting.count(),
  AdvisorProposal: await db.advisorProposal.count(),
};
await db.\$disconnect();
console.log(JSON.stringify(out));
" 2>/dev/null || echo "{}")
    if [ "$COUNTS" != "{}" ] && [ "$LIVE" != "{}" ]; then
      # live >= extracted is NORMAL aging (snapshot predates recent writes);
      # extracted > live is the ANOMALY (live db lost rows / was recreated)
      DRIFT=$(bun -e "
const a=$COUNTS, b=$LIVE;
const anomaly = Object.keys(a).filter(k => b[k] !== undefined && a[k] > b[k]).map(k => k+':'+a[k]+'>'+b[k]);
console.log(anomaly.length ? anomaly.join(',') : 'OK');
" 2>/dev/null || echo "calc-error")
      if [ "$DRIFT" = "OK" ]; then
        pass "row counts consistent (extracted⊆live, normal aging) — Signal:${COUNTS##*Signal\":}"
      else
        fail "ANOMALY: extracted db has MORE rows than live ($DRIFT) — live db may have been recreated/reset"
      fi
    else
      fail "could not open extracted or live db via prisma"
    fi
  fi
fi

# [5] encryption round-trip — proves the passphrase works end-to-end
PASS=$(grep '^BACKUP_PASSPHRASE=' "$ROOT/.env" 2>/dev/null | cut -d= -f2-)
if [ -n "$LATEST" ] && [ -n "$PASS" ] && [ -s "$LATEST_ENC" ]; then
  export BACKUP_PASSPHRASE="$PASS"   # openssl -pass env:<NAME> reads the ENVIRONMENT variable
  if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$LATEST_ENC" -out "$TMP/roundtrip.zip" -pass "env:BACKUP_PASSPHRASE" 2>/dev/null; then
    S1=$(sha256sum "$LATEST" | cut -d' ' -f1); S2=$(sha256sum "$TMP/roundtrip.zip" | cut -d' ' -f1)
    if [ "$S1" = "$S2" ]; then pass "encryption round-trip OK — passphrase verified (sha256 equal)"
    else fail "decrypted archive hash differs from plain zip"; fi
  else
    fail "DECRYPTION FAILED with BACKUP_PASSPHRASE — archive unopenable"
  fi
else
  pass "encryption round-trip skipped (no .enc or no passphrase yet)"
fi

# [6] .env versioned chain — v3.2: presence, passphrase round-trip on the env artifact
# itself, and manifest-vs-archived .env consistency (same-snapshot pair, so a live .env
# rotated AFTER the snapshot is never a false alarm)
if [ -e "$TMP/.env" ] && [ -f "$TMP/backups/MANIFEST.json" ]; then
  MENV=$(bun -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).envSha256 || '')" "$TMP/backups/MANIFEST.json" 2>/dev/null || echo "")
  XENV=$(sha256sum "$TMP/.env" | cut -d' ' -f1)
  if [ -z "$MENV" ]; then
    pass "manifest envSha256 skipped (legacy manifest without env fields)"
  elif [ "$MENV" = "$XENV" ]; then
    pass "manifest envSha256 matches archived .env (${MENV:0:12}…)"
  else
    fail "manifest envSha256 MISMATCH vs archived .env — silent corruption"
  fi
fi
ENV_NEWEST=$(ls -1t "$BACKUPS"/env/env-*.enc 2>/dev/null | head -1)
if [ -n "$ENV_NEWEST" ] && [ -n "$PASS" ]; then
  export BACKUP_PASSPHRASE="$PASS"
  if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$ENV_NEWEST" -out "$TMP/env.roundtrip" -pass "env:BACKUP_PASSPHRASE" 2>/dev/null; then
    E1=$(sha256sum "$ROOT/.env" | cut -d' ' -f1); E2=$(sha256sum "$TMP/env.roundtrip" | cut -d' ' -f1)
    if [ "$E1" = "$E2" ]; then
      pass "env chain OK — newest env version decrypts and matches live .env ($(basename "$ENV_NEWEST"))"
    else
      pass "env version decrypts OK (content rotated since last version — next snapshot re-versions)"
    fi
  else
    fail "env version DECRYPTION FAILED with BACKUP_PASSPHRASE — .env history unopenable"
  fi
else
  pass "env chain check skipped (no env versions yet or no passphrase)"
fi

rm -rf "$TMP"

# report
LINE="RESTORE-DRILL $RESULT — $(basename "${LATEST:-none}") · ${#DETAILS[@]} checks · $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "$LINE"
printf '%s\n' "${DETAILS[@]}"
{
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $LINE"
  printf '  %s\n' "${DETAILS[@]}"
} >> "$BACKUPS/drill.log"

# best-effort Telegram report
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ROOT/.env" 2>/dev/null | cut -d= -f2-)
if [ -n "$TOKEN" ] && [ -n "${LATEST:-}" ]; then
  CHAT=$(cd "$ROOT" && bun -e "
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const r = await db.engineSetting.findUnique({ where: { key: 'telegram.chatId' } });
console.log(r?.value ?? '');
await db.\$disconnect();
" 2>/dev/null)
  if [ -n "$CHAT" ]; then
    BODY="$LINE
$(printf '%s\n' "${DETAILS[@]}")"
    curl -s -m 30 -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
      -d "chat_id=$CHAT" --data-urlencode "text=$BODY" >/dev/null 2>&1
  fi
fi

[ "$RESULT" = "PASS" ] && exit 0 || exit 1
