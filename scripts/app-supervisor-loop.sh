#!/bin/bash
# NEXUS//SIGNALS — app supervisor loop (STAB-20261029, trace 1a184d8bbb826f0d)
# The missing link between the ram-shed self-recycle and the platform chain:
# dev-up.sh is a one-shot spawner; when next-server exits (controlled recycle
# by design), this loop re-enters dev-up.sh within ~8s. Down-gated: while the
# app answers /api/pulse 200 the loop only sleeps — zero log noise, zero work.
# Duplicate-loop safe: dev-up.sh is idempotent + single-spawner + pause-gated.
# p0-watchdog (:3020) remains the second line of defense.
LOG=/home/z/my-project/dev.log
down() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)" != "200" ]; }
while true; do
  if down; then
    echo "[app-supervisor] app down $(date -u '+%H:%M:%SZ') — re-entering dev-up (STAB-20261029)" >> "$LOG"
    bash /home/z/my-project/scripts/dev-up.sh >> "$LOG" 2>&1 || true
  fi
  sleep 8
done
