#!/bin/bash
# NEXUS//SIGNALS — guardian-stack resurrection (RECOVERY-0927/0928)
# Rebuilds the two-layer watchdog contract + app (+ armor) after corruption:
#   • layer-2 loops whose script mutated under the running bash (bulk file
#     ops mid-run: git reset/restore/rollback → byte-offset chaos)
#   • layer-1 bun --hot limbo (HTTP answers, event loop frozen)
#   • app dead / running stale pre-restore code
#   • armor running stale code after bulk edits
# Usage: bash scripts/resurrect.sh [--no-armor]
#   --no-armor : when invoked BY the armor service itself (alignWorkspace) —
#                armor must not kill its own process.
# Designed to run from a PLATFORM-LINEAGE spawner (supervisor-cron backup job
# or the armor service) so every child inherits a survivable lineage.
ROOT=/home/z/my-project
cd "$ROOT" || exit 1
MODE="full"; [ "$1" = "--no-armor" ] && MODE="no-armor"

kill_by_port() { # kill the process owning a listening TCP port (cmdline-based
                # pgrep fails for `bun --hot index.ts` services — cwd invisible)
  local port="$1" pid
  pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)
  if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
    echo "[resurrect] killed port:${port} pid:${pid}"
  fi
}

echo "[resurrect] $(date -u +%FT%TZ) start (mode=${MODE})"

# 1) stop corrupted layer-2 loops
for p in $(pgrep -f "watchdog.sh --loop" 2>/dev/null); do
  kill "$p" 2>/dev/null && echo "[resurrect] killed layer-2 loop $p"
done

# 2) stop frozen/limbo layer-1 (port-owner, not cmdline)
kill_by_port 3020

# 3) stop stale armor (unless we were called BY armor)
if [ "$MODE" != "no-armor" ]; then
  kill_by_port 3016
fi

# 4) clear stale coordination state (dead-pid locks, expired pauses)
rm -f "$ROOT/.data/p0-watchdog/pause-until" "$ROOT/.data/p0-watchdog/lock.json"
rm -f "$ROOT/.data/watchdog/pid"
sleep 1

# 5) fresh armor FIRST (its boot now runs alignWorkspace — safe: tree aligned)
if [ "$MODE" != "no-armor" ]; then
  ( cd "$ROOT/mini-services/push-armor" && setsid bash -c 'exec bun run dev' </dev/null 9>&- >> "$ROOT/logs/push-armor.log" 2>&1 & )
  echo "[resurrect] armor respawned"
fi

# 6) fresh layer-1 (fast-heal owner)
bash "$ROOT/scripts/watchdog-up.sh"

# 7) app via dev-up (probe-gated, pause-protected, heap-capped 1400MB)
timeout 240 bash "$ROOT/scripts/dev-up.sh" >> "$ROOT/logs/resurrect-devup.log" 2>&1

echo "[resurrect] $(date -u +%FT%TZ) done"
