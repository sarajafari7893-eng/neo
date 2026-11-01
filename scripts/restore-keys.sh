#!/usr/bin/env bash
# restore-keys.sh — ترمیم لایه‌های L1+L2 کلید بریج تووبیت از بکاپ نسخه‌دار tbenv
# رویهٔ مستند حادثهٔ 2026-11-01 09:42Z + تکرار 18:43Z — بدون چاپ محتوای کلید
set -u
ROOT="/home/z/my-project"
SRC="/tmp/my-project/backups/env/tbenv-36554c1a-20261031-185428.enc"
L1="$ROOT/mini-services/toobit-bridge/.env"
L2_DIR="/home/z/.nexus-secrets"
L2="$L2_DIR/toobit-bridge.env"
EXPECT_SHA8="36554c1a"

[ -s "$SRC" ] || { echo "FAIL: backup missing: $SRC"; exit 1; }
# passphrase از root .env (بدون نمایش)
set -a; source "$ROOT/.env"; set +a
DEC=$(mktemp)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$SRC" -pass "env:BACKUP_PASSPHRASE" -out "$DEC" 2>/dev/null || { echo "FAIL: decrypt"; rm -f "$DEC"; exit 1; }
SHA=$(sha256sum "$DEC" | cut -d' ' -f1)
echo "sha256(decrypted) = $SHA"
case "$SHA" in "$EXPECT_SHA8"*) echo "VERIFY OK (prefix $EXPECT_SHA8 matches known key fingerprint)";; *) echo "FAIL: fingerprint mismatch — abort, no write"; rm -f "$DEC"; exit 1;; esac
# L1
mkdir -p "$(dirname "$L1")"
cp "$DEC" "$L1" && chmod 600 "$L1"
# L2
mkdir -p "$L2_DIR" && chmod 700 "$L2_DIR"
cp "$DEC" "$L2" && chmod 600 "$L2"
rm -f "$DEC"
echo "L1 restored: $L1 ($(stat -c%s "$L1") bytes, mode $(stat -c%a "$L1"))"
echo "L2 restored: $L2 ($(stat -c%s "$L2") bytes, mode $(stat -c%a "$L2"))"
echo "NEXT: KEYS-HOTRELOAD (30s watcher) installs at runtime; verify /health keysInstalled:true"
