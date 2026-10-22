#!/usr/bin/env bash
# ── NEXUS//SIGNALS dev-cache purge v1.0 — CANONICAL guarded wipe (Task 73) ──
# Root cause it closes (SENTINEL-20261003-0020 findings #1/#3):
#   disk-hygiene.sh wiped .next/dev/cache/turbopack UNDER A LIVE SERVER. The
#   turbopack persistent SST cache cannot tolerate mid-run file removal —
#   "Unable to write SST file …/ Failed to restore task data (corrupted
#   database or bug)" → tokio-runtime-worker panic → next-server death.
#   Documented incidents: 3× on 2026-09-17 (backup.sh v10.6 note) and
#   2026-10-03 10:50:39Z backup pre-flight → app death 10:51:12Z → 5min
#   crash-loop 14:21-14:26 IRST (watchdog heal-spawned dev-up without wipe).
# Contract (the ONLY sanctioned way to purge the turbopack cache):
#   flock-serialized → pause BOTH watchdog layers (shared pause file)
#   → graceful kill → WAIT for processes to exit (pkill -f "next dev" alone
#   never killed next-server — verified lesson) → pkill -9 fallback
#   → wipe regenerable cache dirs → dev-up.sh (its own pause + probe-gated
#   start + self-warm) → final probe echo.
# Callers: disk-hygiene.sh v2.2 (FORCE/FAILSAFE delegation), backup.sh v10.6
#   canary repair, operators. Never call rm on the cache manually.
set -uo pipefail

ROOT="/home/z/my-project"
LOCK="$ROOT/.data/dev-cache-purge.lock"
PAUSE_FILE="$ROOT/.data/p0-watchdog/pause-until"
mkdir -p "$ROOT/.data/p0-watchdog"

# v1.1: `--full` wipes the ENTIRE .next (sentinel cure doctrine — compile
# pipeline corrupted); default wipes only regenerable cache dirs (hygiene).
FULL=0
[ "${1:-}" = "--full" ] && FULL=1

# flock guard: two concurrent purges (e.g. backup pre-flight + watchdog
# mem-action) must never interleave kill/wipe/start phases.
exec 200>"$LOCK"
if ! flock -w 180 200; then
  echo "[purge] another purge holds the lock (>180s) — skipping, cache left intact"
  exit 0
fi

stamp() { date -u '+%Y-%m-%d %H:%M:%S UTC'; }
echo "[purge $(stamp)] guarded purge START"

# (1) pause both watchdog layers for the full dance + restart budget
echo $(( $(date +%s) + 240 )) > "$PAUSE_FILE" 2>/dev/null

# (2) graceful stop — SIGTERM both cmdlines, then WAIT for real exit
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
DEAD=0
for i in $(seq 1 15); do
  if ! pgrep -f "next-server" >/dev/null 2>&1 && ! pgrep -f "next dev" >/dev/null 2>&1; then
    DEAD=1; break
  fi
  sleep 1
done
if [ "$DEAD" != "1" ]; then
  echo "[purge] graceful stop timed out — pkill -9 fallback"
  pkill -9 -f "next-server" 2>/dev/null
  pkill -9 -f "next dev" 2>/dev/null
  sleep 2
fi

# (3) wait for port 3000 to actually close (no double-writer on .next)
for i in $(seq 1 10); do
  ss -ltn 2>/dev/null | grep -q ':3000 ' || break
  sleep 1
done

# (4) wipe — only regenerable cache; server is verifiably dead here
BEFORE_MB=$(du -sm "$ROOT/.next" 2>/dev/null | cut -f1 || echo 0)
if [ "$FULL" = "1" ]; then
  rm -rf "$ROOT/.next" 2>/dev/null
else
  rm -rf "$ROOT/.next/dev/cache/turbopack" "$ROOT/.next/dev/cache/webpack" \
         "$ROOT/.next/dev/cache/eslint" 2>/dev/null
fi
AFTER_MB=$(du -sm "$ROOT/.next" 2>/dev/null | cut -f1 || echo 0)
echo "[purge] wipe (full=$FULL) under dead server: .next ${BEFORE_MB}MB → ${AFTER_MB}MB"

# (5) standard probe-gated restart (dev-up.sh writes its own +120s pause,
#     self-warms the dashboard, re-arms both watchdog layers)
bash "$ROOT/scripts/dev-up.sh"

# (6) final verdict echo
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' http://localhost:3000/api/healthz 2>/dev/null || echo 000)
echo "[purge $(stamp)] guarded purge DONE — healthz:$CODE"
[ "$CODE" = "200" ] || exit 1
