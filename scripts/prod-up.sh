#!/bin/bash
# ── NEXUS//SIGNALS — PRODUCTION UP (audit P0-3 escape hatch, task 5-d, 2026-09-20) ──
#
# WHY THIS EXISTS (audit 3-d P0-3): the dev server (next dev + Turbopack) is the
# de-facto production runtime on this box — the root cause of the OOM/ENOSPC/
# split-brain incident class (2 OOM kills, SST corruption ×3, ENOSPC mid-stage).
# Turbopack native memory sits OUTSIDE the 1400MB V8 heap cap and its dev cache
# regrows unbounded. A standalone production build has no dev compiler in the
# request path at all — this script is the operator's one-command escape hatch
# to that runtime.
#
# ⚠ NOT FOR THE SANDBOX: `bun run build` is forbidden in the live dev sandbox
# (it would evict the running dev server's .next and burn the disk budget).
# This script is COMMITTED BUT DORMANT — run it only on a box where the
# operator has decided to switch to the production runtime (or after a full
# recovery, per RECOVERY-RUNBOOK). The lead's central restart flow continues to
# use scripts/dev-up.sh until the operator flips the switch.
#
# ONE-LINE SWITCH NOTE: to make production the permanent runtime, point the
# keep-alive cron (job 354312) and the watchdog heal paths (watchdog.sh
# ACTION + backup.sh SNAP-RESTART) at `prod-up.sh` instead of `dev-up.sh` —
# every consumer probes /api/pulse and is runtime-agnostic otherwise.
#
# Pattern: mirrors scripts/dev-up.sh's probe-gated, idempotent contract:
#   probe :3000/api/pulse → healthy ⇒ nothing touched (except watchdog arming)
#   down ⇒ pause layer-1/layer-2 watchdogs → clean stop → prisma generate →
#   heap-capped production build → start .next/standalone/server.js (bun) →
#   wait for 200 → self-warm → re-arm BOTH watchdog layers.
set -u

ROOT=/home/z/my-project
LOG="$ROOT/prod.log"
PROBE_URL="http://localhost:3000/api/pulse"
BUILD_LOG="$ROOT/prod-build.log"

probe() { curl -s -m "$2" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }

mkdir -p "$ROOT/.data/p0-watchdog" "$ROOT/logs"

code=$(probe "$PROBE_URL" 5)
if [ "$code" = "200" ]; then
  echo "app:200 (already serving — prod-up is probe-gated, nothing rebuilt)"
else
  # ── pause BOTH watchdog layers for the whole build+boot window (5min) —
  # a building app looks "down"; never race the guardians (dev-up contract)
  echo $(( $(date +%s) + 300 )) > "$ROOT/.data/p0-watchdog/pause-until"
  echo "[prod-up] app down (http:$code) — building production bundle (log: $BUILD_LOG)"

  # stale instance cleanup (port squatters, dev + server processes)
  pkill -f "next dev" 2>/dev/null
  pkill -f "next-server" 2>/dev/null
  sleep 1

  cd "$ROOT" || exit 1
  # heap-capped generate + build (same 1400MB budget doctrine as dev-up)
  NODE_OPTIONS="--max-old-space-size=1400" NODE_ENV=production bunx prisma generate >> "$BUILD_LOG" 2>&1
  NODE_OPTIONS="--max-old-space-size=1400" NODE_ENV=production bunx next build >> "$BUILD_LOG" 2>&1
  if [ ! -f "$ROOT/.next/standalone/server.js" ]; then
    echo "[prod-up] BUILD FAILED — .next/standalone/server.js missing (see $BUILD_LOG); leaving watchdogs paused 60s grace, aborting"
    echo $(( $(date +%s) + 60 )) > "$ROOT/.data/p0-watchdog/pause-until"
    exit 1
  fi

  # static assets live in .next/static + public — standalone needs them copied next to it
  rm -rf "$ROOT/.next/standalone/.next/static" "$ROOT/.next/standalone/public" 2>/dev/null
  cp -r "$ROOT/.next/static" "$ROOT/.next/standalone/.next/static" 2>/dev/null
  cp -r "$ROOT/public" "$ROOT/.next/standalone/public" 2>/dev/null

  # start the standalone server, heap-capped, detached (owned by this tree)
  setsid bash -c 'NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1 NODE_OPTIONS="--max-old-space-size=1400" exec bun .next/standalone/server.js >> prod.log 2>&1' < /dev/null >> "$LOG" 2>&1 &

  for i in $(seq 1 36); do
    sleep 5
    code=$(probe "$PROBE_URL" 5)
    [ "$code" = "200" ] && break
  done
  echo "[prod-up] app:$code after production start"
fi

# ── dashboard SELF-WARM (same doctrine as dev-up.sh: first browser visit must not hang) ──
(
  for i in 1 2 3 4; do
    sleep 10
    c=$(curl -s -m 60 -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null || true)
    if [ "$c" = "200" ]; then
      echo "[prod-up] dashboard self-warm OK (try $i)"
      break
    fi
  done
) >> "$LOG" 2>&1 &

# ── arm BOTH watchdog layers (identical contract to dev-up.sh) ──
# layer-2 (bash, 60s fallback)
WD_DIR="$ROOT/.data/watchdog"; WD_PIDF="$WD_DIR/pid"
WD_ALIVE=0
if [ -f "$WD_PIDF" ]; then
  WD_PID=$(cat "$WD_PIDF" 2>/dev/null)
  [ -n "$WD_PID" ] && kill -0 "$WD_PID" 2>/dev/null && WD_ALIVE=1
fi
if [ "$WD_ALIVE" = "0" ]; then
  mkdir -p "$WD_DIR"
  nohup bash "$ROOT/scripts/watchdog.sh" --loop >> "$WD_DIR/loop.out" 2>&1 &
  echo "$!" > "$WD_PIDF"
  echo "[prod-up] layer-2 watchdog ARMED (pid $!)"
else
  echo "[prod-up] layer-2 watchdog already armed (pid $(cat "$WD_PIDF"))"
fi
# layer-1 (bun :3020, idempotent: lockfile pid-liveness + port bind inside)
bash "$ROOT/scripts/watchdog-up.sh"
