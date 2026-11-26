#!/bin/bash
# NEXUS//SIGNALS — app supervisor loop v2 (STAB-20261029, trace 1a184d8bbb826f0d)
# The missing link between the ram-shed self-recycle and the platform chain:
# dev-up.sh is a one-shot spawner; when next-server exits (controlled recycle
# by design), this loop re-enters dev-up.sh. Two hard lessons from the first
# deployment (measured 23:49-23:52Z): (1) re-entering while the app is still
# in its compile/boot window makes the NEXT dev-up run pkill the warming
# server → infinite restart thrash — so every spawn gets a 75s boot grace
# (matches p0-watchdog HEAL_GRACE_S) before re-judgement; (2) duplicate loops
# must never race — flock single-instance guard. Down-gated: while /api/pulse
# answers 200 the loop only sleeps. p0-watchdog (:3020) stays second line.
LOG=/home/z/my-project/dev.log
LOCK=/home/z/my-project/.data/app-supervisor.lock
mkdir -p /home/z/my-project/.data
exec 9>"$LOCK"
flock -n 9 || exit 0  # a supervisor is already holding the watch
down() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)" != "200" ]; }
while true; do
  if down; then
    echo "[app-supervisor] app down $(date -u '+%H:%M:%SZ') — re-entering dev-up (STAB-20261029)" >> "$LOG"
    bash /home/z/my-project/scripts/dev-up.sh >> "$LOG" 2>&1 || true
    # boot grace — never re-enter (and never pkill) while the spawn may still
    # be compiling its first route (dev-mode cold compile measured 15-29s/route
    # under memory pressure; pulse is the last route to settle).
    for _ in $(seq 1 15); do
      sleep 5
      if ! down; then break; fi
    done
    if down; then
      echo "[app-supervisor] spawn still down after 75s grace $(date -u '+%H:%M:%SZ') — next cycle" >> "$LOG"
    fi
  fi
  sleep 8
done
