#!/bin/bash
# RESTORE-0909 DB swap #2 — clean-merge install with full process-death wait,
# then a 60s runtime soak with a second integrity gate.
set -uo pipefail
ROOT=/home/z/my-project
say() { echo "[swap2] $*"; }

echo $(( $(date +%s) + 900 )) > "$ROOT/.data/p0-watchdog/pause-until"
pkill -f "watchdog.sh --loop" 2>/dev/null
pkill -f "bun run dev" 2>/dev/null
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null

# wait until every app process is actually GONE (SIGTERM on a 2GB heap takes time)
for i in $(seq 1 20); do
  if ! pgrep -f "next-server|next dev" >/dev/null 2>&1; then break; fi
  sleep 1
done
if pgrep -f "next-server|next dev" >/dev/null 2>&1; then
  pkill -9 -f "next-server" 2>/dev/null; sleep 2
fi
pgrep -f "next-server|next dev" >/dev/null 2>&1 && { say "FAIL: app processes still alive"; exit 1; }
say "app fully stopped (waited ${i}s)"

rm -f "$ROOT/db/custom.db" "$ROOT/db/custom.db-wal" "$ROOT/db/custom.db-shm"
cp "$ROOT/restore-staging/rebuild/merged.db" "$ROOT/db/custom.db"
sync
say "merged DB installed ($(du -h "$ROOT/db/custom.db" | cut -f1))"

bash "$ROOT/scripts/dev-up.sh" | tail -2
for i in $(seq 1 30); do
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 2
done
say "pulse after start: $code"

# ── 60s runtime soak, then second integrity gate ──
sleep 60
cd "$ROOT" && bun -e '
const { Database } = require("bun:sqlite");
const db = new Database("db/custom.db", { readonly: true });
const r = db.prepare("PRAGMA integrity_check").get();
console.log("soak integrity:", r.integrity_check === "ok" ? "OK" : String(r.integrity_check).slice(0, 120));
console.log("signals:", JSON.stringify(db.prepare("SELECT COUNT(*) c, MAX(serial) m FROM Signal").get()));
console.log("events:", db.prepare("SELECT COUNT(*) c FROM SignalEvent").get().c, "| PP:", db.prepare("SELECT COUNT(*) c FROM PricePoint").get().c);
db.close();
'
say "soak complete"
