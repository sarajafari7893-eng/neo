#!/bin/bash
# NEXUS//SIGNALS — ensure the Next.js dev server is running.
# Usage: bash scripts/dev-up.sh   (safe to call repeatedly; idempotent)
# v8.0 (EPOCH-2): heap cap consolidated to 1400MB — single source of truth.
# History: v6.2 shipped 768MB, but the validated operating value after the
# 2026-09-08 OOM post-mortem (op-dash-debug-20260908) is 1400MB: bounds V8 heap
# ⇒ RSS ~1.45-1.8GB, leaving ~2.2GB headroom for reviewer chrome spikes on the
# 4GB no-swap box. Turbopack native memory stays outside the cap — the
# watchdog (heap-bounded crash → restart) is the second line of defense.
#
# v8.1 (OP-P0-WD-0909): two-layer watchdog contract.
#   Layer 1 (fast heal, 15s): mini-services/p0-watchdog :3020 — owns auto-restart
#     of app+liq+ws, Telegram escalation, state API. Honors the shared pause file.
#   Layer 2 (slow fallback, 60s): scripts/watchdog.sh v3.0 — app heal ONLY when
#     layer-1 is paused/dead (shared pause + 480s cooldown + breaker), RSS/mem
#     alerts, and revives layer-1 itself if it dies (supervisor-of-supervisor).
#   Coordination: THIS script writes .data/p0-watchdog/pause-until (+120s) before
#     touching next-server, so layer 1 never races an operator-driven restart.
mkdir -p /home/z/my-project/.data/p0-watchdog

# probe-gated restart of the Next.js dev server
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)
if [ "$code" != "200" ]; then
  # pause the p0-watchdogs for 120s (2× measured restart time) — never race an
  # operator-driven restart (honored by BOTH layer-1 :3020 and layer-2 v3.0)
  echo $(( $(date +%s) + 120 )) > /home/z/my-project/.data/p0-watchdog/pause-until
  # stale instance cleanup (port squatters)
  pkill -f "next dev" 2>/dev/null
  pkill -f "next-server" 2>/dev/null
  sleep 1
  cd /home/z/my-project || exit 1
  setsid bash -c 'NODE_OPTIONS="--max-old-space-size=1400" exec ./node_modules/.bin/next dev -p 3000 >> dev.log 2>&1' < /dev/null &
  for i in $(seq 1 30); do
    sleep 2
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)
    [ "$code" = "200" ] && break
  done
fi
echo "app:$code"

# ── (3) dashboard SELF-WARM (operator-approved 2026-09-15 «تایید می کنم صفحه خودکار گرم بماند») ──
# Dev-mode cold compile of the single-page dashboard takes ~11s (measured:
# GET / 200 in 11.1s, compile 11.1s / render 49ms) — the first browser visit
# after any restart HANGS. Background-warm the root once the port answers:
# up to 4 tries x 20s apart, 90s timeout each, fully non-blocking for this
# script. Page stays compiled in the dev server until the next restart.
(
  for i in 1 2 3 4; do
    sleep 20
    c=$(curl -s -m 90 -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null || true)
    if [ "$c" = "200" ]; then
      echo "[dev-up] dashboard self-warm OK (try $i)"
      break
    fi
  done
) >> dev.log 2>&1 &

# ── P0 WATCHDOG arming (TWO-LAYER contract, OP-P0-WD-0909 × OP-P0-WD-V3) ──
# Layer 1 (fast heal, 15s) = bun p0-watchdog :3020 — owns auto-restart of
#   app+liq+ws (kill-drills passed ~30s); armed via watchdog-up.sh (idempotent:
#   lockfile pid-liveness + :3020 port bind inside).
# Layer 2 (slow fallback, 60s) = scripts/watchdog.sh v3.1 — app heal only when
#   layer-1 is paused/dead (shared pause honored) + P3 supervisor-of-the-
#   supervisor (revives layer-1) + RSS/mem alerts + --status/--stop CLI.
# The v6.2 dormancy lesson (a watchdog that silently dies stays dead) is
# closed on BOTH layers: dev-up arms both here, /api/pulse re-arms both
# (src/lib/watchdog-arm.ts), and layer-2's P3 block revives layer-1.

# (1) layer-2 arm — idempotent via pidfile liveness
WD_DIR="/home/z/my-project/.data/watchdog"
WD_PIDF="$WD_DIR/pid"
WD_SH="/home/z/my-project/scripts/watchdog.sh"
WD_ALIVE=0
if [ -f "$WD_PIDF" ]; then
  WD_PID=$(cat "$WD_PIDF" 2>/dev/null)
  [ -n "$WD_PID" ] && kill -0 "$WD_PID" 2>/dev/null && WD_ALIVE=1
fi
if [ "$WD_ALIVE" = "0" ]; then
  mkdir -p "$WD_DIR"
  nohup bash "$WD_SH" --loop >> "$WD_DIR/loop.out" 2>&1 &
  echo "$!" > "$WD_PIDF"   # pre-write so the same-run layer-1 call sees it
  echo "[dev-up] P0 watchdog layer-2 ARMED (pid $!)"
else
  echo "[dev-up] P0 watchdog layer-2 already armed (pid $(cat "$WD_PIDF"))"
fi

# (2) layer-1 guardian — idempotent
bash /home/z/my-project/scripts/watchdog-up.sh
