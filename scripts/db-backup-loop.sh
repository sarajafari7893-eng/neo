#!/bin/bash
# db-backup-loop — owned spawn (setsid), hourly call; the 3.5h min-interval
# guard lives inside db-backup.sh so overlapping callers are safe.
while true; do
  bash /home/z/my-project/scripts/db-backup.sh >> /home/z/my-project/scripts/db-backup.log 2>&1 || true
  sleep 3600
done
