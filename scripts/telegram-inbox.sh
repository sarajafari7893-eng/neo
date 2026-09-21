#!/bin/bash
# ── NEXUS-LIVE TELEGRAM BRIDGE — INBOX READER ────────────────────────────────
# Usage:
#   bash scripts/telegram-inbox.sh              # last 30 messages
#   bash scripts/telegram-inbox.sh --unread     # unread only
#   bash scripts/telegram-inbox.sh --unread --read   # unread + mark read
set -u
Q=""
MARK=0
for a in "$@"; do
  case "$a" in
    --unread) Q="unread=1" ;;
    --read) MARK=1 ;;
  esac
done
URL="http://localhost:3005/inbox?n=30${Q:+&$Q}"
# (4-b) control gate: GET /inbox and POST /read now require x-nexus-key (audit P0-1).
# Key is read from env or .env — never printed.
NEXUS_KEY="${NEXUS_CONTROL_KEY:-}"
if [ -z "$NEXUS_KEY" ] && [ -f /home/z/my-project/.env ]; then
  NEXUS_KEY=$(grep '^NEXUS_CONTROL_KEY=' /home/z/my-project/.env | head -1 | cut -d= -f2- | tr -d '"'"'"'' 2>/dev/null)
fi
RES=$(curl -s -m 10 -H "x-nexus-key: $NEXUS_KEY" "$URL" 2>/dev/null)
if [ -z "$RES" ]; then
  echo "BRIDGE UNREACHABLE on :3005 — is mini-services/telegram-bridge running?"
  exit 1
fi
export BRIDGE_RES="$RES"
python3 <<'EOF'
import json, os
d = json.loads(os.environ["BRIDGE_RES"])
print(f"inbox: {d['total']} total · {d['unread']} unread")
for m in d["messages"]:
    flag = "●" if not m["read"] else " "
    who = "@" + m["username"] if m.get("username") else m["from"]
    print(f"{flag} [{m['at'][:16]}] {who}: {m['text'][:160]}")
EOF
if [ "$MARK" = "1" ]; then
  curl -s -m 10 -X POST http://localhost:3005/read -H 'content-type: application/json' -H "x-nexus-key: $NEXUS_KEY" -d '{"all":true}' >/dev/null
  echo "(marked all read)"
fi
