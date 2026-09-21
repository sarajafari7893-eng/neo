#!/usr/bin/env bash
# ── DEPRECATED WRAPPER — kept ONLY for cron 368159 compatibility ──
# 2026-09-08: the two post-incident hygiene scripts were UNIFIED into
# scripts/disk-hygiene.sh v2 (canonical: targeted subdir wipe + threshold +
# 800MB failsafe floor). This wrapper preserves the old call signature
# `bash cache-hygiene.sh [threshold_mb]` so the daily cron keeps working.
# Do not extend this file — extend disk-hygiene.sh.
exec bash "/home/z/my-project/scripts/disk-hygiene.sh" "${1:-1024}"
