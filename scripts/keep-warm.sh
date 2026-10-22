#!/usr/bin/env bash
# ── NEXUS//SIGNALS — EXTERNAL KEEP-WARM HEARTBEAT (Task 56, Tier-2) ──────────
# Operator order: «کرون‌جاب keep-warm را کامل و مهندسی انجام بده».
# Model: the operator's Job 411262 (5-min heartbeat that prevented idle-cold
# on their other project). This script is the NEXUS edition for any EXTERNAL
# scheduler (platform cron / VPS crontab / GitHub Actions):
#
#   BASE="https://<public-preview-origin>" ./keep-warm.sh
#
# HARD DOCTRINE (Job 411262):
#   · heartbeat ONLY hits one endpoint and prints ONE line — never restarts,
#     never mutates, never "fixes" anything, never writes project files.
#   · OK   → "HEARTBEAT OK · uptime Xs · gen SHA · ledger #N"
#   · COLD → "HEARTBEAT COLD" + exit 1 (the scheduler's failure signal)
#
# Platform-cron registration spec (from the Task-56 reply):
#   URL:      <public-origin>/api/healthz        (plain GET — no auth, no key)
#   Schedule: fixed_rate · every 5 minutes
#   Success:  HTTP 200 with {"ok":true,...}
# ─────────────────────────────────────────────────────────────────────────────
set -u
BASE="${BASE:-http://127.0.0.1:3000}"
TIMEOUT="${TIMEOUT:-10}"

body="$(curl -fsS -m "$TIMEOUT" "$BASE/api/healthz" 2>/dev/null)" || { echo "HEARTBEAT COLD · $BASE unreachable"; exit 1; }

# one honest line, parsed from the real healthz payload (python3-free)
up=$(printf '%s' "$body" | sed -n 's/.*"uptimeSec":\([0-9]*\).*/\1/p' | head -1)
sha=$(printf '%s' "$body" | sed -n 's/.*"gitSha":"\([a-f0-9]\{7\}\)".*/\1/p' | head -1)
ledger=$(printf '%s' "$body" | sed -n 's/.*"ledgerMaxSerial":\([0-9]*\).*/\1/p' | head -1)

echo "HEARTBEAT OK · uptime ${up:-?}s · gen ${sha:-?} · ledger #${ledger:-?}"
exit 0
