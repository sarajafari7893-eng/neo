#!/bin/bash
# RESTORE-0909 apply — the maintenance window.
# Overlays the decrypted Sep-8 19:31 snapshot (authoritative v8.x tree) onto the
# live project, installs the merged DB/worklog/.env, restarts the app under the
# v8.1 dev-up contract (1400MB heap + two-layer watchdog), and verifies.
set -uo pipefail

ROOT=/home/z/my-project
STG=$ROOT/restore-staging
SEP8=$STG/sep8
say() { echo "[restore-0909] $*"; }

# ── STEP 0: preconditions ──
[ -f "$ROOT/db/custom.db.restored" ] || { say "FAIL: merged DB missing"; exit 1; }
[ -f "$STG/worklog.merged.md" ] || { say "FAIL: merged worklog missing"; exit 1; }
[ -d "$SEP8/src" ] || { say "FAIL: snapshot staging missing"; exit 1; }
say "STEP 0 ok — preconditions present"

# ── STEP 1: safety archive of the current tree (rollback path) ──
tar czf "$STG/pre-merge-tree-0909.tar.gz" \
  --exclude=node_modules --exclude=.next --exclude=upload --exclude=tool-results \
  --exclude=restore-staging --exclude=backups --exclude=.git \
  -C "$ROOT" . 2>/dev/null
[ -s "$STG/pre-merge-tree-0909.tar.gz" ] || { say "FAIL: safety tar failed"; exit 1; }
say "STEP 1 ok — safety tar: $(du -h "$STG/pre-merge-tree-0909.tar.gz" | cut -f1)"

# ── STEP 2: pause watchdogs + stop the app ──
mkdir -p "$ROOT/.data/p0-watchdog"
echo $(( $(date +%s) + 600 )) > "$ROOT/.data/p0-watchdog/pause-until"
pkill -f "watchdog.sh --loop" 2>/dev/null
pkill -f "p0-watchdog" 2>/dev/null
pkill -f "bun run dev" 2>/dev/null
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 2
say "STEP 2 ok — watchdogs paused, app stopped"

# ── STEP 3: snapshot overlay (no --delete: current-only files survive) ──
rsync -a \
  --exclude=worklog.md --exclude=.env --exclude=db --exclude=dev.log --exclude=backups \
  "$SEP8/" "$ROOT/"
say "STEP 3 ok — overlay applied"

# ── STEP 4: merged DB install ──
rm -f "$ROOT/db/custom.db-wal" "$ROOT/db/custom.db-shm"
mv "$ROOT/db/custom.db.restored" "$ROOT/db/custom.db"
say "STEP 4 ok — merged DB installed ($(du -h "$ROOT/db/custom.db" | cut -f1))"

# ── STEP 5: merged worklog + merged .env ──
mv "$STG/worklog.merged.md" "$ROOT/worklog.md"
cat > "$ROOT/.env" << 'ENVEOF'
DATABASE_URL=file:/home/z/my-project/db/custom.db
TELEGRAM_BOT_TOKEN=8935345986:AAHmoxG3dH3xechgZSOwGYvaVFFDNFixFK0
TELEGRAM_CHAT_ID=102140064
BACKUP_PASSPHRASE=BF0W9fnhkiws/89JoIrTW4yK1ZdO498k
ENVEOF
say "STEP 5 ok — worklog (409KB true history) + .env (4 keys) installed"

# ── STEP 6: preserve the pre-resync dev.log as forensic evidence ──
[ -f "$SEP8/dev.log" ] && cp "$SEP8/dev.log" "$ROOT/docs/dev-pre-resync-0908.log"
say "STEP 6 ok — pre-resync dev.log archived to docs/"

# ── STEP 7: orphaned reconstruction-only card (original lives in terminal/) ──
if ! rg -q "components/ai/GateGaugeCard|@/src/components/ai/GateGaugeCard" "$ROOT/src" 2>/dev/null; then
  rm -f "$ROOT/src/components/ai/GateGaugeCard.tsx"
  say "STEP 7 ok — orphan ai/GateGaugeCard.tsx removed (original: terminal/GateGaugeCard.tsx)"
else
  say "STEP 7 skipped — orphan card still referenced, kept"
fi

# ── STEP 8: deps + prisma client (snapshot package.json adds `docx`) ──
cd "$ROOT" || exit 1
bun install --silent 2>&1 | tail -1
bunx prisma generate 2>&1 | tail -2
say "STEP 8 ok — bun install + prisma generate"

# ── STEP 9: start under the v8.1 contract (1400MB heap + 2-layer watchdog) ──
bash "$ROOT/scripts/dev-up.sh"
say "STEP 9 ok — dev-up v8.1 completed"

# ── STEP 10: verification battery ──
sleep 3
pulse=$(curl -s -m 8 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse)
liq=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3010/health)
ws=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3003/)
wd=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3020/ 2>/dev/null)
say "STEP 10 ports: app:$pulse liq:$liq ws:$ws(expected-400) wd:$wd"
curl -s -m 8 http://localhost:3000/api/notify | head -c 300; echo
curl -s -m 8 "http://localhost:3000/api/pulse" | head -c 200; echo
say "verify: signals count + gauge + settings"
cd "$ROOT" && bun -e '
const { Database } = require("bun:sqlite");
const db = new Database("db/custom.db", { readonly: true });
console.log("signals:", db.prepare("SELECT COUNT(*), MAX(serial) FROM Signal").get());
console.log("events:", db.prepare("SELECT COUNT(*) c FROM SignalEvent").get().c, "| PP:", db.prepare("SELECT COUNT(*) c FROM PricePoint").get().c);
console.log("settings:", db.prepare("SELECT COUNT(*) c FROM EngineSetting").get().c);
db.close();
' 2>&1 | tail -4
say "DONE — restore applied. Watch dev.log for engine tick."
