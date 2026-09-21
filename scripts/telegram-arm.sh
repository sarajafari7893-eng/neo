#!/bin/bash
# ── NEXUS//SIGNALS v6.3.2 — TELEGRAM RELAY ARM SCRIPT ──────────────────────
# One command to arm the relay once the operator re-supplies the bot token:
#   bash scripts/telegram-arm.sh <TELEGRAM_BOT_TOKEN>
#
# Steps: validate + live-verify the token via getMe → persist to .env →
# force-restart the dev server (env is read at boot) → report relay health →
# send the 7 banner proof cards if the operator chat is already resolved.
# (The token was lost with the 2026-09-07 rollback; chatId 102140064 survives
#  in EngineSetting and auto-discover re-binds on the first operator message.)
set -u
TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  echo "usage: bash scripts/telegram-arm.sh <TELEGRAM_BOT_TOKEN>"; exit 1
fi
if ! echo "$TOKEN" | grep -Eq '^[0-9]{8,10}:[A-Za-z0-9_-]{30,}$'; then
  echo "ABORT: token does not match Telegram format <bot_id>:<35+ chars>"; exit 1
fi
echo "→ verifying token against api.telegram.org/getMe …"
ME=$(curl -s -m 8 "https://api.telegram.org/bot${TOKEN}/getMe")
echo "$ME" | grep -q '"ok":true' || { echo "ABORT: getMe rejected the token: $ME"; exit 1; }
BOT=$(echo "$ME" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
echo "→ token VALID — bot @${BOT}"

cd /home/z/my-project || exit 1
# preserve DATABASE_URL, set the token
DB_LINE=$(grep -h '^DATABASE_URL=' .env 2>/dev/null || grep -h '^DATABASE_URL=' .env.example 2>/dev/null || echo 'DATABASE_URL="file:/home/z/my-project/db/custom.db"')
printf '%s\nTELEGRAM_BOT_TOKEN=%s\n' "$DB_LINE" "$TOKEN" > .env
chmod 600 .env
echo "→ .env written (token persisted, chat left to EngineSetting/auto-discover)"

echo "→ force-restarting the dev server (env loads at boot) …"
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 2
setsid bash -c 'NODE_OPTIONS="--max-old-space-size=768" exec ./node_modules/.bin/next dev -p 3000 >> dev.log 2>&1' < /dev/null &
code=000
for i in $(seq 1 40); do
  sleep 2
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse 2>/dev/null || true)
  [ "$code" = "200" ] && break
done
[ "$code" = "200" ] || { echo "FAIL: dev server did not come back (code $code) — check dev.log"; exit 1; }
echo "→ server UP (pulse 200)"

sleep 3
HEALTH=$(curl -s -m 10 http://localhost:3000/api/notify)
echo "→ relay health: $HEALTH"
if echo "$HEALTH" | grep -q '"chatResolved":true'; then
  echo "→ chat resolved — sending the 7 banner proof cards …"
  curl -s -m 60 -X POST http://localhost:3000/api/notify -H 'content-type: application/json' -d '{"action":"sample"}'
  echo ""
else
  echo "→ chat PENDING: open the bot in Telegram and send any message (e.g. «سلام»);"
  echo "  auto-discover binds within 30s, or force it: curl -X POST http://localhost:3000/api/notify -H 'content-type: application/json' -d '{\"action\":\"discover\"}'"
fi
echo "→ ARM SEQUENCE COMPLETE"
