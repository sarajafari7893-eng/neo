#!/bin/bash
# ── NEXUS//SIGNALS — TOOBIT BRIDGE WATCHDOG ──────────────────────────────
# Contract (cron Job 491600, ~20min): run me; EXIT=0 → bridge healthy (silent).
# Non-zero → FAILED: operator reads last 5 lines of .data/bridge-watchdog.log,
# deep diagnosis from .data/toobit-bridge/bridge-stdout.log.
#
# v15.0 (2026-11-04): rebuilt after sandbox rollback wiped the v14.x generation
# (bridge-watchdog.sh + its log were lost; trace 1a19469b82a27fd9). Same contract,
# cwd-based process detection (cmdline is generic `bun index.ts`), freshness as
# the single liveness truth.
#
# Read-only toward trading code/data: NEVER touches engine.ts (FLAT-10),
# db/custom.db rows, or .data/toobit-bridge/state.json content. The only
# mutation this script owns: process lifecycle + its own log/markers.

PROJECT=/home/z/my-project
BR="$PROJECT/mini-services/toobit-bridge"
DATA="$PROJECT/.data/toobit-bridge"
LOG="$PROJECT/.data/bridge-watchdog.log"
STATE="$DATA/state.json"
OKMARK="$DATA/.wd-lastok"
STALE_SECS=180          # bridge writes state.json every poll cycle; 3min = dead
BOOT_WAIT=45            # seconds to wait for a fresh state after boot
HB_SECS=21600           # green heartbeat every ~6h for forensics

log(){ echo "$(date -u '+%F %T')Z $*" >> "$LOG"; }

state_age(){ echo $(( $(date +%s) - $(stat -c %Y "$STATE" 2>/dev/null || echo 0) )); }
fresh(){ [ -f "$STATE" ] && [ "$(state_age)" -lt "$STALE_SECS" ]; }

# process check by cwd — `pgrep -f toobit` cannot match `bun index.ts`
find_pid(){
  local p
  for p in $(pgrep -x bun 2>/dev/null; pgrep -x bun-node 2>/dev/null); do
    [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$BR" ] && { echo "$p"; return 0; }
  done
  return 1
}

if fresh; then
  now=$(date +%s); lastok=$(cat "$OKMARK" 2>/dev/null || echo 0)
  echo "$now" > "$OKMARK" 2>/dev/null
  if [ $((now - lastok)) -ge "$HB_SECS" ]; then
    log "OK heartbeat: bridge healthy (state age $(state_age)s, pid $(find_pid || echo '?'))"
  fi
  exit 0
fi

# ── not fresh → revive path ──────────────────────────────────────────────
alive=$(find_pid || true)
if [ -n "$alive" ]; then
  log "REVIVE: bridge HUNG (state stale $(state_age)s, pid $alive) — kill + boot"
  kill "$alive" 2>/dev/null; sleep 3
  kill -0 "$alive" 2>/dev/null && { kill -9 "$alive" 2>/dev/null; sleep 1; }
else
  log "REVIVE: bridge DEAD (state stale $(state_age)s, no proc) — booting"
fi

( cd "$BR" && setsid bash -c 'exec bun index.ts' </dev/null >> "$DATA/bridge-stdout.log" 2>&1 & )

for i in $(seq 1 $((BOOT_WAIT / 2))); do
  sleep 2
  if fresh; then
    log "REVIVE OK: state fresh after ~$((i*2))s (pid $(find_pid || echo '?'))"
    date +%s > "$OKMARK" 2>/dev/null
    exit 0
  fi
done

log "FAILED: state still stale ${BOOT_WAIT}s after revive — inspect bridge-stdout.log (tail: $(tail -1 "$DATA/bridge-stdout.log" 2>/dev/null | cut -c1-160))"
exit 1
