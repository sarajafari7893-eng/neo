#!/bin/bash
# ── NEXUS//SIGNALS — DB + JOURNAL BACKUP RING (SENTINEL-20261124-DATA-HISTORY) ──
# Root-cause defense: the 2026-11-23T23:15Z workspace reset restored a STALE
# platform snapshot and a whole month of collection history showed holes. An
# in-house backup ring gives every future restore a FRESH recovery point.
# Contract: fail-open (backup failure NEVER touches the app), min-interval
# guarded (3.5h) so the watchdog hook and the standalone loop can both call it.
set -u
PROJECT=/home/z/my-project
OUT="$PROJECT/.data/db-backups"
OUT2=/tmp/nexus-db-backups
LOG="$PROJECT/scripts/db-backup.log"
mkdir -p "$OUT" "$OUT2" 2>/dev/null

STAMP="$OUT/.last-run"
NOW=$(date +%s)
LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
MIN_INTERVAL=12600   # 3.5h — double-caller guard
if [ "$((NOW - LAST))" -lt "$MIN_INTERVAL" ]; then
  exit 0
fi
echo "$NOW" > "$STAMP" 2>/dev/null

TS=$(date -u +%Y%m%d-%H%M)
TARGET="$OUT/custom-$TS.db"

# 1) consistent SQLite snapshot — VACUUM INTO is a read-consistent copy, safe
#    against the live WAL DB (no locks held on the source, no app impact)
if bun -e "import {Database} from 'bun:sqlite'; const db=new Database('$PROJECT/db/custom.db'); db.run(\"VACUUM INTO '$TARGET'\"); const c=db.query('SELECT COUNT(*) c FROM Signal').get(); db.close(); console.log('vacuum-into ok signals='+c.c);" >> "$LOG" 2>&1; then
  gzip -f "$TARGET" 2>/dev/null || true
else
  rm -f "$TARGET" 2>/dev/null
  echo "$(date -u '+%FT%TZ') backup FAIL: VACUUM INTO errored" >> "$LOG"
  exit 0
fi

# 2) critical .data journals (small, high-value)
tar czf "$OUT/dotdata-$TS.tar.gz" -C "$PROJECT" \
  .data/gate-journal.jsonl \
  .data/rawcal-run-heartbeat.txt \
  .data/fapi-gate/bans.json \
  .data/signal-events-archive.jsonl \
  .data/shadow-veto.jsonl \
  .data/stable-feed/board.json \
  .data/watchdog/state \
  2>/dev/null || true

# 3) second slot (best-effort — /tmp may not survive platform resets)
cp "$OUT/custom-$TS.db.gz" "$OUT2/" 2>/dev/null || true
cp "$OUT/dotdata-$TS.tar.gz" "$OUT2/" 2>/dev/null || true

# 4) retention: keep last 24 of each kind
ls -1t "$OUT"/custom-*.db.gz 2>/dev/null | tail -n +25 | xargs -r rm -f
ls -1t "$OUT"/dotdata-*.tar.gz 2>/dev/null | tail -n +25 | xargs -r rm -f

echo "$(date -u '+%FT%TZ') backup OK slot1=$TS size=$(stat -c %s "$OUT/custom-$TS.db.gz" 2>/dev/null || echo ?)" >> "$LOG"
