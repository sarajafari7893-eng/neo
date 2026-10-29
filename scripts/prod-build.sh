#!/bin/bash
# ── NEXUS//SIGNALS — prod-build.sh (v14.0, trace 1a185042c872b4f9) ──────────
# PRODUCTION BUILD for the standalone output — the structural OOM root-cure
# the operator commissioned («باقی‌ماندهٔ ساختاری (build محصولی برای ریشه‌کنی
# کامل OOM-cycle) کامل و مهندسی انجام بده»).
#
# WHY: dev-mode Turbopack holds an unbounded module graph + hydration spikes;
# the kernel killed next-server at ~2.0-2.1GB anon-rss (109 OOM kills in 11
# days on this 4GB no-swap box). The standalone production server carries NO
# compile graph — steady-state RSS drops to a fraction of dev and the kill
# loop structurally cannot recur.
#
# CONTRACT: run ONLY while the app is verifiably dead (port 3000 closed) —
# the build itself needs the memory headroom. dev-up.sh prod-mode calls this
# on the AUTO-FRESH escalation path (same safe moment doctrine).
set -u
cd /home/z/my-project || exit 1

if curl -s -m 3 -o /dev/null http://localhost:3000/api/pulse 2>/dev/null; then
  echo "[prod-build] REFUSED — app answers on :3000 (build must run server-dead)"
  exit 1
fi

echo "[prod-build] next build starting $(date -u '+%H:%M:%SZ') mem=$(awk '/MemAvailable/{printf "%dMB", $2/1024}' /proc/meminfo)"
NODE_OPTIONS="--max-old-space-size=1536" ./node_modules/.bin/next build
BUILD_RC=$?
if [ $BUILD_RC -ne 0 ]; then
  echo "[prod-build] FAILED rc=$BUILD_RC $(date -u '+%H:%M:%SZ')"
  exit $BUILD_RC
fi
# standalone packaging (same contract as the legacy `bun run build` script)
rm -rf .next/standalone/.next/static 2>/dev/null
cp -r .next/static .next/standalone/.next/ || exit 1
cp -r public .next/standalone/ || exit 1
# v14.0 SPLIT-BRAIN GUARD — the generated server.js does process.chdir(__dirname),
# so the app's RELATIVE runtime paths (.data/*, db/custom.db, logs/*) would hit
# the stale output-traced COPIES inside .next/standalone (build-time snapshots)
# — SQLite split-brain (two DB files) is the exact write-lock class the
# persist-guard retired. Symlinks are sandbox-denied, so instead: (a) strip the
# chdir from the generated server.js (dev-up spawns it with cwd=project root —
# every relative store path then hits the ONE real filesystem), and (b) delete
# the traced store copies so they can never serve stale data.
sed -i 's|^process\.chdir(__dirname);$|// v14.0 split-brain guard: chdir stripped — server runs from the project root|; s|^process\.chdir(__dirname)$|// v14.0 split-brain guard: chdir stripped — server runs from the project root|' .next/standalone/server.js
for d in .data db logs backups; do
  rm -rf ".next/standalone/$d"
done
echo "[prod-build] OK $(date -u '+%H:%M:%SZ') standalone ready (server.js chdir-stripped + static + public)"
