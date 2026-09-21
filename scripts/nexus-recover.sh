#!/bin/bash
# NEXUS-LIVE app recovery — v8.4.1 keepalive hardening (2026-09-11/12)
# Context: post-OOM restarts spawned via `nohup bash scripts/dev-up.sh &` from
# tool shells sometimes left NO next process and no log output (both the script
# and its setsid child vanished). This script is the durable fallback:
#   1. honors the p0-watchdog pause contract (writes pause-until +120s)
#   2. kills squatters, starts next dev FULLY DETACHED (setsid + nohup double
#      insurance) with its own boot log under logs/
#   3. probes up to 70s, then prints one verdict line
# Usage: bash scripts/nexus-recover.sh   (safe to re-run; idempotent-ish)

APP=/home/z/my-project
LOG=$APP/logs/nexus-recover.log
mkdir -p "$APP/.data/p0-watchdog" "$APP/logs"
echo "[$(date '+%F %T')] recover start (pulse probe first)" >> "$LOG"

code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)
if [ "$code" = "200" ]; then
  echo "[$(date '+%F %T')] already up (pulse 200) — nothing to do" >> "$LOG"
  echo "RECOVER-SKIP app:200"
  exit 0
fi

# pause layer-1 watchdog so it never races this restart (same contract as dev-up.sh)
echo $(( $(date +%s) + 120 )) > "$APP/.data/p0-watchdog/pause-until"

# clear squatters
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null
sleep 1

cd "$APP" || exit 1
# double-detached spawn: setsid new session + nohup immune to HUP; own log
setsid nohup env NODE_OPTIONS="--max-old-space-size=1400" \
  ./node_modules/.bin/next dev -p 3000 >> "$APP/dev.log" 2>&1 < /dev/null &
echo "[$(date '+%F %T')] spawned pid $!" >> "$LOG"

code=000
for i in $(seq 1 35); do
  sleep 2
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)
  [ "$code" = "200" ] && break
done

echo "[$(date '+%F %T')] recover verdict pulse:$code" >> "$LOG"
echo "RECOVER-DONE pulse:$code"
