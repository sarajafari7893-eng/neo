#!/bin/bash
# NEXUS//SIGNALS — Phase B: DB blood-swap under full writer freeze (trace 1a15e9b9286f74a5)
set -u
cd /home/z/my-project
TS=$(date -u +%Y%m%d-%H%M%S)
echo "=== PHASE B START $TS ==="

# 1) pause files (defense in depth) + SIGSTOP every writer/guardian
echo $(( $(date +%s) + 420 )) > .data/p0-watchdog/pause-until 2>/dev/null
echo $(( $(date +%s) + 420 )) > .data/mem-guard/pause-until 2>/dev/null
BUN_PIDS=$(pgrep -f "bun (run |--hot)" 2>/dev/null | tr '\n' ' ')
WD_PIDS=$(pgrep -f "watchdog.sh --loop" 2>/dev/null | tr '\n' ' ')
echo "freezing: BUN[$BUN_PIDS] WD[$WD_PIDS]"
for p in $BUN_PIDS $WD_PIDS; do kill -STOP "$p" 2>/dev/null; done

# 2) graceful app stop — wait for real exit + port close
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null
for i in $(seq 1 15); do pgrep -f "next-server" >/dev/null 2>&1 || break; sleep 1; done
pgrep -f "next-server" >/dev/null 2>&1 && { pkill -9 -f "next-server"; sleep 2; }
for i in $(seq 1 10); do ss -ltn 2>/dev/null | grep -q ':3000 ' || break; sleep 1; done
echo "app stopped; port 3000 free"

# 3) fresh merge from the FROZEN live db (captures the final minutes)
bun scripts/merge-db-restore.ts /tmp/restore-staging/merged-final.db 2>&1 | tail -18

# 4) swap
if [ ! -s /tmp/restore-staging/merged-final.db ]; then
  echo "FATAL: merged-final.db missing — ABORT, live db untouched"
  for p in $BUN_PIDS $WD_PIDS; do kill -CONT "$p" 2>/dev/null; done
  exit 1
fi
mv db/custom.db "db/custom.db.pre-recovery-$TS" 2>/dev/null
rm -f db/custom.db-wal db/custom.db-shm
cp /tmp/restore-staging/merged-final.db db/custom.db
rm -f db/custom.db-wal db/custom.db-shm
chmod 664 db/custom.db 2>/dev/null
echo "SWAP DONE: $(ls -la db/custom.db | awk '{print $5}') bytes (aside: db/custom.db.pre-recovery-$TS)"

# 5) thaw guardians first, then services
for p in $WD_PIDS $BUN_PIDS; do kill -CONT "$p" 2>/dev/null; done
echo "thawed"

# 6) restart app — dev-up single-writer protocol (pause file, graceful spawn, warmers, watchdog re-arm)
echo $(( $(date +%s) + 180 )) > .data/p0-watchdog/pause-until 2>/dev/null
setsid bash scripts/dev-up.sh >> logs/phase-b-devup.log 2>&1 < /dev/null &
echo "dev-up spawn issued"
echo "=== PHASE B SCRIPT DONE ==="
