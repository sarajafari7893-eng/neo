#!/usr/bin/env bash
# restore-keys.sh — ترمیم لایه‌های L1+L2 کلید بریج تووبیت از بکاپ نسخه‌دار tbenv
# رویهٔ مستند حادثه‌های وایپ (آخرین: یازدهمین، 2026-11-02 ~08:33Z) — بدون چاپ محتوای کلید
# v2 (2026-11-02، فرمان اپراتور — مهاجرت اسکرو به مسیر پایدارتر):
#   ① انتخاب پویا: newest tbenv-*.enc از /tmp/my-project/backups/env (یا ریشهٔ بکاپ)
#   ② L2 دو-سطحی: sealed copy همیشه روی هر دو سطح نوشته می‌شود —
#      /tmp/my-project/secrets (PolarFS، وایپ‌پذیر نیست) + /home/z/.nexus-secrets (legacy)
#   ③ گذرواژه: BACKUP_PASSPHRASE از .env، و اگر .env مرده بود از
#      /tmp/my-project/secrets/backup.pass (یا legacy twin)
set -u
ROOT="/home/z/my-project"
L1="$ROOT/mini-services/toobit-bridge/.env"
POLAR_DIR="/tmp/my-project/secrets"
L2_DIR="/home/z/.nexus-secrets"
EXPECT_SHA8="${1:-36554c1a}"

# ── source: newest tbenv backup (PolarFS) ────────────────────────────────────
SRC=""
for d in "/tmp/my-project/backups/env" "/tmp/my-project/backups"; do
  if [ -d "$d" ]; then
    CAND=$(ls -1t "$d"/tbenv-*.enc 2>/dev/null | head -1)
    [ -n "$CAND" ] && { SRC="$CAND"; break; }
  fi
done
[ -s "$SRC" ] || { echo "FAIL: no tbenv-*.enc backup found on PolarFS"; exit 1; }

# ── passphrase: env var → PolarFS backup.pass → legacy twin ─────────────────
PASSSPEC="env:BACKUP_PASSPHRASE"
if [ -z "${BACKUP_PASSPHRASE:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a; source "$ROOT/.env"; set +a
fi
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  if [ -s "$POLAR_DIR/backup.pass" ]; then PASSSPEC="file:$POLAR_DIR/backup.pass"
  elif [ -s "$L2_DIR/backup.pass" ]; then PASSSPEC="file:$L2_DIR/backup.pass"
  else echo "FAIL: no BACKUP_PASSPHRASE (env + both backup.pass surfaces)"; exit 1; fi
fi

DEC=$(mktemp)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$SRC" -pass "$PASSSPEC" -out "$DEC" 2>/dev/null || { echo "FAIL: decrypt ($SRC)"; rm -f "$DEC"; exit 1; }
SHA=$(sha256sum "$DEC" | cut -d' ' -f1)
echo "source: $SRC"
echo "sha256(decrypted) = $SHA"
case "$SHA" in "$EXPECT_SHA8"*) echo "VERIFY OK (prefix $EXPECT_SHA8)";; *) echo "FAIL: fingerprint mismatch (expected $EXPECT_SHA8…) — abort"; rm -f "$DEC"; exit 1;; esac

mkdir -p "$(dirname "$L1")"
cp "$DEC" "$L1" && chmod 600 "$L1"
# v2 dual-surface sealed copy — PolarFS first (survives the wipe surface /home/z)
mkdir -p "$POLAR_DIR" && chmod 700 "$POLAR_DIR" 2>/dev/null
cp "$DEC" "$POLAR_DIR/toobit-bridge.env" && chmod 600 "$POLAR_DIR/toobit-bridge.env"
mkdir -p "$L2_DIR" && chmod 700 "$L2_DIR"
cp "$DEC" "$L2_DIR/toobit-bridge.env" && chmod 600 "$L2_DIR/toobit-bridge.env"
rm -f "$DEC"
echo "L1 restored: $L1 ($(stat -c%s "$L1")B mode $(stat -c%a "$L1"))"
echo "L2 restored: $POLAR_DIR/toobit-bridge.env ($(stat -c%s "$POLAR_DIR/toobit-bridge.env")B mode $(stat -c%a "$POLAR_DIR/toobit-bridge.env"))"
echo "L2 restored: $L2_DIR/toobit-bridge.env ($(stat -c%s "$L2_DIR/toobit-bridge.env")B mode $(stat -c%a "$L2_DIR/toobit-bridge.env"))"
