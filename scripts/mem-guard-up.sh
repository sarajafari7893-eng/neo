#!/usr/bin/env bash
# ── MEM-GUARD v2 spawn protocol (2026-10-15) ──────────────────────────────────
# Used by: p0-watchdog healCmd (mem service), manual boot, recovery kits.
# Idempotent: pid-lock inside mem-guard exits the duplicate; probe-gated here.
set -uo pipefail
ROOT="/home/z/my-project"
LOG="$ROOT/logs/mem-guard.log"
mkdir -p "$(dirname "$LOG")"

# probe gate — already alive?
if curl -s -m 3 http://127.0.0.1:3019/health | grep -q '"ok":true'; then
  echo "[$(date '+%F %T')] mem-guard already healthy on :3019 — no spawn" >> "$LOG"
  exit 0
fi

cd "$ROOT/mini-services/mem-guard" || exit 1
setsid bash -c "exec nohup bun index.ts >> $LOG 2>&1" < /dev/null &
echo "[$(date '+%F %T')] mem-guard spawn issued (setsid detached, plain bun (LEASH-0929b))" >> "$LOG"
