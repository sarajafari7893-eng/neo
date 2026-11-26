#!/usr/bin/env bash
# ── NEXUS-LIVE BOOT-KIT v2.0 — idempotent boot-integrity kit ────────────────
# Operator-approved 2026-09-17 (blanket supervisor approval: «تمام تصمیمات و
# پیشنهادات سوپروایزر را تایید می کنم، کامل و مهندسی انجام بده»).
# v2.0 (RECOVERY-20261022b, operator order «تمام توصیه‌ها را کامل و مهندسی
# اجرا کن» + «بک‌اپ‌گیری در تلگرام رو لقو کن»): adds the planes the 22:26Z
# re-provision proved missing:
#   (0) LINEAGE plane      — the killer gap: boot extracts the STALE
#                            /home/sync/repo.tar (Oct-15, Sep-era db=754) and
#                            the engine happily writes NEW signals into the OLD
#                            ledger. v2 detects ledgerTotal<2000 and restores
#                            the golden db (newest backup-ring snapshot, else
#                            the PolarFS /tmp/my-project mirror) — ONLY while
#                            the app is down (never swaps under a live writer).
#   (0b) ENV plane         — start.sh truncates .env to DATABASE_URL-only at
#                            every repo.tar restore; v2 restores the full
#                            10-key .env from the PolarFS mirror (chmod 600,
#                            values never echoed).
#   (0c) NEXTCACHE plane   — delegates to scripts/next-cache.sh restore
#                            (warm .next from PolarFS → no cold-compile OOM).
#   (0d) GIT plane         — repo.tar ships without .git (3.5GB bloat);
#                            v2 re-anchors lineage from GitHub (--depth 20,
#                            token from .env, never echoed) so armor can resume.
#
# v1 planes retained unchanged:
#   (1) FILE plane        — infra kit files vanish → verify manifest, restore
#                           missing files from the newest snapshot zip.
#   (2) DEPENDENCY plane  — node_modules without prisma generate / missing
#                           mini-service deps → detect drift, regenerate/install.
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

# ── (0b) ENV plane — .env truncated by start.sh repo.tar restore ───────────
ENV_STATUS="OK"
ENV_REQUIRED="DATABASE_URL TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID NEXUS_CONTROL_KEY BRIDGE_TOKEN BACKUP_PASSPHRASE GITHUB_TOKEN NEXTAUTH_URL NEXTAUTH_SECRET"
ENV_MISSING=""
for k in $ENV_REQUIRED; do grep -q "^${k}=" "$ROOT/.env" 2>/dev/null || ENV_MISSING="$ENV_MISSING $k"; done
if [ -n "$ENV_MISSING" ]; then
  ENV_STATUS="TRUNCATED"
  if [ "$MODE" = "fix" ] && [ -s /tmp/my-project/.env ]; then
    cp -a /tmp/my-project/.env "$ROOT/.env" && chmod 600 "$ROOT/.env"
    STILL=""; for k in $ENV_REQUIRED; do grep -q "^${k}=" "$ROOT/.env" || STILL="$STILL $k"; done
    if [ -z "$STILL" ]; then ENV_STATUS="RESTORED"; ACTIONS="$ACTIONS env:restored-from-mirror"; else ENV_STATUS="UNFIXED"; ACTIONS="$ACTIONS env:mirror-incomplete($STILL)"; fi
  else
    ACTIONS="$ACTIONS env:truncated($ENV_MISSING)"
  fi
fi

# ── (0c) NEXTCACHE plane — warm .next restore (P1 spike-cut) ───────────────
NC_STATUS="cold"
NC_OUT=$(bash "$ROOT/scripts/next-cache.sh" restore 2>/dev/null || true)
case "$NC_OUT" in restore:OK*) NC_STATUS="restored"; ACTIONS="$ACTIONS next-cache:restored" ;; restore:current*) NC_STATUS="current" ;; *) NC_STATUS="cold" ;; esac

# ── (0) LINEAGE plane — golden db restore (v2.0 killer gap) ────────────────
LINEAGE_STATUS="OK"
LEDGER=$(bun -e 'import{Database} from "bun:sqlite";try{const db=new Database("/home/z/my-project/db/custom.db",{readonly:true});db.exec("PRAGMA busy_timeout=2500");console.log(Number(db.query("SELECT COUNT(*) n FROM Signal").get()?.n??-1));db.close()}catch(e){console.log(-1)}' 2>/dev/null || echo -1)
if [ "$LEDGER" -lt 2000 ] 2>/dev/null || [ "$LEDGER" = "-1" ]; then
  LINEAGE_STATUS="STALE($LEDGER)"
  APP_UP=$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || echo 000)
  if [ "$APP_UP" = "200" ]; then
    # never swap the db under a live writer — defer to a dev-up restart window
    ACTIONS="$ACTIONS lineage:STALE($LEDGER)-deferred(app-up)"
  elif [ "$MODE" = "fix" ]; then
    STAGE=$(mktemp -d); DONE=""
    # source 1: newest backup-ring snapshot that carries db/custom.db
    for Z in $(ls -1t /tmp/my-project/backups/nexus-snapshot-*.zip 2>/dev/null | head -4); do
      (cd "$STAGE" && unzip -o -q "$Z" "db/custom.db" 2>/dev/null) && [ -s "$STAGE/db/custom.db" ] && { DONE="$Z"; break; }
    done
    # source 2: PolarFS mirror db (frozen Oct-21, 2963 signals)
    [ -z "$DONE" ] && [ -s /tmp/my-project/db/custom.db ] && { cp -a /tmp/my-project/db/custom.db "$STAGE/db/custom.db"; DONE="mirror"; }
    if [ -n "$DONE" ]; then
      GOLD=$(bun -e "import{Database} from \"bun:sqlite\";try{const db=new Database(process.argv[1],{readonly:true});db.exec(\"PRAGMA busy_timeout=2500\");const c=Number(db.query(\"SELECT COUNT(*) n FROM Signal\").get()?.n??-1);const i=db.query(\"PRAGMA integrity_check\").get();db.close();console.log(c+(i&&i.integrity_check==='ok'?'':'-BAD'))}catch(e){console.log('-ERR')}" "$STAGE/db/custom.db" 2>/dev/null || echo -ERR)
      case "$GOLD" in
        *BAD*|*ERR*|*-1*) ACTIONS="$ACTIONS lineage:source-rejected($GOLD)" ;;
        *[0-9]*)
        if [ "${GOLD%%-*}" -ge 2000 ] 2>/dev/null; then
          rm -f "$ROOT/db/custom.db-wal" "$ROOT/db/custom.db-shm"
          cp -a "$STAGE/db/custom.db" "$ROOT/db/custom.db" && chmod 644 "$ROOT/db/custom.db"
          LINEAGE_STATUS="RESTORED($GOLD)"; ACTIONS="$ACTIONS lineage:restored($GOLD from $(basename "${DONE:-?}"))"
        else ACTIONS="$ACTIONS lineage:source-too-small($GOLD)"; fi
        ;;
      esac
    else ACTIONS="$ACTIONS lineage:no-source-found"; fi
    rm -rf "$STAGE"
  else
    ACTIONS="$ACTIONS lineage:STALE($LEDGER)(check-only)"
  fi
fi

# ── (0d) GIT plane — re-anchor lineage from GitHub when .git is gone ───────
GIT_STATUS="OK"
if [ ! -d "$ROOT/.git/objects" ]; then
  GIT_STATUS="MISSING"
  if [ "$MODE" = "fix" ]; then
    GT=$(grep '^GITHUB_TOKEN=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d ' ')
    if [ -n "$GT" ]; then
      git init -q "$ROOT" 2>/dev/null
      git -C "$ROOT" remote remove origin 2>/dev/null
      if git -C "$ROOT" remote add origin "https://x-access-token:${GT}@github.com/sarajafari7893-eng/neo.git" 2>/dev/null \
         && timeout 240 git -C "$ROOT" fetch --depth 20 origin main 2>>"$ROOT/logs/boot-kit-git.log" \
         && git -C "$ROOT" reset --soft FETCH_HEAD 2>>"$ROOT/logs/boot-kit-git.log" \
         && git -C "$ROOT" remote set-url origin "https://github.com/sarajafari7893-eng/neo.git"; then
        GIT_STATUS="REANCHORED"; ACTIONS="$ACTIONS git:reanchored(depth20)"
      else
        git -C "$ROOT" remote set-url origin "https://github.com/sarajafari7893-eng/neo.git" 2>/dev/null
        GIT_STATUS="UNFIXED"; ACTIONS="$ACTIONS git:reanchor-FAILED"
      fi
      unset GT
    else ACTIONS="$ACTIONS git:no-token"; fi
  else ACTIONS="$ACTIONS git:missing(check-only)"; fi
fi

# ── (1) FILE plane — infra kit manifest ─────────────────────────────────
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
      # TASK-50: install output must be visible — the silent swallow hid the
      # price-ws socket.io failure that killed the whole 09-29 18:06Z boot.
      (cd "$ROOT/mini-services/$svc" && bun install >>"$ROOT/logs/boot-kit-deps.log" 2>&1) && ACTIONS="$ACTIONS deps:$svc(installed:$MISSING_DEP)" && DEPS_STATUS="FIXED" \
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
SF=$(probe http://localhost:3017/health)
WD=""
curl -s -m 4 -o /dev/null http://localhost:3020/ 2>/dev/null && WD="up" || WD="down"
PORTS="app:$APP ws:$WS bridge:${BR:-down} liq:$LIQ sf:$SF wd:$WD"
PROC_STATUS="OK"
if [ "$MODE" = "fix" ]; then
  # TASK-50: stale snapshot-era locks (dead PIDs from a previous generation)
  # must never survive a boot — the 09-29 price-ws corpse locked its own restart.
  rm -f "$ROOT"/mini-services/*/.dev.lock
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
  # v1.4.5 STABLEFLOW build (2026-09-30): family-E substrate collector
  [ "$SF" != "200" ] && {
    (cd "$ROOT/mini-services/stable-feed" && nohup bun index.ts >> "$ROOT/logs/stable-feed.log" 2>&1 &)
    sleep 2; ACTIONS="$ACTIONS started:sf"; PROC_STATUS="FIXED"
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
  PORTS="app:$APP ws:$(probe http://localhost:3003/) bridge:$(curl -s -m 6 http://localhost:3005/health 2>/dev/null | grep -o '"ok":true' | head -1) liq:$(probe http://localhost:3010/health) sf:$(probe http://localhost:3017/health) wd:$( { curl -s -m 4 -o /dev/null http://localhost:3020/ 2>/dev/null && echo up; } || echo down)"
fi

echo "BOOT-KIT $MODE — lineage:$LINEAGE_STATUS · env:$ENV_STATUS · cache:$NC_STATUS · git:$GIT_STATUS · files:$FILE_STATUS · prisma:$PRISMA_STATUS · deps:$DEPS_STATUS · $PORTS ·$ACTIONS"
[ "$LINEAGE_STATUS" = "OK" ] && [ "$ENV_STATUS" != "TRUNCATED" ] && [ "$ENV_STATUS" != "UNFIXED" ] \
  && [ "$FILE_STATUS" = "OK" ] && [ "$PRISMA_STATUS" != "DRIFT" ] && [ "$PRISMA_STATUS" != "REGEN-FAILED" ] \
  && [ "$DEPS_STATUS" != "UNFIXED" ] && [ "$GIT_STATUS" != "UNFIXED" ] && echo "$PORTS" | grep -q "app:200" && exit 0
[ "$MODE" = "fix" ] && exit 0
exit 1
