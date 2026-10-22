#!/usr/bin/env bash
# ── NEXUS WARM-LOOP (v10.20.1 — M1 mission «چرا داشبورد گرم نمی‌ماند؟») ──────
# Root cause (incident 2026-09-22): sandbox suspension kills the process and
# its Turbopack compile cache; dev-up.sh §3 warms ONCE at boot only, so the
# first visitor after ANY restart/resume hangs ~11s+ on cold compile.
# This loop re-warms every 5min: GET / (page compile) + /api/pulse (engine
# handshake). Idempotent via pid file; zero domain writes — pure local HTTP.
# Honesty: while the sandbox is fully SUSPENDED nothing runs from inside —
# the loop's value is the ≤5min re-warm right after every resume/restart.
DIR="$(cd "$(dirname "$0")/.." && pwd)"; cd "$DIR" || exit 1
mkdir -p logs .data
PIDF=".data/warm-loop.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
  echo "[warm-loop] already alive (pid $(cat "$PIDF")) — exit"; exit 0
fi
echo $$ > "$PIDF"
echo "[warm-loop] armed pid $$ — 5min cycle: GET / + /api/pulse"
while true; do
  sleep 300
  c1=$(curl -s -m 90 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ 2>/dev/null || true)
  c2=$(curl -s -m 15 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/pulse 2>/dev/null || true)
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] warm /:$c1 pulse:$c2"
  if [ "$c1" != "200" ]; then
    echo "[warm-loop] page cold/failed ($c1) — retry next cycle (restart ownership stays with the p0-watchdog layers)"
  fi
done
