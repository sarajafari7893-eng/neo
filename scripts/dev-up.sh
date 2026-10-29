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
# v14.0 (STAB trace 1a185042c872b4f9): SERVE-MODE switch — .data/serve-mode
#   "prod" spawns the standalone production server (OOM root-cure) with an
#   identical probe/watchdog contract; AUTO-FRESH rebuilds the artifact
#   (scripts/prod-build.sh) instead of wiping .next. Missing artifact →
#   fail-safe dev fallback. See the SERVE-MODE block below.
#   Layer 2 (slow fallback, 60s): scripts/watchdog.sh v3.0 — app heal ONLY when
#     layer-1 is paused/dead (shared pause + 480s cooldown + breaker), RSS/mem
#     alerts, and revives layer-1 itself if it dies (supervisor-of-supervisor).
#   Coordination: THIS script writes .data/p0-watchdog/pause-until (+120s) before
#     touching next-server, so layer 1 never races an operator-driven restart.
#
# v8.2 (TASK-39, 2026-09-27): memory envelope closed on BOTH sides.
#   V8 heap 1400MB (unchanged, line one) + turbopack native now capped 768MiB via
#   next.config.ts experimental.turbopackMemoryLimit. Validated steady-state:
#   next-server RSS ~2.0-2.2GB plateau (was: unbounded ramp → mem-crit → probe
#   timeout → heal treadmill, 6 recoveries/day), MemAvailable ~850-1000MB →
#   sentinel GREEN. Layer-2 RSS_WARN_MB re-validated 1800 → 2300 to match.
mkdir -p /home/z/my-project/.data/p0-watchdog

# v8.3 (RECOVERY-0927): when spawned from inside a watchdog cycle we inherit the
# cycle's locked flock fd (9). Inheriting children pin that lock forever and
# blind every later cycle — close it before spawning anything of our own.
exec 9>&- 2>/dev/null

# ── v8.4 (Task 73, SENTINEL-20261003-0020 rec P2) — fresh-wipe escalation ──
# 2026-10-03 crash-loop lesson: when the turbopack SST cache is corrupt, a bare
# restart (what every heal does) lands on the SAME corrupt cache and dies again
# → 5min heal-treadmill. Fix: dev-up.sh now tracks its OWN consecutive-fail
# streak (.data/dev-up/fail-streak) — the single source of truth covering ALL
# callers (layer-1 heal, layer-2 fallback, backup.sh repair, human). On the 3rd
# consecutive failed spawn the restart becomes FRESH: full `rm -rf .next` while
# the server is verifiably dead. Explicit `--fresh` forces the same path.
# Also hardened (v8.4): graceful kill now WAITS for real process exit (pkill -f
# "next dev" alone never killed next-server — verified lesson) with pkill -9
# fallback + port-close wait, closing the double-writer race that corrupts .next.
FRESH=0
[ "${1:-}" = "--fresh" ] && FRESH=1

# v8.5 (STAB-20261022-a) — spawner unification: foreground supervisor contract.
# The platform chain (tini → /start.sh → bun run dev) needs its callee to HOLD
# for the app's lifetime; a detaching spawner makes the chain think the app
# died and re-races it (the three-spawner war). --foreground: after ALL
# arming/warm-up logic below completes, WAIT on the spawned app pid instead of
# exiting. Background mode (no arg) stays byte-identical to v8.4 behavior.
FOREGROUND=0
[ "${1:-}" = "--foreground" ] && FOREGROUND=1
STREAK_DIR="/home/z/my-project/.data/dev-up"
STREAK_FILE="$STREAK_DIR/fail-streak"
mkdir -p "$STREAK_DIR"

# ── v9.3 STAB-20261029 (trace 1a184d8bbb826f0d) — SINGLE-FLIGHT LOCK ─────────
# Lesson measured live 23:49-23:53Z: concurrent dev-up invocations (stale
# platform-boot instance + supervisor loop + manual run) race the pre-kill/
# spawn gate — a stale instance's pkill landed 40s AFTER a fresh spawn and
# the app thrashed (Ready→pkill→Ready→pkill, pulse never settled). flock
# makes the whole script single-flight: a second caller exits immediately.
# --stop stays lock-free so an operator can always stop through a jammed lock.
if [ "${1:-}" != "--stop" ]; then
  exec 8>"/home/z/my-project/.data/dev-up.lock"
  if ! flock -n 8; then
    echo "[dev-up] another instance holds the single-flight lock — exit ($(date -u '+%H:%M:%SZ'))"
    exit 0
  fi
fi

# ── v14.0 STAB (trace 1a185042c872b4f9) — SERVE-MODE: dev | prod ───────────
# Operator commission: «باقی‌ماندهٔ ساختاری (build محصولی برای ریشه‌کنی کامل
# OOM-cycle) کامل و مهندسی انجام بده». When .data/serve-mode contains "prod",
# this script spawns the STANDALONE production server (bun
# .next/standalone/server.js) instead of `next dev` — the structural OOM
# root-cure (dev-mode Turbopack graph + hydration spikes were the kill loop;
# prod standalone carries no compile graph). EVERYTHING else (single-flight
# lock, probe gate, fail-streak, watchdog arming, foreground contract) stays
# identical — every caller (boot chain, layer-1/2 watchdogs, app-supervisor
# loop) transparently maintains the production server through the same gate.
# Escalation in prod mode: the AUTO-FRESH path runs scripts/prod-build.sh
# (server-dead rebuild) instead of wiping .next — a dev cache wipe must never
# destroy the production artifact.
SERVE_MODE="dev"
[ -f /home/z/my-project/.data/serve-mode ] && SERVE_MODE=$(tr -d '[:space:]' < /home/z/my-project/.data/serve-mode)
[ "$SERVE_MODE" != "prod" ] && SERVE_MODE="dev"

# probe-gated restart of the Next.js server (dev or prod standalone)
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)
if [ "$code" = "200" ]; then
  echo 0 > "$STREAK_FILE" 2>/dev/null   # healthy: reset the escalation counter
else
  STREAK=$(( $(cat "$STREAK_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$STREAK" > "$STREAK_FILE" 2>/dev/null
  if [ "$STREAK" -ge 3 ] && [ "$FRESH" = "0" ]; then
    FRESH=1
    echo "[dev-up] fail-streak=$STREAK → AUTO-FRESH $(date -u '+%H:%M:%SZ') (mode=$SERVE_MODE)"
  fi
  # pause the p0-watchdogs for 120s (2× measured restart time) — never race an
  # operator-driven restart (honored by BOTH layer-1 :3020 and layer-2 v3.0)
  echo $(( $(date +%s) + 120 )) > /home/z/my-project/.data/p0-watchdog/pause-until
  # stale instance cleanup — GRACEFUL then WAIT for real exit (v8.4)
  pkill -f "next dev" 2>/dev/null
  pkill -f "next-server" 2>/dev/null
  pkill -f "standalone/server.js" 2>/dev/null
  for i in $(seq 1 15); do
    pgrep -f "next-server" >/dev/null 2>&1 || pgrep -f "next dev" >/dev/null 2>&1 || pgrep -f "standalone/server.js" >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -f "next-server" >/dev/null 2>&1 || pgrep -f "next dev" >/dev/null 2>&1 || pgrep -f "standalone/server.js" >/dev/null 2>&1; then
    echo "[dev-up] graceful stop timed out — pkill -9 fallback"
    pkill -9 -f "next-server" 2>/dev/null
    pkill -9 -f "next dev" 2>/dev/null
    pkill -9 -f "standalone/server.js" 2>/dev/null
    sleep 2
  fi
  # wait for port 3000 to close — two next-server writers on one .next is the
  # classic SST-corruption race (Task 73)
  for i in $(seq 1 10); do
    ss -ltn 2>/dev/null | grep -q ':3000 ' || break
    sleep 1
  done
  cd /home/z/my-project || exit 1
  if [ "$FRESH" = "1" ] && [ "$SERVE_MODE" = "prod" ]; then
    # v14.0 prod escalation — server verifiably dead → REBUILD the artifact
    # (never wipe .next in prod mode: that would destroy the production build)
    echo "[dev-up] prod AUTO-FRESH → rebuild $(date -u '+%H:%M:%SZ')"
    bash /home/z/my-project/scripts/prod-build.sh >> dev.log 2>&1 || echo "[dev-up] prod-build failed — next spawn will retry"
  elif [ "$FRESH" = "1" ]; then
    # server verifiably dead → full cache wipe is now SAFE (the ONLY safe moment)
    BEFORE_MB=$(du -sm .next 2>/dev/null | cut -f1 || echo 0)
    rm -rf /home/z/my-project/.next 2>/dev/null
    echo "[dev-up] FRESH wipe done: .next ${BEFORE_MB}MB → 0MB $(date -u '+%H:%M:%SZ')"
  else
    # v8.4 opportunistic trim at the one guaranteed-safe moment: the cache is
    # the disk-hygiene SCHEDULED job's deferred debt — pay it here, server dead.
    TC=".next/dev/cache/turbopack"
    if [ -d "$TC" ]; then
      TC_MB=$(du -sm "$TC" 2>/dev/null | cut -f1 || echo 0)
      if [ "${TC_MB:-0}" -gt 1024 ]; then
        rm -rf "$TC" 2>/dev/null
        echo "[dev-up] opportunistic turbopack trim: ${TC_MB}MB wiped (server dead, >1024MB)"
      fi
    fi
  fi
  # v9.2.1 (RECOVERY-20261022b, P1 spike-cut): warm-cache restore — after a
  # NON-escalated restart where .next is missing (post-reset boot, manual
  # wipe), restore the PolarFS warm cache instead of compiling cold (the
  # 2.3-3GB cold-compile spike = the VM-reset root cause). AUTO-FRESH/
  # explicit --fresh intentionally skip this: those mean the LOCAL cache was
  # corrupt, and a stamp-guarded restore of the healthy PolarFS copy is
  # deliberately deferred to the next plain restart after a green streak.
  if [ "$SERVE_MODE" = "dev" ] && [ "$FRESH" != "1" ] && [ ! -d /home/z/my-project/.next/dev ]; then
    bash /home/z/my-project/scripts/next-cache.sh restore >> /home/z/my-project/logs/next-cache.log 2>&1 || true
  fi
  # v9.0 EQ-97 MEMORY FLOOR before spawn — the two Oct-11 OOMs were cold
  # compiles landing on a memory-starved box (MemAvailable <350MB). After the
  # old server dies its RSS returns to the OS quickly; WAIT for the floor
  # (≤60s) before spawning so the fresh server never boots into a squeeze.
  # Fail-open: after the timeout we spawn anyway — the watchdog remains the
  # second line of defense.
  memavail() { awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 9999; }
  for i in $(seq 1 12); do
    m=$(memavail)
    [ "$m" -ge 550 ] && break
    echo "[dev-up] mem floor ${m}MB < 550MB — pre-spawn wait $i $(date -u '+%H:%M:%SZ')"
    sleep 5
  done
  # v9.2 (EQ-98 escalation, 2026-10-13 ~09:15Z): v9.1's 1024MB cap did NOT stop
  # the kill loop — dmesg: THREE more kernel kills within 4.5min (pids 12413/
  # 13254/13960, all anon-rss ~2.04-2.11GB) during warm-cache hydration spikes.
  # The binding constraint is the HYDRATION SPIKE, not the steady heap. New
  # envelope: V8 768MB (the pre-0927 validated value; telegram-arm.sh precedent)
  # + turbopack native 384MiB (next.config.ts) → target plateau 1.4-1.7GB,
  # spike ≤1.8GB, avail stays >800MB → kernel never reaches the trigger.
  # 109 total OOM kills in 11 days on this box — this is the line in the sand.
  if [ "$SERVE_MODE" = "prod" ]; then
    # v14.0 — production standalone server (no compile graph → no OOM kill loop).
    # Failsafe: a missing artifact falls back to the dev server so the box can
    # never be left dark by a bad build.
    if [ -f /home/z/my-project/.next/standalone/server.js ]; then
      setsid bash -c 'cd /home/z/my-project && NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 exec bun .next/standalone/server.js >> dev.log 2>&1' < /dev/null &
    else
      echo "[dev-up] prod artifact MISSING — falling back to dev server $(date -u '+%H:%M:%SZ')"
      setsid bash -c 'NODE_OPTIONS="--max-old-space-size=768" exec ./node_modules/.bin/next dev -p 3000 >> dev.log 2>&1' < /dev/null &
    fi
  else
    setsid bash -c 'NODE_OPTIONS="--max-old-space-size=768" exec ./node_modules/.bin/next dev -p 3000 >> dev.log 2>&1' < /dev/null &
  fi
  APP_PID=$!   # v8.5: captured for the --foreground supervisor contract (harmless in bg mode)
  for i in $(seq 1 30); do
    sleep 2
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)
    [ "$code" = "200" ] && break
  done
  # v8.4: outcome feeds the streak — 200 heals the counter, failure keeps it
  # climbing so the NEXT spawn escalates to AUTO-FRESH.
  if [ "$code" = "200" ]; then echo 0 > "$STREAK_FILE" 2>/dev/null; else echo "$STREAK" > "$STREAK_FILE" 2>/dev/null; fi
fi
echo "app:$code"

# ── (3) dashboard SELF-WARM (operator-approved 2026-09-15 «تایید می کنم صفحه خودکار گرم بماند») ──
# Dev-mode cold compile of the single-page dashboard takes ~11s (measured:
# GET / 200 in 11.1s, compile 11.1s / render 49ms) — the first browser visit
# after any restart HANGS. Background-warm the root once the port answers:
# up to 4 tries x 20s apart, 90s timeout each, fully non-blocking for this
# script. Page stays compiled in the dev server until the next restart.
if [ "$SERVE_MODE" = "dev" ]; then (
  # v12.11 boot-spike cut (OOM loop 2026-10-23, 4 kernel kills): the `/` cold
  # compile lands 150-400MB on top of the engine's first cycles. Entering it
  # with RSS already near the kernel line (~2.2-2.4GB) loses the OOM race —
  # the manual staged boot survived at 830-1078MB where the warmer boot died
  # at 2583-2592MB. Guard every try: skip while RSS ≥1850MB, retry next cycle.
  for i in 1 2 3 4; do
    sleep 20
    r=$(curl -s -m 8 http://localhost:3000/api/healthz 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('rssMB') or 9999)" 2>/dev/null || echo 9999)
    if [ "${r:-9999}" -ge 1850 ] 2>/dev/null; then
      echo "[dev-up] dashboard self-warm SKIP (rss=${r}MB ≥1850 — spike guard, v12.11) try $i"
      continue
    fi
    c=$(curl -s -m 90 -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null || true)
    if [ "$c" = "200" ]; then
      echo "[dev-up] dashboard self-warm OK (try $i)"
      # v9.2.1 P1 spike-cut: refresh the warm cache for the NEXT boot —
      # background + stamp-guarded (no-op when src unchanged)
      bash /home/z/my-project/scripts/next-cache.sh save >> /home/z/my-project/logs/next-cache.log 2>&1 &
      break
    fi
  done
) >> dev.log 2>&1 &
fi

# ── v9.0 (EQ-97) SEQUENTIAL BOOT-WARMER — cold-start OOM immunization (dev only) ──────
# Incident replay (2026-10-11, twice): cold turbopack compile of burst routes
# + a reviewer chrome session → next-server RSS 2.13GB → OOM kill → heal
# treadmill. Fix: on a COLD start (fresh wipe / missing .next / fail-streak
# ≥2) compile the core routes ONE AT A TIME with 12s gaps — the heap never
# sees a burst — after waiting for the memory floor. Fast heals (streak<2,
# warm .next) keep the old fast path unchanged. Fully non-blocking.
COLD=0
[ "$FRESH" = "1" ] && COLD=1
[ -d /home/z/my-project/.next ] || COLD=1
[ "${STREAK:-0}" -ge 2 ] && COLD=1
[ "$SERVE_MODE" = "dev" ] || COLD=0
if [ "$code" = "200" ] && [ "$COLD" = "1" ]; then
(
  mem() { awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0; }
  echo "[dev-up] boot-warmer seq start mem=$(mem)MB cold=1 $(date -u '+%H:%M:%SZ')" 
  for i in $(seq 1 12); do
    m=$(mem); [ "$m" -ge 550 ] && break
    echo "[dev-up] boot-warmer mem floor wait ${m}MB < 550MB (try $i)"
    sleep 5
  done
  warm_route() {
    # v12.11 boot-spike cut — same RSS guard as the self-warm: one heavy route
    # compile at the wrong moment loses the OOM race; skipped routes compile
    # lazily on first real use instead (a one-time hang, never a kernel kill).
    local r; r=$(curl -s -m 8 http://localhost:3000/api/healthz 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('rssMB') or 9999)" 2>/dev/null || echo 9999)
    if [ "${r:-9999}" -ge 1850 ] 2>/dev/null; then
      echo "[dev-up] boot-warmer SKIP $1 (rss=${r}MB ≥1850 — spike guard, v12.11)"
      sleep 12
      return
    fi
    t0=$(date +%s)
    c=$(curl -s -m 75 -o /dev/null -w '%{http_code}' "http://localhost:3000$1" 2>/dev/null || true)
    echo "[dev-up] boot-warmer warm $1 → $c in $(( $(date +%s) - t0 ))s mem=$(mem)MB"
    sleep 12   # stagger — one compile in flight at a time
  }
  warm_route "/"
  warm_route "/api/pulse"
  warm_route "/api/signals?limit=1"
  warm_route "/api/rawcal"
  warm_route "/api/golden-lane"
  warm_route "/api/entry-levers"
  warm_route "/api/closeall"
  echo "[dev-up] boot-warmer seq done $(date -u '+%H:%M:%SZ')"
) >> dev.log 2>&1 &
fi

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
  # v8.5 (STAB-20261022-a): pgrep singleton guard — the pidfile liveness check
  # above can miss live instances spawned via another path (stale pidfile),
  # and every dev-up run used to add ANOTHER --loop (duplicates accumulate →
  # parallel kill/heal races). Never spawn when a live one already exists.
  if pgrep -f "watchdog.sh --loop" >/dev/null 2>&1; then
    echo "[dev-up] watchdog --loop already running (singleton guard) — skip spawn"
  else
    nohup bash "$WD_SH" --loop >> "$WD_DIR/loop.out" 2>&1 &
    echo "$!" > "$WD_PIDF"   # pre-write so the same-run layer-1 call sees it
    echo "[dev-up] P0 watchdog layer-2 ARMED (pid $!)"
  fi
else
  echo "[dev-up] P0 watchdog layer-2 already armed (pid $(cat "$WD_PIDF"))"
fi

# (2) layer-1 guardian — idempotent
bash /home/z/my-project/scripts/watchdog-up.sh

# (3) mem-guard boot contract (RECOVERY-1016) — the recycle that killed the app
# also killed mem-guard and nothing re-spawned it → rollback sentinel + OOM
# guard + schema gate all dead. Idempotent + probe-gated inside the script.
bash /home/z/my-project/scripts/mem-guard-up.sh || true

# (4) warm-loop boot contract (Task-45 Q4) — the headless pulse driver (:3012).
# Orphaned by the 2026-10-16 recycle and never re-armed; without it the engine
# tick depends on an open browser tab. Idempotent: pid-lock singleton inside.
cd /home/z/my-project/mini-services/warm-loop && nohup bun index.ts >> /home/z/my-project/logs/warm-loop.log 2>&1 &
echo "[dev-up] warm-loop :3012 spawn issued"

# (4-b) v12.12 card-sentinel :3022 — flow-card freshness governor (operator
# order «ماژول نظارت کارت‌های کهنه»). Probes app healthz first, skips under RAM
# pressure; duplicates are harmless but probe-gate anyway.
if ! curl -sf -m 2 http://127.0.0.1:3022/health >/dev/null 2>&1; then
  cd /home/z/my-project/mini-services/card-sentinel && nohup bun index.ts >> /home/z/my-project/logs/card-sentinel.log 2>&1 &
  echo "[dev-up] card-sentinel :3022 spawn issued"
else
  echo "[dev-up] card-sentinel :3022 already alive — skip"
fi

# ── v9.3 STAB-20261029 (trace 1a184d8bbb826f0d) — RE-ARM THE APP SUPERVISOR LOOP
# The supervisor loop (scripts/app-supervisor-loop.sh) is the fast-respawn link
# between the ram-shed self-recycle and the platform chain (revives the app in
# ~15s instead of the watchdog's ≥120s pause window). Measured live: the loop's
# tiny bash can fall in kernel-OOM crossfire during heavy compile spikes while
# next-server (2GB+) is the primary victim. Self-healing: every successful
# dev-up pass (entered by boot, watchdog heal, or the loop itself) re-arms the
# loop if missing. Idempotent — the loop flocks its own single-instance guard.
if ! pgrep -f "app-supervisor-loop.sh" >/dev/null 2>&1; then
  setsid bash /home/z/my-project/scripts/app-supervisor-loop.sh </dev/null >/dev/null 2>&1 &
  echo "[dev-up] app supervisor loop re-armed (STAB-20261029)"
fi

# ── v8.5 (STAB-20261022-a) FOREGROUND CONTRACT — hold for the supervisor ────
# Everything above (pre-kill gate, mem floor, spawn, pulse wait, self-warm,
# boot-warmer, watchdog/mem-guard/warm-loop arming) already ran in normal
# flow. Now HOLD so the platform chain sees a live callee for the app's
# lifetime; when the app dies, exit → the supervisor re-enters through the
# SAME pre-kill/warm-up/single-spawner gate.
if [ "$FOREGROUND" = "1" ]; then
  if [ -n "${APP_PID:-}" ]; then
    echo "[dev-up] foreground: holding on app pid $APP_PID (platform-supervisor contract)"
    wait "$APP_PID"
    echo "[dev-up] app pid $APP_PID exited rc=$? — releasing to supervisor respawn"
  else
    # Healthy-at-attach: probe was 200, no spawn happened. Hold by polling so
    # the supervisor does NOT busy-loop re-running this script every second.
    echo "[dev-up] foreground: app already healthy — attach-hold (poll)"
    while pgrep -f "next dev" >/dev/null 2>&1 || pgrep -f "next-server" >/dev/null 2>&1 || pgrep -f "standalone/server.js" >/dev/null 2>&1; do
      sleep 30
    done
    echo "[dev-up] app gone — releasing to supervisor respawn"
  fi
  exit 0
fi
exit 0
