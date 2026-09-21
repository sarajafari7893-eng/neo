#!/bin/bash
# NEXUS//SIGNALS — P0 watchdog starter (idempotent).
# Usage: bash scripts/watchdog-up.sh
# Guards against duplicates twice: lockfile pid-liveness here + :3020 port bind
# inside the watchdog itself. Safe to call from dev-up.sh, cron, or by hand.
LOCK=/home/z/my-project/.data/p0-watchdog/lock.json
if [ -f "$LOCK" ]; then
  pid=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$LOCK" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "watchdog:alive($pid)"
    exit 0
  fi
fi
mkdir -p /home/z/my-project/logs /home/z/my-project/.data/p0-watchdog
cd /home/z/my-project/mini-services/p0-watchdog || exit 1
nohup bun run dev >> /home/z/my-project/logs/p0-watchdog-service.log 2>&1 &
echo "watchdog:spawned"
