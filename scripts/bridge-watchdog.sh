#!/usr/bin/env bash
# ── NEXUS//SIGNALS bridge-watchdog (v1.3 — pid-reuse lock heal + PolarFS escrow, operator order 2026-11-02) ──────────
# Operator mandate «مورد ۴»: the operator stays in this sandbox (no personal
# server), so the Toobit bridge must SELF-REVIVE after any sandbox recycle /
# process death instead of silently staying down for hours (the 2026-10-31
# 20:54→23:33 gap birthed 4 STALE-CARD skips and the "سیستم به تووبیت وصل
# نیست" report). Doctrine: READ-ONLY infra revive — it never touches trading
# behavior, gates, or the engine. Restores .env from the key escrow if the
# sandbox wiped it (the known 4th-link failure mode), then relaunches.
#   v1.3 (2026-11-02, مأموریت چهارتایی P0-B/P1-D):
#   ① PID-REUSE LOCK HEAL — incident ~07:33Z: after a re-provision the OS
#     recycled pids; bridge.pid pointed at warm-loop's bun, kill(,0) succeeded,
#     and the bridge exited(1) SILENTLY on the singleton lock (CRIT only in
#     logs/toobit-bridge.log). Before relaunching, verify the lock owner's
#     /proc/<pid>/cwd actually is the bridge dir; a recycled/zombie owner is
#     unlinked (mirror of the v1.6.1 in-bridge guard).
#   ② POLARFS ESCROW — /home/z is the wipe surface (11 wipes on 2026-11-02);
#     /tmp/my-project (PolarFS) survived every one of them. Escrow sources are
#     now resolved PolarFS-first with the legacy path as fallback.
#   log: .data/bridge-watchdog.log (rotated at 200KB)
set -u
BASE=/home/z/my-project
BR="$BASE/mini-services/toobit-bridge"
LOG="$BASE/.data/bridge-watchdog.log"
POLAR_SECRETS=/tmp/my-project/secrets
LEGACY_ESCROW=/home/z/.nexus-secrets/toobit-bridge.env
# PolarFS-first escrow resolution (① sealed copy lives on both surfaces)
ESCROW="$LEGACY_ESCROW"
if [ -s "$POLAR_SECRETS/toobit-bridge.env" ]; then ESCROW="$POLAR_SECRETS/toobit-bridge.env"; fi

# keep the log bounded
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 200000 ]; then
  tail -c 50000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(now)] $*" >> "$LOG"; }

health=$(curl -s -m 5 http://localhost:3021/health 2>/dev/null || true)
if echo "$health" | grep -q '"ok":true'; then
  # v1.2 — KEYS BLIND-SPOT FIX (trace 1a196a30609a86ed, incident 2026-11-01 09:42Z):
  # sandbox recycle → p0-watchdog revived the bridge BEFORE this cron ran, so health
  # was always "ok":true while keysInstalled=false — v1.1 exited silently for ~45min
  # while ZEC-3230 storm-looped CLOSE_REJECTED (21 attempts → ABANDONED). Health-UP
  # no longer implies keys-OK: restore the escrow .env on sight; KEYS-HOTRELOAD
  # (30s watcher inside the bridge) installs them at runtime — no restart needed.
  if echo "$health" | grep -q '"keysInstalled":false'; then
    if [ ! -s "$ESCROW" ]; then
      # v1.3 — escrow dies on every re-provision (11 wipes on 2026-11-02). Before the
      # MANUAL dead-end, self-heal from the versioned tbenv backup (survives wipes).
      # This retires the old MANUAL message that pointed at the wrong in-tree path.
      if [ -s "$BASE/scripts/restore-keys.sh" ]; then
        if bash "$BASE/scripts/restore-keys.sh" >> "$BASE/logs/watchdog-restore-keys.log" 2>&1 \
           && [ -s "$BR/.env" ]; then
          log "bridge UP but keys MISSING — restored L1+escrow from tbenv backup via restore-keys.sh; KEYS-HOTRELOAD installs in ≤30s"
          exit 0
        fi
      fi
    fi
    if [ -s "$ESCROW" ]; then
      cp "$ESCROW" "$BR/.env" && chmod 600 "$BR/.env"
      log "bridge UP but keys MISSING — .env restored from escrow ($(stat -c%s "$ESCROW") bytes); KEYS-HOTRELOAD installs in ≤30s"
      exit 0
    fi
    log "keys MISSING, escrow absent, tbenv self-heal failed ($ESCROW) — MANUAL: operator"
    exit 1
  fi
  # healthy — silent exit, no log spam
  exit 0
fi
log "bridge DOWN (health='${health:0:80}') — reviving"

# 0) v1.3 PID-REUSE LOCK HEAL — a bridge.pid whose owner is not a bridge
#    process (recycled pid / zombie) makes the new instance exit(1) silently
#    on the singleton lock. Verify the owner's cwd; unlink stale locks.
if [ -f "$BR/.data/bridge.pid" ] || [ -f "$BASE/.data/toobit-bridge/bridge.pid" ]; then
  PIDF="$BASE/.data/toobit-bridge/bridge.pid"
  [ -f "$BR/.data/bridge.pid" ] && PIDF="$BR/.data/bridge.pid"
  PID=$(cat "$PIDF" 2>/dev/null || true)
  if [ -n "$PID" ] && [ "$PID" != "0" ] && kill -0 "$PID" 2>/dev/null; then
    CWD=$(readlink "/proc/$PID/cwd" 2>/dev/null || echo "?")
    case "$CWD" in
      */mini-services/toobit-bridge) log "lock owner pid=$PID is a live bridge ($CWD) — NOT relaunching over it; re-probe next cycle"; exit 1 ;;
      *) log "stale lock pid=$PID owner cwd='$CWD' (pid-reuse/zombie) — unlinking $PIDF"; rm -f "$PIDF" ;;
    esac
  else
    log "stale lock pid=${PID:-empty} (process gone) — unlinking $PIDF"; rm -f "$PIDF"
  fi
fi

# 1) key escrow restore (link-4 self-heal — the .env is gitignored and dies on recycle)
if [ ! -s "$BR/.env" ] && [ -s "$ESCROW" ]; then
  cp "$ESCROW" "$BR/.env" && chmod 600 "$BR/.env"
  log ".env restored from escrow ($(stat -c%s "$ESCROW") bytes)"
fi

# 2) relaunch (single instance guard via .dev.lock owner check)
cd "$BR" || { log "FATAL: bridge dir missing"; exit 1; }
nohup bun index.ts >> "$BR/bridge-stdout.log" 2>&1 &
echo $! > "$BR/.watchdog.pid"
log "relaunched pid=$(cat "$BR/.watchdog.pid")"

# 3) verify
sleep 8
h2=$(curl -s -m 5 http://localhost:3021/health 2>/dev/null || true)
if echo "$h2" | grep -q '"ok":true'; then
  log "revived OK ($(echo "$h2" | head -c 120))"
  exit 0
fi
log "revive FAILED (health='${h2:0:120}')"
exit 1
