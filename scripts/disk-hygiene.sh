#!/usr/bin/env bash
# ── NEXUS//SIGNALS disk hygiene v2.2 — CANONICAL cache guard (unified) ──
# 2026-09-08 incident: turbopack dev-cache grew unbounded to 6.2G → rootfs 100%
# → ENOSPC mid-snapshot. v2 UNIFIES the two post-incident scripts (disk-hygiene
# v1 + cache-hygiene v1) into ONE implementation; scripts/cache-hygiene.sh is a
# thin wrapper kept only for cron 368159 compatibility.
#
# v2.2 (Task 73, SENTINEL-20261003-0020) — the v2 safety claim ("safe while the
#   dev server runs") was WRONG for the turbopack SST cache: mid-run removal of
#   SST files corrupts the persistent cache ("Unable to write SST file / No such
#   file or directory" → tokio panic → server death). Verified incidents:
#   2026-09-17 ×3 (backup.sh v10.6 note) + 2026-10-03 10:51Z (backup pre-flight
#   → 5min crash-loop). Server-aware policy now (SERVER LIVE = pgrep next):
#     SCHEDULED (size threshold) + LIVE → DEFER turbopack wipe; webpack/eslint
#       stay inline-safe. A restart (dev-up.sh) opportunistically trims it.
#     FORCE / FAILSAFE (disk emergency) + LIVE → delegate to the canonical
#       guarded purge (scripts/dev-cache-purge.sh: pause → kill-safe → wipe →
#       dev-up). A 60s guarded restart beats an ENOSPC death.
#     SERVER DEAD → inline wipe as before (guaranteed safe).
#
# Modes:
#   bash disk-hygiene.sh [threshold_mb]  → scheduled wipe when cache > threshold (default 1024)
#   bash disk-hygiene.sh --force         → wipe regardless of size (backup.sh pre-flight)
# Failsafe (always active): wipe when rootfs free < 800MB, regardless of size.
# v2.1 (audit task 4-g, additive): dev.log trim (last 2000 lines) whenever dev.log > 5MB —
# runs FIRST in every mode, before the cache hygiene steps.
set -uo pipefail

ROOT="/home/z/my-project"
CACHE="$ROOT/.next/dev/cache"
FLOOR_MB=800

FORCE=0
THRESHOLD_MB=1024
if [ "${1:-}" = "--force" ]; then
  FORCE=1
elif [ -n "${1:-}" ]; then
  case "$1" in ''|*[!0-9]*) : ;; *) THRESHOLD_MB=$1 ;; esac
fi

stamp() { date -u '+%Y-%m-%d %H:%M:%S UTC'; }
du_mb() { du -sm "$1" 2>/dev/null | cut -f1 || echo 0; }
free_mb() { df -Pm / | tail -1 | awk '{print $4}'; }

# ── v2.1 dev.log trim (audit task 4-g P2: dev.log is appended forever, never rotated;
# the box already hit ENOSPC once). Runs BEFORE the cache hygiene steps and in EVERY
# mode: dev.log > 5MB → keep the last 2000 lines. Perms preserved via stat.
# Known trade-off of the mv-swap: the running `next dev` holds an O_APPEND fd on the old
# inode, so lines written between the trim and the next dev-up restart land in the unlinked
# inode (invisible). Hygiene runs 03:14 Tehran (app quiet) — accepted by the audit spec.
DEV_LOG="$ROOT/dev.log"
DEVLOG_ACTION="none"
DEVLOG_BYTES=$(stat -c%s "$DEV_LOG" 2>/dev/null || echo 0)
if [ -f "$DEV_LOG" ] && [ "${DEVLOG_BYTES:-0}" -gt $((5 * 1024 * 1024)) ]; then
  DEVLOG_PERM=$(stat -c%a "$DEV_LOG" 2>/dev/null || echo 644)
  DEVLOG_OLD_MB=$(du_mb "$DEV_LOG")
  if tail -n 2000 "$DEV_LOG" > "$DEV_LOG.tmp" 2>/dev/null && mv "$DEV_LOG.tmp" "$DEV_LOG"; then
    chmod "$DEVLOG_PERM" "$DEV_LOG" 2>/dev/null || true
    DEVLOG_ACTION="trimmed ${DEVLOG_OLD_MB}MB→$(du_mb "$DEV_LOG")MB (kept last 2000 lines)"
  else
    rm -f "$DEV_LOG.tmp" 2>/dev/null
    DEVLOG_ACTION="TRIM-FAILED (non-fatal)"
  fi
fi

SIZE_MB=$(du_mb "$CACHE")
FREE_MB=$(free_mb)
# v2.2: server-aware wipe policy — turbopack SST must never be removed under a
# live server. pgrep (not HTTP probe): a HUNG server is still a live writer.
SERVER_LIVE=0
pgrep -f "next-server" >/dev/null 2>&1 && SERVER_LIVE=1
pgrep -f "next dev"  >/dev/null 2>&1 && SERVER_LIVE=1
ACTION="none"
if [ -d "$CACHE" ] && [ "${SIZE_MB:-0}" -gt 0 ]; then
  if [ "$FORCE" = "1" ]; then
    ACTION="FORCED"
  elif [ "${FREE_MB:-0}" -lt "$FLOOR_MB" ]; then
    ACTION="FAILSAFE"
  elif [ "${SIZE_MB:-0}" -gt "$THRESHOLD_MB" ]; then
    ACTION="SCHEDULED"
  fi
  if [ "$ACTION" != "none" ]; then
    if [ "$SERVER_LIVE" = "1" ]; then
      if [ "$ACTION" = "SCHEDULED" ]; then
        # DEFER: keep turbopack intact (SST corruption under live server),
        # trim only the always-safe subdirs.
        rm -rf "${CACHE:?}"/webpack "${CACHE:?}"/eslint 2>/dev/null
        ACTION="DEFERRED"
      else
        # FORCE / FAILSAFE under live server = disk emergency → canonical
        # guarded purge (pause → kill-safe → wipe → dev-up). Not inline.
        bash "$ROOT/scripts/dev-cache-purge.sh" >> "$ROOT/logs/disk-hygiene.log" 2>&1 || true
        ACTION="DELEGATED"
      fi
    else
      rm -rf "${CACHE:?}"/turbopack "${CACHE:?}"/webpack "${CACHE:?}"/eslint 2>/dev/null
    fi
  fi
fi

NEW_SIZE=$(du_mb "$CACHE")
NEW_FREE=$(free_mb)
echo "[disk-hygiene $(stamp)] mode=${ACTION} · server_live=${SERVER_LIVE} · cache ${SIZE_MB}MB→${NEW_SIZE}MB (threshold ${THRESHOLD_MB}MB · floor ${FLOOR_MB}MB) · free ${FREE_MB}MB→${NEW_FREE}MB · dev.log:${DEVLOG_ACTION}"
exit 0
