#!/usr/bin/env bash
# ── NEXUS//SIGNALS bridge-watchdog (v1.2 — keys blind-spot fix, trace 1a196a30609a86ed) ──────────
# Operator mandate «مورد ۴»: the operator stays in this sandbox (no personal
# server), so the Toobit bridge must SELF-REVIVE after any sandbox recycle /
# process death instead of silently staying down for hours (the 2026-10-31
# 20:54→23:33 gap birthed 4 STALE-CARD skips and the "سیستم به تووبیت وصل
# نیست" report). Doctrine: READ-ONLY infra revive — it never touches trading
# behavior, gates, or the engine. Restores .env from the key escrow if the
# sandbox wiped it (the known 4th-link failure mode), then relaunches.
#   log: .data/bridge-watchdog.log (rotated at 200KB)
set -u
BASE=/home/z/my-project
BR="$BASE/mini-services/toobit-bridge"
LOG="$BASE/.data/bridge-watchdog.log"
ESCROW=/home/z/.nexus-secrets/toobit-bridge.env

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
    if [ -s "$ESCROW" ]; then
      cp "$ESCROW" "$BR/.env" && chmod 600 "$BR/.env"
      log "bridge UP but keys MISSING — .env restored from escrow ($(stat -c%s "$ESCROW") bytes); KEYS-HOTRELOAD installs in ≤30s"
      exit 0
    fi
    log "keys MISSING and escrow absent ($ESCROW) — MANUAL: restore from backups/env/tbenv-*.enc (BACKUP_PASSPHRASE) or operator"
    exit 1
  fi
  # healthy — silent exit, no log spam
  exit 0
fi
log "bridge DOWN (health='${health:0:80}') — reviving"

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
