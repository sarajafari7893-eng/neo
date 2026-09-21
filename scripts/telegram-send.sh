#!/bin/bash
# ── NEXUS-LIVE TELEGRAM BRIDGE — SEND COMMAND ────────────────────────────────
# Operator round 2026-09-11: «دستور ارسال پیام از طریق پل تلگرام»
#
# Usage:
#   bash scripts/telegram-send.sh "message text"
#   echo "message" | bash scripts/telegram-send.sh
#   bash scripts/telegram-send.sh --raw "<b>html</b> already-escaped text"
#
# Routes through the bridge service (:3005) → sendMessage to the operator chat
# resolved by the relay (@Neo_agentaibot). Falls back to the Next notify API
# if the bridge is down.
set -u
if [ $# -gt 0 ]; then TEXT="$*"; else TEXT="$(cat)"; fi
[ -z "$TEXT" ] && { echo "usage: bash scripts/telegram-send.sh \"text\"  (or pipe stdin)"; exit 1; }

PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$TEXT")

# (4-b) control gate: both the :3005 relay and the app's mutating /api/notify
# now require the x-nexus-key header. Key is read from env or .env — never printed.
NEXUS_KEY="${NEXUS_CONTROL_KEY:-}"
if [ -z "$NEXUS_KEY" ] && [ -f /home/z/my-project/.env ]; then
  NEXUS_KEY=$(grep '^NEXUS_CONTROL_KEY=' /home/z/my-project/.env | head -1 | cut -d= -f2- | tr -d '"'"'"'' 2>/dev/null)
fi

RES=$(curl -s -m 15 -X POST http://localhost:3005/send -H 'content-type: application/json' -H "x-nexus-key: $NEXUS_KEY" -d "$PAYLOAD" 2>/dev/null)
if echo "$RES" | grep -q '"ok":true'; then
  echo "BRIDGE SEND OK — $RES"
  exit 0
fi

# bridge down / unresolved → fallback to the app notify relay
RES2=$(curl -s -m 15 -X POST http://localhost:3000/api/notify -H 'content-type: application/json' \
  -H "x-nexus-key: $NEXUS_KEY" \
  -d "{\"action\":\"send\",\"text\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$TEXT")}" 2>/dev/null)
if echo "$RES2" | grep -q '"ok":true'; then
  echo "BRIDGE DOWN — SENT VIA APP RELAY — $RES2"
  exit 0
fi
echo "SEND FAILED — bridge: ${RES:-<no response>} · app-relay: ${RES2:-<no response>}"
exit 1
