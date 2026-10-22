#!/usr/bin/env bash
# ── NEXUS//SIGNALS — RESTORE FROM REMOTE (the post-wipe recovery path) ──────
# After a platform rollback that wipes the workspace, re-arm in ONE command:
#   bash scripts/restore-from-remote.sh
# Requires GITHUB_TOKEN in .env (same var the push-armor service uses).
set -euo pipefail
ROOT="/home/z/my-project"
cd "$ROOT"

TOKEN=$(grep -E '^GITHUB_TOKEN=' .env | cut -d= -f2- | tr -d '"' || true)
if [ -z "$TOKEN" ]; then echo "ERROR: GITHUB_TOKEN missing in .env"; exit 1; fi

echo "[restore] fetching remote main…"
git fetch "https://x-access-token:${TOKEN}@github.com/sarajafari7893-eng/neo.git" main:refs/remotes/origin/main 2>/dev/null

echo "[restore] resetting workspace to origin/main (local-only drift is discarded)…"
git reset --hard origin/main

echo "[restore] done — now run: bash .zscripts/dev.sh"
echo "[restore] note: node_modules may be stale; dev.sh + p0-watchdog reinstall deps automatically."
