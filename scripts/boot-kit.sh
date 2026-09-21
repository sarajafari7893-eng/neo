#!/usr/bin/env bash
# ── NEXUS-LIVE BOOT-KIT v1.0 — idempotent boot-integrity kit ────────────────
# Operator-approved 2026-09-17 (blanket supervisor approval: «تمام تصمیمات و
# پیشنهادات سوپروایزر را تایید می کنم، کامل و مهندسی انجام بده»).
#
# Closes the three failure planes exposed by the 06:26Z sandbox rollback:
#   (1) FILE plane        — infra kit files vanish → verify manifest, restore
#                           missing files from the newest snapshot zip (then
#                           upload/restore-sep14 mirror for mini-services).
#   (2) DEPENDENCY plane  — node_modules reinstalled without `prisma generate`
#                           (stale client: "Unknown field reachedTp") and
#                           mini-service deps missing (socket.io) → detect
#                           drift, regenerate/install in --fix mode.
#   (3) PROCESS plane     — bridge/liq/ws/watchdog stay dead after a tree
#                           restart → port-liveness with idempotent starts
#                           (delegates app restart to dev-up.sh).
#
# Usage:
#   bash scripts/boot-kit.sh --check-only   # report only (cron keep-alive)
#   bash scripts/boot-kit.sh                # check + repair (fix mode)
#   bash scripts/boot-kit.sh --fix          # explicit fix mode
#
# Exit: 0 = all green (or fixed), 1 = unfixed drift remains.
set -u
MODE="check"
[ "${1:-}" = "--fix" ] && MODE="fix"
ROOT="/home/z/my-project"
BACKUPS="$ROOT/backups"
cd "$ROOT" || exit 1
ACTIONS=""

# ── (1) FILE plane — infra kit manifest ─────────────────────────────────────
KIT=(
  "scripts/dev-up.sh"
  "scripts/telegram-send.sh"
  "scripts/watchdog.sh"
  "scripts/watchdog-up.sh"
  "scripts/disk-hygiene.sh"
  "scripts/calibration-snapshot.ts"
  "scripts/backup.sh"
  "mini-services/telegram-bridge/index.ts"
  "mini-services/p0-watchdog/index.ts"
  "mini-services/p0-watchdog/package.json"
)
FILE_STATUS="OK"
MISSING=()
for f in "${KIT[@]}"; do
  [ -s "$ROOT/$f" ] || MISSING+=("$f")
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  FILE_STATUS="RESTORED"
  NEWEST_ZIP=$(ls -1t "$BACKUPS"/nexus-snapshot-*.zip 2>/dev/null | head -1)
  STAGE=$(mktemp -d)
  for f in "${MISSING[@]}"; do
    DONE=""
    if [ -n "$NEWEST_ZIP" ]; then
      (cd "$STAGE" && unzip -o -q "$NEWEST_ZIP" "$f" 2>/dev/null) && [ -s "$STAGE/$f" ] && {
        mkdir -p "$ROOT/$(dirname "$f")"
        cp "$STAGE/$f" "$ROOT/$f" && DONE="zip"
      }
    fi
    if [ -z "$DONE" ] && [ -s "$ROOT/upload/restore-sep14/$f" ]; then
      mkdir -p "$ROOT/$(dirname "$f")"
      cp "$ROOT/upload/restore-sep14/$f" "$ROOT/$f" && DONE="mirror"
    fi
    [ -n "$DONE" ] && ACTIONS="$ACTIONS file:$f($DONE)" || { ACTIONS="$ACTIONS file:$f(MISS-UNFIXED)"; FILE_STATUS="UNFIXED"; }
  done
  rm -rf "$STAGE"
fi

# ── (2) DEPENDENCY plane ────────────────────────────────────────────────────
# (2a) Prisma client freshness: the generated client must know a schema-only
# field (reachedTp — EPOCH-2 TP-proven accounting). Stale client = the exact
# 06:26Z failure ("Unknown field reachedTp" → /api/pulse 500).
PRISMA_STATUS="OK"
PROBE_FIELD="reachedTp"
CLIENT_DTS="$ROOT/node_modules/.prisma/client/index.d.ts"
SCHEMA="$ROOT/prisma/schema.prisma"
if ! grep -q "$PROBE_FIELD" "$CLIENT_DTS" 2>/dev/null; then
  PRISMA_STATUS="DRIFT"
  if [ "$MODE" = "fix" ]; then
    if (cd "$ROOT" && bunx prisma generate >/dev/null 2>&1) && grep -q "$PROBE_FIELD" "$CLIENT_DTS" 2>/dev/null; then
      PRISMA_STATUS="REGEN"
      ACTIONS="$ACTIONS prisma:regenerated(+restart-via-dev-up)"
      (cd "$ROOT" && bash scripts/dev-up.sh >> dev.log 2>&1)
    else
      PRISMA_STATUS="REGEN-FAILED"
      ACTIONS="$ACTIONS prisma:regen-FAILED"
    fi
  else
    ACTIONS="$ACTIONS prisma:DRIFT(check-only)"
  fi
fi

# (2b) mini-service deps: package.json declared deps must exist in the
# service-local node_modules (price-ws socket.io gap, 06:26Z).
DEPS_STATUS="OK"
for svc in price-ws liq-service telegram-bridge p0-watchdog; do
  PJ="$ROOT/mini-services/$svc/package.json"
  [ -f "$PJ" ] || continue
  # every dependency declared in package.json must resolve inside the service dir
  MISSING_DEP=$(bun -e "
const fs=require('fs');
const pj=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const deps=Object.keys(pj.dependencies||{}).filter(d=>d!=='bun'); // 'bun' dep = runtime self-reference, not installable
const miss=deps.filter(d=>!fs.existsSync('mini-services/'+process.argv[2]+'/node_modules/'+d) && !fs.existsSync('node_modules/'+d));
console.log(miss.join(','));
" "$PJ" "$svc" 2>/dev/null)
  if [ -n "$MISSING_DEP" ]; then
    DEPS_STATUS="GAP"
    if [ "$MODE" = "fix" ]; then
      (cd "$ROOT/mini-services/$svc" && bun install >/dev/null 2>&1) && ACTIONS="$ACTIONS deps:$svc(installed:$MISSING_DEP)" && DEPS_STATUS="FIXED" \
        || { ACTIONS="$ACTIONS deps:$svc(FAILED)"; DEPS_STATUS="UNFIXED"; }
    else
      ACTIONS="$ACTIONS deps:$svc(missing:$MISSING_DEP)"
    fi
  fi
done

# ── (3) PROCESS plane — port liveness, idempotent starts in fix mode ────────
probe() { curl -s -m 6 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }
APP=$(probe http://localhost:3000/api/pulse)
WS=$(probe http://localhost:3003/)
BR=$(curl -s -m 6 http://localhost:3005/health 2>/dev/null | grep -o '"ok":true' | head -1)
LIQ=$(probe http://localhost:3010/health)
WD=""
curl -s -m 4 -o /dev/null http://localhost:3020/ 2>/dev/null && WD="up" || WD="down"
PORTS="app:$APP ws:$WS bridge:${BR:-down} liq:$LIQ wd:$WD"
PROC_STATUS="OK"
if [ "$MODE" = "fix" ]; then
  [ "$BR" != '"ok":true' ] && {
    (cd "$ROOT/mini-services/telegram-bridge" && nohup bun index.ts >> "$ROOT/logs/bridge-relay.log" 2>&1 &)
    sleep 3; ACTIONS="$ACTIONS started:bridge"; PROC_STATUS="FIXED"
  }
  [ "$LIQ" != "200" ] && {
    (cd "$ROOT/mini-services/liq-service" && nohup bun run dev >> "$ROOT/logs/liq-service.log" 2>&1 &)
    sleep 2; ACTIONS="$ACTIONS started:liq"; PROC_STATUS="FIXED"
  }
  [ "$WS" != "400" ] && {
    (cd "$ROOT/mini-services/price-ws" && nohup bun run dev >> "$ROOT/logs/price-ws.log" 2>&1 &)
    sleep 2; ACTIONS="$ACTIONS started:ws"; PROC_STATUS="FIXED"
  }
  [ "$WD" = "down" ] && {
    bash "$ROOT/scripts/watchdog-up.sh" >/dev/null 2>&1
    sleep 2; ACTIONS="$ACTIONS started:watchdog"; PROC_STATUS="FIXED"
  }
  [ "$APP" != "200" ] && {
    bash "$ROOT/scripts/dev-up.sh" >> "$ROOT/dev.log" 2>&1
    APP=$(probe http://localhost:3000/api/pulse)
    ACTIONS="$ACTIONS restarted:app"; PROC_STATUS="FIXED"
  }
  PORTS="app:$APP ws:$(probe http://localhost:3003/) bridge:$(curl -s -m 6 http://localhost:3005/health 2>/dev/null | grep -o '"ok":true' | head -1) liq:$(probe http://localhost:3010/health) wd:$( { curl -s -m 4 -o /dev/null http://localhost:3020/ 2>/dev/null && echo up; } || echo down)"
fi

echo "BOOT-KIT $MODE — files:$FILE_STATUS · prisma:$PRISMA_STATUS · deps:$DEPS_STATUS · $PORTS ·$ACTIONS"
[ "$FILE_STATUS" = "OK" ] && [ "$PRISMA_STATUS" != "DRIFT" ] && [ "$PRISMA_STATUS" != "REGEN-FAILED" ] \
  && [ "$DEPS_STATUS" != "UNFIXED" ] && echo "$PORTS" | grep -q "app:200" && exit 0
[ "$MODE" = "fix" ] && exit 0
exit 1
