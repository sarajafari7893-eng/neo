#!/bin/bash

set -euo pipefail

# ── NEXUS dev.sh v2.0 (RECOVERY-20261022b, operator order «تمام توصیه‌ها را
# کامل و مهندسی اجرا کن») — engineered boot path, superset of the Sep-23 v1:
#   STEP 0  .env integrity   — start.sh truncates .env to DATABASE_URL-only on
#            every repo.tar restore; restore the full 10-key env from the
#            PolarFS mirror BEFORE anything reads it (bun install/db/app).
#   STEP 1  next-cache       — restore warm .next from PolarFS (kills the
#            cold-compile OOM spike; stamp-guarded by scripts/next-cache.sh).
#   STEP 2  boot-kit --fix   — LINEAGE (golden db if ledger<2000) + files +
#            deps + prisma planes (scripts/boot-kit.sh v2.0); non-fatal.
#   STEP 3  bun install      — root deps (as v1).
#   STEP 4  db:push          — schema sync against the (restored) golden db.
#   STEP 5  app via dev-up.sh— heap cap 1400 + pause-protected restart +
#            dashboard self-warm + both watchdog layers armed (v1 used raw
#            `bun run dev` = UNCAPPED → the boot-spike OOM root cause).
#   STEP 6  mini-services    — v1 loop kept (idempotency locks, all 15 dirs).
#   STEP 7  next-cache save  — background, stamp-guarded (no-op if unchanged).

# 获取脚本所在目录（.zscripts）
# 使用 $0 获取脚本路径（与 build.sh 保持一致）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log_step_start() {
        local step_name="$1"
        echo "=========================================="
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting: $step_name"
        echo "=========================================="
        export STEP_START_TIME
        STEP_START_TIME=$(date +%s)
}

log_step_end() {
        local step_name="${1:-Unknown step}"
        local end_time
        end_time=$(date +%s)
        local duration=$((end_time - STEP_START_TIME))
        echo "=========================================="
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Completed: $step_name"
        echo "[LOG] Step: $step_name | Duration: ${duration}s"
        echo "=========================================="
        echo ""
}

start_mini_services() {
        local mini_services_dir="$PROJECT_DIR/mini-services"
        local started_count=0

        log_step_start "Starting mini-services"
        if [ ! -d "$mini_services_dir" ]; then
                echo "Mini-services directory not found, skipping..."
                log_step_end "Starting mini-services"
                return 0
        fi

        echo "Found mini-services directory, scanning for sub-services..."

        for service_dir in "$mini_services_dir"/*; do
                if [ ! -d "$service_dir" ]; then
                        continue
                fi

                local service_name
                service_name=$(basename "$service_dir")
                echo "Checking service: $service_name"

                if [ ! -f "$service_dir/package.json" ]; then
                        echo "[$service_name] No package.json found, skipping..."
                        continue
                fi

                if ! grep -q '"dev"' "$service_dir/package.json"; then
                        echo "[$service_name] No dev script found, skipping..."
                        continue
                fi

                echo "Starting $service_name in background..."

                # 2026-09-23 idempotency guard: the morning boot ran dev.sh twice and
                # double-started every mini-service — zombie port-losers kept running
                # their pre-bind fetch/WS loops (duplicate Binance pollers, weight burn,
                # double writers). Skip any service whose recorded pid is still alive.
                # bun --hot keeps the recorded pid alive across hot reloads; a dead pid
                # yields a stale lockfile which is simply overwritten below.
                local lockfile="$service_dir/.dev.lock"
                if [ -f "$lockfile" ]; then
                        local lockpid
                        lockpid=$(cat "$lockfile" 2>/dev/null || true)
                        if [ -n "$lockpid" ] && kill -0 "$lockpid" 2>/dev/null; then
                                echo "[$service_name] already running (pid $lockpid), skipping..."
                                continue
                        fi
                fi

                (
                        cd "$service_dir"
                        echo "[$service_name] Installing dependencies..."
                        bun install
                        echo "[$service_name] Running bun run dev..."
                        exec bun run dev
                ) >"$PROJECT_DIR/.zscripts/mini-service-${service_name}.log" 2>&1 &

                local service_pid=$!
                echo "$service_pid" > "$lockfile" 2>/dev/null || true
                echo "[$service_name] Started in background (PID: $service_pid)"
                echo "[$service_name] Log: $PROJECT_DIR/.zscripts/mini-service-${service_name}.log"
                disown "$service_pid" 2>/dev/null || true
                started_count=$((started_count + 1))
        done

        echo "Mini-services startup completed. Started $started_count service(s)."
        log_step_end "Starting mini-services"
}

wait_for_service() {
        local host="$1"
        local port="$2"
        local service_name="$3"
        local max_attempts="${4:-60}"
        local attempt=1

        echo "Waiting for $service_name to be ready on $host:$port..."

        while [ "$attempt" -le "$max_attempts" ]; do
                if curl -s --connect-timeout 2 --max-time 5 "http://$host:$port" >/dev/null 2>&1; then
                        echo "$service_name is ready!"
                        return 0
                fi

                echo "Attempt $attempt/$max_attempts: $service_name not ready yet, waiting..."
                sleep 1
                attempt=$((attempt + 1))
        done

        echo "ERROR: $service_name failed to start within $max_attempts seconds"
        return 1
}

cleanup() {
        if [ -n "${DEV_PID:-}" ] && kill -0 "$DEV_PID" >/dev/null 2>&1; then
                echo "Stopping Next.js dev server (PID: $DEV_PID)..."
                kill "$DEV_PID" >/dev/null 2>&1 || true
        fi
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"

# ── STEP 0: .env integrity (never boot with a truncated env) ──────────────
mkdir -p logs
if [ ! -s .env ] || [ "$(stat -c%s .env 2>/dev/null || echo 0)" -lt 400 ]; then
  if [ -s /tmp/my-project/.env ]; then
    cp -a /tmp/my-project/.env .env && chmod 600 .env
    echo "[BOOT] .env restored from PolarFS mirror ($(stat -c%s .env)B)"
  else
    echo "[BOOT] WARNING: .env truncated AND mirror missing — boot-kit env plane will retry"
  fi
fi

# ── STEP 1+2: warm .next restore + boot-kit v2 planes ────────────────────
bash scripts/next-cache.sh restore || true
bash scripts/boot-kit.sh --fix >> logs/boot-kit-boot.log 2>&1 \
  || echo "[BOOT] boot-kit drift remains (non-fatal, continuing)"

if ! command -v bun >/dev/null 2>&1; then
        echo "ERROR: bun is not installed or not in PATH"
        exit 1
fi

log_step_start "bun install"
echo "[BUN] Installing dependencies..."
bun install
log_step_end "bun install"

log_step_start "bun run db:push"
echo "[BUN] Setting up database..."
bun run db:push
log_step_end "bun run db:push"

log_step_start "Starting Next.js dev server (dev-up.sh: cap 1400 + self-warm + watchdog arms)"
echo "[BUN] Starting development server via scripts/dev-up.sh (heap-capped)..."
# ── v2.1 STAB-20261029 (trace 1a184d8bbb826f0d — operator mandate «نمایش
# داشبورد پایدار نیست») — APP SUPERVISOR LOOP: dev-up.sh is a one-shot spawner
# (background mode spawns next-server via setsid and exits). When the app's
# ram-shed governor self-recycles next-server (controlled process.exit(0) by
# design, RAM-SHED-20261024), NOTHING in this platform chain re-entered it —
# the dashboard stayed dark until layer-1 watchdog healed (≥180s pause-file
# window, longer whenever the watchdog itself was paused during a mem-crunch).
# This loop is the missing link: hold for the app lifetime, and ~8s after
# every app exit re-enter dev-up.sh (idempotent, single-spawner gate,
# pause-protected). p0-watchdog remains the second line of defense.
(
  down() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)" != "200" ]; }
  while true; do
    if down; then
      echo "[dev.sh] app down $(date -u '+%H:%M:%SZ') — re-entering dev-up (STAB-20261029)" >> dev.log
      bash scripts/dev-up.sh >> dev.log 2>&1 || true
    fi
    sleep 8
  done
) >> dev.log 2>&1 &
disown 2>/dev/null || true
log_step_end "Starting Next.js dev server"

log_step_start "Waiting for Next.js dev server"
wait_for_service "localhost" "3000" "Next.js dev server"
log_step_end "Waiting for Next.js dev server"

log_step_start "Health check"
echo "[BUN] Performing health check..."
curl -fsS -m 120 localhost:3000 >/dev/null
echo "[BUN] Health check passed"
log_step_end "Health check"

start_mini_services

# ── STEP 7: refresh the warm cache in background (stamp-guarded no-op if
# unchanged) so the NEXT boot (even after a re-provision) starts warm ──────
( sleep 30 && bash scripts/next-cache.sh save ) >> logs/next-cache.log 2>&1 &
disown 2>/dev/null || true

echo "Next.js dev server is running (dev-up-managed, heap-capped, watchdog-armed)."
echo "Warm cache refresh scheduled in background (next-cache.sh save)."
