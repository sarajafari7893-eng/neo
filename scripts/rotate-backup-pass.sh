#!/usr/bin/env bash
# ── NEXUS//SIGNALS BACKUP-PASSPHRASE ROTATION (v1.0, audit task 4-g P1 — DORMANT tool) ──
# The backup chain was self-encrypted with ONE passphrase that was never rotatable; this tool
# makes rotation a safe, verified operation. DORMANT BY DESIGN: never scheduled, never called
# by other scripts — the OPERATOR runs it by hand, then follows the printed TODO list.
#
# Usage:
#   bash scripts/rotate-backup-pass.sh            # rotate the archive only (.env untouched)
#   bash scripts/rotate-backup-pass.sh --apply    # ALSO rewrite .env BACKUP_PASSPHRASE
#                                                 # (only after a sha256-verified roundtrip)
#
# What it does (every step PASS/FAIL; ANY failure → abort with NO side effects):
#   [1/6] read OLD passphrase from .env (BACKUP_PASSPHRASE — same convention as backup.sh)
#   [2/6] prompt for a NEW passphrase (silent getpass-style, min 24 chars, typed twice)
#   [3/6] find the newest nexus-snapshot-*.zip.enc in the backup ring (same resolution
#         order as backup.sh v3.4 / restore-drill.sh: NEXUS_BACKUP_DIR → /tmp/my-project/backups
#         → legacy $ROOT/backups) and DECRYPT it to a temp file with the OLD passphrase
#   [4/6] RE-ENCRYPT the plaintext with the NEW passphrase (AES-256-CBC, PBKDF2 200k —
#         identical parameters to backup.sh) and sha256-verify a decrypt-roundtrip of the
#         NEW file against the plaintext
#   [5/6] place nexus-snapshot-<stamp>.rotated.zip.enc BESIDE the original (original untouched)
#   [6/6] --apply only: atomically rewrite .env BACKUP_PASSPHRASE (tmp + mv, perms 0600)
# Secrets are NEVER printed — only sha256 8-char fingerprints for audit linkage.
set -uo pipefail

ROOT="${NEXUS_ROOT:-/home/z/my-project}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
if [ -n "${1:-}" ] && [ "$1" != "--apply" ]; then
  echo "usage: bash scripts/rotate-backup-pass.sh [--apply]"
  exit 2
fi

echo "── NEXUS//SIGNALS backup-passphrase rotation $(date -u '+%Y-%m-%d %H:%M UTC') ──"
FAILURES=0
step() { # step <ok:0|1> <label>
  if [ "$1" = "0" ]; then echo "[PASS] $2"; else echo "[FAIL] $2"; FAILURES=$((FAILURES + 1)); fi
  [ "$1" != "0" ] && return 1 || return 0
}

# ── [1/6] OLD passphrase from .env ──
OLD_PASS=""
if [ -s "$ROOT/.env" ]; then
  OLD_PASS=$(grep '^BACKUP_PASSPHRASE=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)
fi
OLD_SHA8="none"
[ -n "$OLD_PASS" ] && OLD_SHA8=$(printf '%s' "$OLD_PASS" | sha256sum | cut -c1-8)
step "$([ -n "$OLD_PASS" ] && echo 0 || echo 1)" "[1/6] OLD BACKUP_PASSPHRASE found in .env (fingerprint sha8:${OLD_SHA8})" || {
  echo "ABORT — no side effects. Set BACKUP_PASSPHRASE in .env first."
  exit 1
}

# ── [2/6] NEW passphrase (silent prompt, min 24 chars, confirmed) ──
NEW_PASS=""
while true; do
  read -rs -r -p "NEW BACKUP_PASSPHRASE (min 24 chars): " P1; echo
  read -rs -r -p "confirm NEW BACKUP_PASSPHRASE: " P2; echo
  if [ "$P1" != "$P2" ]; then echo "  mismatch — try again"; continue; fi
  if [ "${#P1}" -lt 24 ]; then echo "  too short (${#P1} < 24 chars) — try again"; continue; fi
  if [ "$P1" = "$OLD_PASS" ]; then echo "  NEW must differ from OLD — try again"; continue; fi
  NEW_PASS="$P1"
  break
done
NEW_SHA8=$(printf '%s' "$NEW_PASS" | sha256sum | cut -c1-8)
step 0 "[2/6] NEW passphrase accepted (len:${#NEW_PASS} · fingerprint sha8:${NEW_SHA8})"

# ── [3/6] ring resolution + newest .enc + decrypt with OLD passphrase ──
CANONICAL="/tmp/my-project/backups"   # backup.sh v3.4: BACKUPS="/tmp/my-project/backups" (PolarFS)
LEGACY="$ROOT/backups"
if [ -n "${NEXUS_BACKUP_DIR:-}" ]; then
  RING="$NEXUS_BACKUP_DIR"
elif ls "$CANONICAL"/nexus-snapshot-*.zip.enc >/dev/null 2>&1; then
  RING="$CANONICAL"
elif ls "$LEGACY"/nexus-snapshot-*.zip.enc >/dev/null 2>&1; then
  RING="$LEGACY"
else
  RING="$CANONICAL"
fi
ENC_FILE=$(ls -1t "$RING"/nexus-snapshot-*.zip.enc 2>/dev/null | grep -v 'rotated' | head -1)
if [ -z "$ENC_FILE" ] || [ ! -s "$ENC_FILE" ]; then
  step 1 "[3/6] no nexus-snapshot-*.zip.enc found in ring $RING" || {
    echo "ABORT — no side effects. Run scripts/backup.sh first."
    exit 1
  }
fi
STAMP="$(basename "$ENC_FILE" .zip.enc)"; STAMP="${STAMP#nexus-snapshot-}"
ROTATED="$RING/nexus-snapshot-$STAMP.rotated.zip.enc"
echo "[3/6] ring: $RING · archive: $(basename "$ENC_FILE") (stamp $STAMP)"
if [ -e "$ROTATED" ]; then
  echo "ABORT — $ROTATED already exists (remove it first); original untouched, no side effects."
  exit 1
fi
TMPDIR_ROT=$(mktemp -d "$RING/.rotate-XXXXXX") || { echo "ABORT — cannot create temp dir in $RING"; exit 1; }
trap 'rm -rf "$TMPDIR_ROT"' EXIT
PLAIN="$TMPDIR_ROT/plain.zip"
export BACKUP_PASSPHRASE="$OLD_PASS"   # openssl -pass env:<NAME> reads the ENVIRONMENT variable
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$ENC_FILE" -out "$PLAIN" -pass "env:BACKUP_PASSPHRASE" 2>/dev/null \
   && [ -s "$PLAIN" ]; then
  step 0 "[3/6] decrypted with OLD passphrase ($(du -h "$PLAIN" | cut -f1))"
else
  step 1 "[3/6] DECRYPTION FAILED with OLD passphrase (sha8:${OLD_SHA8})" || {
    echo "ABORT — archive unopenable, no side effects. The passphrase in .env does not match this archive."
    exit 1
  }
fi

# ── [4/6] re-encrypt with NEW passphrase + sha256 roundtrip verification ──
NEW_ENC_TMP="$TMPDIR_ROT/rotated.zip.enc"
export BACKUP_PASSPHRASE="$NEW_PASS"
if openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
     -in "$PLAIN" -out "$NEW_ENC_TMP" -pass "env:BACKUP_PASSPHRASE" 2>/dev/null && [ -s "$NEW_ENC_TMP" ]; then
  step 0 "[4a] re-encrypted with NEW passphrase (AES-256-CBC/PBKDF2-200k)"
else
  step 1 "[4a] re-encryption with NEW passphrase failed" || { echo "ABORT — no side effects."; exit 1; }
fi
ROUNDTRIP="$TMPDIR_ROT/roundtrip.zip"
RT_PLAIN_SHA=$(sha256sum "$PLAIN" | cut -d' ' -f1)
RT_NEW_SHA=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$NEW_ENC_TMP" -pass "env:BACKUP_PASSPHRASE" 2>/dev/null | sha256sum | cut -d' ' -f1)
if [ -n "$RT_NEW_SHA" ] && [ "$RT_PLAIN_SHA" = "$RT_NEW_SHA" ]; then
  step 0 "[4b] decrypt-roundtrip of NEW file sha256-verified (${RT_NEW_SHA:0:12}…)"
else
  step 1 "[4b] roundtrip sha256 MISMATCH (plain:${RT_PLAIN_SHA:0:12}… new:${RT_NEW_SHA:0:12}…)" || {
    echo "ABORT — no side effects. Nothing written to the ring."
    exit 1
  }
fi

# ── [5/6] place the rotated archive BESIDE the original (original untouched) ──
if mv "$NEW_ENC_TMP" "$ROTATED" && [ -s "$ROTATED" ]; then
  chmod 600 "$ROTATED" 2>/dev/null || true
  step 0 "[5/6] rotated archive placed: $(basename "$ROTATED") ($(du -h "$ROTATED" | cut -f1)) · ORIGINAL UNTOUCHED"
else
  step 1 "[5/6] failed to place rotated archive" || { echo "ABORT — original untouched."; exit 1; }
fi

# ── [6/6] .env rewrite — ONLY with --apply and ONLY here, after the verified roundtrip ──
if [ "$APPLY" = "1" ]; then
  TMPENV="$ROOT/.env.rotate-$$"
  # filter out the OLD key line (grep -v exits 1 when nothing remains — not an error)
  grep -v '^BACKUP_PASSPHRASE=' "$ROOT/.env" > "$TMPENV" 2>/dev/null || true
  printf 'BACKUP_PASSPHRASE=%s\n' "$NEW_PASS" >> "$TMPENV"
  chmod 600 "$TMPENV"
  if mv "$TMPENV" "$ROOT/.env"; then
    echo "[6/6] verify: .env now holds $(grep -c '^BACKUP_PASSPHRASE=' "$ROOT/.env") BACKUP_PASSPHRASE line(s)"
    step 0 "[6/6] --apply: .env BACKUP_PASSPHRASE rewritten atomically (tmp + mv, 0600) — now decrypts with sha8:${NEW_SHA8}"
  else
    rm -f "$TMPENV" 2>/dev/null
    step 1 "[6/6] --apply: .env rewrite FAILED — .env unchanged; the rotated archive is still valid, rewrite the key by hand"
  fi
else
  step 0 "[6/6] default mode: .env LEFT UNTOUCHED (re-run with --apply to rewrite it)"
fi

echo ""
echo "────────────────────────── OPERATOR TODO ──────────────────────────"
if [ "$APPLY" != "1" ]; then
  echo " 1. VERIFY the rotated archive yourself (never trust the tool blindly):"
  echo "    BACKUP_PASSPHRASE='<NEW_PASSPHRASE>' openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \\"
  echo "      -in $ROTATED -out /tmp/verify.zip -pass env:BACKUP_PASSPHRASE && unzip -tq /tmp/verify.zip"
  echo " 2. ONLY after step 1 passes: update BACKUP_PASSPHRASE in .env (or re-run this script with --apply)."
  echo " 3. Update your PRIVATE records (password manager / offline copy) with the new passphrase."
  echo " 4. Re-run: bash scripts/restore-drill.sh   (must PASS with the new passphrase)"
  echo " 5. Next scheduled snapshot re-versions the chain; old archives still need the OLD passphrase."
  echo "    Map passphrases→archives by their sha8 fingerprints: old sha8:${OLD_SHA8} · new sha8:${NEW_SHA8}"
else
  echo " 1. VERIFY the rotated archive yourself:"
  echo "    BACKUP_PASSPHRASE='<NEW_PASSPHRASE>' openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \\"
  echo "      -in $ROTATED -out /tmp/verify.zip -pass env:BACKUP_PASSPHRASE && unzip -tq /tmp/verify.zip"
  echo " 2. Update your PRIVATE records (password manager / offline copy) with the new passphrase (sha8:${NEW_SHA8})."
  echo " 3. Re-run: bash scripts/restore-drill.sh   (must PASS with the new passphrase)"
  echo " 4. Old archives still need the OLD passphrase (sha8:${OLD_SHA8}) — map by fingerprint."
fi
echo "────────────────────────────────────────────────────────────────────"
[ "$FAILURES" = "0" ] && exit 0 || exit 1
