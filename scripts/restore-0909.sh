#!/bin/bash
# OP-SJ-RESTORE-0909 — adopt the decrypted Sep-8 19:31 UTC snapshot as the live tree.
# Phase A: file adoption (no downtime) · Phase B: DB swap (short downtime) · Phase C: verify.
set -uo pipefail
cd /home/z/my-project
SNAP=restore-staging/snap
TS=$(date -u +%Y%m%d-%H%M%S)
echo "== PHASE A: file adoption =="

# rollback tars of the current tree pieces we are about to replace
tar cf "/tmp/pre-restore-src-$TS.tar" src prisma scripts docs mini-services 2>/dev/null
cp worklog.md "/tmp/pre-restore-worklog-$TS.md"
cp .env "/tmp/pre-restore-env-$TS"
echo "rollback tars written to /tmp/pre-restore-*-$TS"

# 1) src — zip is a verified superset (comm showed zero current-only app/lib files)
rsync -a --delete "$SNAP/src/" src/
# 2) config + deps + supporting dirs
cp -f "$SNAP/package.json" "$SNAP/bun.lock" "$SNAP/tsconfig.json" "$SNAP/next.config.ts" \
      "$SNAP/postcss.config.mjs" "$SNAP/components.json" "$SNAP/eslint.config.mjs" "$SNAP/Caddyfile" ./
rsync -a "$SNAP/prisma/" prisma/
rsync -a --exclude node_modules "$SNAP/mini-services/" mini-services/
rsync -a "$SNAP/docs/" docs/
# scripts: overlay (zip wins on same-name, current-only survive)
rsync -a "$SNAP/scripts/" scripts/
mkdir -p backups && cp -f "$SNAP/backups/MANIFEST.json" "$SNAP/backups/calibration-latest.json" backups/ 2>/dev/null

# 3) .env: snapshot version (token + BACKUP_PASSPHRASE) + the chat id the relay needs
cp -f "$SNAP/.env" .env
grep -q "TELEGRAM_CHAT_ID" .env || echo "TELEGRAM_CHAT_ID=102140064" >> .env
echo ".env merged:"; sed 's/\(TOKEN=\).\{6\}.*/\1***/' .env

# 4) worklog: zip's authoritative pre-resync history + post-resync sections from current
BOUNDARY=$(rg -n "^Task: Root-cause the daily-report cron failure" worklog.md | head -1 | cut -d: -f1)
if [ -n "$BOUNDARY" ]; then
  DIV=$(awk -v b="$BOUNDARY" 'NR<b && /^---$/ {l=NR} END{print l}' worklog.md)
  [ -z "$DIV" ] && DIV=$((BOUNDARY - 1))
  tail -n +$((DIV + 1)) worklog.md > /tmp/worklog-post-resync.md
  cat "$SNAP/worklog.md" /tmp/worklog-post-resync.md > worklog.md
  echo "worklog merged: zip base + $(wc -l < /tmp/worklog-post-resync.md) post-resync lines"
else
  cp -f "$SNAP/worklog.md" worklog.md
  echo "worklog: zip base (boundary not found)"
fi

# 5) deps + prisma client
bun install 2>&1 | tail -2
bunx prisma generate 2>&1 | tail -2
echo "== PHASE A DONE =="

echo "== PHASE B: DB swap =="
python3 scripts/restore-donors.py || { echo "DONOR MERGE FAILED — aborting before downtime"; exit 2; }

pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 2
cp -f db/custom.db "db/custom.db.pre-restore-$TS.db"
mv -f db/custom.db.restored db/custom.db
echo "DB swapped (old kept as db/custom.db.pre-restore-$TS.db)"

bash scripts/dev-up.sh >/dev/null 2>&1
for i in $(seq 1 30); do
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "pulse after restart: $code"
echo "== PHASE B DONE =="
