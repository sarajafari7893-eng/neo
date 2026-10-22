#!/bin/bash
# recovery-restart-20261019.sh — one-shot orchestrated restart after VM re-provision
# (boot 10:31 reverted code tree to Sep-27 snapshot; October tree restored from
#  /tmp/my-project PolarFS snapshot Oct 18 21:26 — engine v12.1 + all services)
# Order: pause L1 watchdog → clear PID-reuse stale locks → kill all → dev-up.sh
#        (app + warm-loop) → base services → liq/armor/watchdog → October extras.
set -u
cd /home/z/my-project

echo "[R] $(date -u '+%H:%M:%SZ') pause L1 watchdog (420s)"
echo $(( $(date +%s) + 420 )) > .data/p0-watchdog/pause-until 2>/dev/null || true

echo "[R] clear stale pid-locks (PID-reuse victims of the re-provision)"
rm -f .data/supervisor-cron/lock.json
rm -f mini-services/telegram-bridge/state/relay.pid

echo "[R] kill app + all services"
pkill -f "p0-watchdog" 2>/dev/null
sleep 1
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
pkill -f "bun --hot index.ts" 2>/dev/null
pkill -f "bun run mini-services" 2>/dev/null
pkill -f "bun run dev" 2>/dev/null
sleep 4
pkill -9 -f "next-server" 2>/dev/null
pkill -9 -f "bun --hot index.ts" 2>/dev/null
pkill -9 -f "bun run dev" 2>/dev/null
sleep 2
echo "[R] survivors: $(pgrep -f 'next dev|bun --hot|bun run' | wc -l)"

echo "[R] start app via dev-up.sh v8.4 (app + warm-loop, pause-aware)"
setsid bash scripts/dev-up.sh >> logs/dev-up-recovery.log 2>&1 < /dev/null &
sleep 5

echo "[R] start base mini-services"
for s in price-ws sentinel-service supervisor-cron telegram-bridge trade-service; do
  ( cd "/home/z/my-project/mini-services/$s" && setsid nohup bun --hot index.ts >> "/home/z/my-project/logs/$s.log" 2>&1 < /dev/null & )
done

echo "[R] start liq + push-armor"
( setsid nohup bun run mini-services/liq-service/index.ts >> logs/liq-service.log 2>&1 < /dev/null & )
( cd /home/z/my-project/mini-services/push-armor && setsid nohup bun --hot index.ts >> /home/z/my-project/logs/push-armor.log 2>&1 < /dev/null & )

echo "[R] start October extras (mem-guard, stable-feed, keep-warm, supervisor-sr)"
for s in mem-guard stable-feed keep-warm supervisor-sr; do
  ( cd "/home/z/my-project/mini-services/$s" && setsid nohup bun --hot index.ts >> "/home/z/my-project/logs/$s.log" 2>&1 < /dev/null & )
done

sleep 3
echo "[R] start L1 p0-watchdog LAST (it heals whatever is still missing)"
( cd /home/z/my-project/mini-services/p0-watchdog && setsid nohup bun --hot index.ts >> /home/z/my-project/logs/p0-watchdog-service.log 2>&1 < /dev/null & )

echo "[R] $(date -u '+%H:%M:%SZ') restart wave issued — cold compile ~30-60s"
