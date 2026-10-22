#!/bin/bash
# NEXUS//SIGNALS — start every mini-service (bare-metal/systemd, no --hot).
# Production note: --hot is a dev convenience; supervised units replace it.
ROOT=/home/z/my-project
mkdir -p "$ROOT/logs" "$ROOT/.data"
for svc in price-ws telegram-bridge liq-service trade-service supervisor-cron push-armor sentinel-service warm-loop; do
  dir="$ROOT/mini-services/$svc"
  [ -d "$dir" ] || { echo "skip $svc (missing)"; continue; }
  ( cd "$dir" && nohup bun index.ts >> "$ROOT/logs/${svc}.log" 2>&1 & )
  echo "started $svc"
done
# settle, then exit — systemd Type=forking treats us as the parent of the group
sleep 3
exit 0
