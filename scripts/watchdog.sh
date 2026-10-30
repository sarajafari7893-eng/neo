#!/bin/bash
# ── NEXUS//SIGNALS — P0 WATCHDOG v3.1 ─────────────────────────────────────
# Ops mandate 2026-09-09: «نصب P0 watchdog رو کامل و مهندسی انجام بده»
#
# Lineage: v6.2 (60s probe → 2 fails → dev-up.sh) was BUILT but DORMANT —
# never armed, not persistent across sandbox sessions (R29 audit: the 13:45
# OOM stayed dead because the external keep-alive PINGS but never RESTARTS).
# v3 closes that gap with self-arming (dev-up.sh block + /api/pulse ensure
# hook) and the hardening agreed in R29 "Next phase agreed plan":
#   · flock single-instance cycle lock + pidfile (+ --loop double-arm guard)
#   · recovery backoff (cooldown) + rolling-hour circuit breaker → alert-only
#   · RSS/memory channel (alert-only — the 1400MB heap cap stays line one)
#   · sidecar monitor channel: liq:3010 + price-ws:3003 LOG-ONLY by design
#     (both degrade gracefully inside the app: REST-poll fallback / derived
#     probes → data-quality risk, not capital risk; bun restarts stay manual)
#   · --status / --once / --stop for operator control + testability
#   · honors the OP-P0-WD-0909 pause-until contract: dev-up.sh writes
#     .data/p0-watchdog/pause-until (now+120s) across its restart window and
#     v3.1 skips app-fail counting while it is active (no false restarts)
#
# Constraints honored: NEVER touches SQLite, NEVER runs `bun run build`;
# the only recovery action is scripts/dev-up.sh (heap-capped, idempotent).
# Records: scripts/watchdog.log (trimmed 500 lines) + .data/watchdog/
# {pid,lock,state,restarts.log}. Counters survive watchdog restarts.

LOG=/home/z/my-project/scripts/watchdog.log
PROJECT=/home/z/my-project
WD="$PROJECT/.data/watchdog"
PIDF="$WD/pid"; LOCKF="$WD/lock"; STATEF="$WD/state"; BREAKERF="$WD/restarts.log"

INTERVAL=60               # probe cadence (s)
FAILS_TO_RESTART=2        # consecutive app failures before recovery
COOLDOWN_SECS=480         # min spacing between recoveries (backoff)
BREAKER_MAX=3             # max recoveries per rolling hour → then alert-only
RSS_WARN_MB=2000          # EQ-98 (2026-10-13), re-verified 2026-10-14 on the October
                          # tree (v11.6, next 16.1.3): warm plateau 2.16-2.30GB with
                          # V8=768MB + turbopack 384MiB — warn only above the envelope.
RSS_CRIT_MB=2500          # EQ-98, recalibrated 2026-10-14 (Oct root-cause): the v11.6
                          # tree legitimately plateaus 2.16-2.39GB under the warm-loop
                          # 5s tick — 2300×3 would treadmill. True runaway line sits at
                          # 2.5GB+ (the 10:53Z kernel kill fired at 2.52GB; 2.3GB with
                          # avail>600MB ran 20+ min unharmed). Box-level protection is
                          # owned by MEM-GUARD (P1d, avail<550×2) — this channel is
                          # now the pure runaway backstop.
MEM_AVAIL_WARN_MB=300     # OOM proximity on the 4GB no-swap box (P1b suspend+hygiene)
MEM_AVAIL_RESTART_MB=550  # MEM-GUARD v2 (2026-10-14 root-cause: TWO kernel OOMs at
                          # 10:53/11:05Z killed next-server at RSS 2.18-2.52GB while the
                          # RSS-CRIT channel sat idle — the kill driver was BOX avail
                          # (241MB), not app RSS. The October dev graph (78 routes,
                          # +506 engine lines, warm-loop 5s tick) plateaus ~2.2-2.5GB,
                          # so avail — not RSS — is the leading indicator. Sustained
                          # avail <550MB ×2 cycles (~2min, above the 300MB P1b line so
                          # the big lever engages first) → controlled dev-up restart
                          # (frees ~2.2GB instantly) under the same stand-down/cooldown/
                          # breaker contract. No more kernel SIGKILL chaos.
SIDE_FAILS_TO_ALERT=3     # sidecar consecutive fails before an ERROR line
HEARTBEAT_EVERY=15        # every N cycles (~15min) log a green heartbeat

mkdir -p "$WD"; touch "$LOG"

say() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $1" >> "$LOG"; }

trim_log() {
  local lines; lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  [ "$lines" -gt 500 ] && { tail -200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; }
  return 0
}

getk() { # numeric state key → echoes value or 0 (counters survive restarts)
  local v=""
  [ -f "$STATEF" ] && v=$(grep -m1 "^$1=" "$STATEF" 2>/dev/null | cut -d= -f2)
  echo "${v:-0}"
}

setk() {
  if grep -q "^$1=" "$STATEF" 2>/dev/null; then
    sed -i "s/^$1=.*/$1=$2/" "$STATEF"
  else
    echo "$1=$2" >> "$STATEF"
  fi
}

probe() { curl -s -m "$2" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
# note: curl itself prints 000 on connect failure — never append a fallback

breaker_count() {
  [ -f "$BREAKERF" ] || { echo 0; return; }
  local cutoff=$(( $(date +%s) - 3600 ))
  awk -v c="$cutoff" '$1 >= c' "$BREAKERF" 2>/dev/null | wc -l
}

note_recovery() {
  echo "$(date +%s)" >> "$BREAKERF"
  local lines; lines=$(wc -l < "$BREAKERF")
  [ "$lines" -gt 50 ] && { tail -20 "$BREAKERF" > "$BREAKERF.tmp" && mv "$BREAKERF.tmp" "$BREAKERF"; }
  return 0
}

rss_mb() { # summed RSS of the next dev server + worker (MB)
  local total=0 pid kb
  for pid in $(pgrep -f 'next dev|next-server' 2>/dev/null); do
    kb=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$kb" ] && total=$(( total + kb ))
  done
  echo $(( total / 1024 ))
}

one_cycle() {
  exec 9>>"$LOCKF"
  if ! flock -n 9; then
    say "skip: another watchdog cycle holds the lock"
    exec 9>&-   # v3.2b (RECOVERY-0927): never leak the lock fd on the skip path
    return 1
  fi
  local now; now=$(date +%s)
  local cyc; cyc=$(( $(getk cycle_n) + 1 )); setk cycle_n "$cyc"

  # ── P0 · app (the trading engine) ────────────────────────────────
  # pause-until contract (OP-P0-WD-0909): while dev-up.sh is restarting the
  # server, a booting app looks "down" — skip app-fail COUNTING entirely.
  local pause_until; pause_until=$(cat "$PROJECT/.data/p0-watchdog/pause-until" 2>/dev/null || echo 0)
  if [ "${pause_until:-0}" -gt "$now" ] 2>/dev/null; then
    say "PAUSED: dev-up restart window ($(( pause_until - now ))s left) — app probe skipped, sidecars still monitored"
  else
  local code; code=$(probe http://localhost:3000/api/pulse 8)
  if [ "$code" = "200" ]; then
    if [ "$(getk app_fails)" -ge "$FAILS_TO_RESTART" ]; then
      say "RECOVERED: app pulse 200 (was failing)"
    fi
    setk app_fails 0
  else
    local f; f=$(( $(getk app_fails) + 1 )); setk app_fails "$f"
    say "APP DOWN: http:$code fail#$f/$FAILS_TO_RESTART"
    if [ "$f" -ge "$FAILS_TO_RESTART" ]; then
      local last; last=$(getk last_recovery_epoch)
      # shared pause: layer-1 p0-watchdog (:3020) restart window — stand down,
      # never race its heal (dev-up.sh writes the pause file when IT restarts)
      local p0pause; p0pause=$(cat "$PROJECT/.data/p0-watchdog/pause-until" 2>/dev/null || echo 0)
      if [ "$now" -lt "${p0pause:-0}" ]; then
        say "STAND DOWN: layer-1 restart window active ($(( p0pause - now ))s left) — heal owned by p0-watchdog :3020"
      elif [ $(( now - last )) -lt "$COOLDOWN_SECS" ]; then
        say "BACKOFF: recovery suppressed ($(( now - last ))s < ${COOLDOWN_SECS}s since last) — still down, retrying next cycles"
      elif [ "$(breaker_count)" -ge "$BREAKER_MAX" ]; then
        say "BREAKER OPEN: $(breaker_count) recoveries in the last hour — ALERT-ONLY, no action (operator attention required)"
      else
        say "ACTION: dev-up.sh restart (heap-capped 1400MB)"
        timeout 300 bash "$PROJECT/scripts/dev-up.sh" >> "$LOG" 2>&1
        local rc=$?
        note_recovery; setk last_recovery_epoch "$now"
        setk recoveries_total $(( $(getk recoveries_total) + 1 ))
        local post; post=$(probe http://localhost:3000/api/pulse 8)
        if [ "$post" = "200" ]; then
          say "RESTART OK: pulse 200 (dev-up rc=$rc)"
          setk app_fails 0
        else
          say "RESTART INCOMPLETE: pulse $post (dev-up rc=$rc) — backoff then retry"
        fi
      fi
    fi
  fi
  fi # pause-until window

  # ── P1 · RSS / memory channel (alert-only) ───────────────────────
  local rss; rss=$(rss_mb); setk last_rss_mb "$rss"
  if [ "$rss" -ge "$RSS_WARN_MB" ]; then
    # state-change dedupe: log on enter, not every cycle
    [ "$(getk rss_warn_active)" != "1" ] && say "MEM WARN: next RSS ${rss}MB >= ${RSS_WARN_MB}MB (heap cap 768MB bounds JS old-space only — turbopack native + V8 external sit outside)"
    setk rss_warn_active 1
  else
    setk rss_warn_active 0
  fi
  # ── P1c · RECOVERY-0928: RSS CRIT restart guard (bounded memory treadmill) ──
  # The 4GB no-swap box OOM-kills next-server around ~3GB RSS. Sustained
  # ≥RSS_CRIT_MB for 3 consecutive cycles (~3min) → proactive dev-up restart,
  # same breaker/cooldown contract as the P0 app-down heal. Keeps MemAvailable
  # away from the kernel-OOM zone that invites both in-guest kills and
  # platform distress-recycles.
  if [ "$rss" -ge "$RSS_CRIT_MB" ]; then
    local rcst; rcst=$(( $(getk rss_crit_streak) + 1 )); setk rss_crit_streak "$rcst"
    if [ "$rcst" -ge 3 ]; then
      setk rss_crit_streak 0
      local lastr2; lastr2=$(getk last_recovery_epoch)
      local p0pause2; p0pause2=$(cat "$PROJECT/.data/p0-watchdog/pause-until" 2>/dev/null || echo 0)
      if [ "$now" -lt "${p0pause2:-0}" ]; then
        say "RSS CRIT STAND DOWN: layer-1 restart window active — defer"
      elif [ $(( now - ${lastr2:-0} )) -lt "$COOLDOWN_SECS" ]; then
        say "RSS CRIT BACKOFF: restart suppressed (cooldown $(( now - lastr2 ))s < ${COOLDOWN_SECS}s)"
      elif [ "$(breaker_count)" -ge "$BREAKER_MAX" ]; then
        say "RSS CRIT BREAKER OPEN: $(breaker_count)/h — alert-only, operator attention"
      else
        say "RSS CRIT ACTION: RSS ${rss}MB >= ${RSS_CRIT_MB}MB ×3 cycles — proactive restart before kernel OOM"
        note_recovery
        pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 1
        timeout 300 bash "$PROJECT/scripts/dev-up.sh" >> "$LOG" 2>&1
      fi
    fi
  else
    setk rss_crit_streak 0
  fi
  local avail; avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
  if [ -n "$avail" ]; then
    setk last_mem_avail_mb "$avail"
    [ "$avail" -lt "$MEM_AVAIL_WARN_MB" ] && say "MEM WARN: available ${avail}MB < ${MEM_AVAIL_WARN_MB}MB — OOM proximity (no swap)"
    # ── P1b · v10.16 audit: memory ACTION (was alert-only) ─────────
    # 0912 OOM post-mortem: MemAvailable <300MB preceded the kill with only a
    # LOG line. Action now (15min-limited): 10min lease suspending the app's
    # background LLM tier (.data/ai/background-suspend, consumed by ai.ts) +
    # aggressive disk-hygiene pass. Cleared at >=450MB.
    if [ "$avail" -lt "$MEM_AVAIL_WARN_MB" ]; then
      local lastma; lastma=$(cat "$PROJECT/.data/p0-watchdog/last-mem-action" 2>/dev/null || echo 0)
      if [ $(( now - ${lastma:-0} )) -ge 900 ]; then
        echo "$now" > "$PROJECT/.data/p0-watchdog/last-mem-action" 2>/dev/null
        mkdir -p "$PROJECT/.data/ai" 2>/dev/null
        echo $(( now + 600 )) > "$PROJECT/.data/ai/background-suspend" 2>/dev/null
        say "MEM ACTION: available ${avail}MB < ${MEM_AVAIL_WARN_MB}MB — bg-LLM suspended 10min + disk-hygiene 768"
        bash "$PROJECT/scripts/disk-hygiene.sh" 768 >> "$LOG" 2>&1 || true
      fi
    elif [ "$avail" -ge 450 ] && [ -f "$PROJECT/.data/ai/background-suspend" ]; then
      rm -f "$PROJECT/.data/ai/background-suspend" 2>/dev/null
    fi
    # ── P1d · MEM-GUARD v2 (2026-10-14): box-avail restart channel ──
    # Root-cause fix for the double kernel-OOM (10:53Z RSS 2.52GB / 11:05Z RSS
    # 2.18GB): in both kills the driver was MemAvailable (241MB at the 11:00
    # mem-crit log), NOT app RSS — the RSS-CRIT channel never saw a sustained
    # breach. The October dev plateau (~2.2-2.5GB under the operator-mandated
    # warm-loop 5s tick) leaves ~1.2GB of headroom against the fleet; a stacked
    # transient (armor git hashing, backtest, postcss rebuild) can eat it in
    # minutes. This channel watches the LEADING indicator: sustained
    # avail < MEM_AVAIL_RESTART_MB ×2 cycles → controlled restart NOW, while
    # the box still has memory to boot cleanly (a kernel OOM mid-boot is what
    # produced the three silent dead boots of 11:06-11:11Z). Same defense
    # ladder as every other recovery: stand-down → cooldown → breaker.
    if [ "$avail" -lt "$MEM_AVAIL_RESTART_MB" ]; then
      local mst; mst=$(( $(getk mem_crit_streak) + 1 )); setk mem_crit_streak "$mst"
      if [ "$mst" -ge 2 ]; then
        setk mem_crit_streak 0
        local lastr3; lastr3=$(getk last_recovery_epoch)
        local p0pause3; p0pause3=$(cat "$PROJECT/.data/p0-watchdog/pause-until" 2>/dev/null || echo 0)
        if [ "$now" -lt "${p0pause3:-0}" ]; then
          say "MEM-GUARD STAND DOWN: layer-1 restart window active — defer (avail ${avail}MB)"
        elif [ $(( now - ${lastr3:-0} )) -lt "$COOLDOWN_SECS" ]; then
          say "MEM-GUARD BACKOFF: restart suppressed (cooldown; avail ${avail}MB) — P1b levers carry"
        elif [ "$(breaker_count)" -ge "$BREAKER_MAX" ]; then
          say "MEM-GUARD BREAKER OPEN: $(breaker_count)/h — alert-only (avail ${avail}MB); operator attention"
        else
          say "MEM-GUARD ACTION: available ${avail}MB < ${MEM_AVAIL_RESTART_MB}MB ×2 cycles — controlled restart before kernel OOM (Oct plateau ~2.2-2.5GB + fleet ~1.1GB on 4GB no-swap)"
          note_recovery; setk last_recovery_epoch "$now"
          setk recoveries_total $(( $(getk recoveries_total) + 1 ))
          pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 1
          timeout 300 bash "$PROJECT/scripts/dev-up.sh" >> "$LOG" 2>&1
          local postm; postm=$(probe http://localhost:3000/api/pulse 8)
          if [ "$postm" = "200" ]; then
            say "MEM-GUARD RESTART OK: pulse 200 — box pressure released (avail $(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)MB)"
          else
            say "MEM-GUARD RESTART INCOMPLETE: pulse $postm — dev-up retries own probes; next cycle re-checks"
          fi
        fi
      else
        say "MEM-GUARD ARMING: available ${avail}MB < ${MEM_AVAIL_RESTART_MB}MB (streak 1/2 — restarts next cycle if sustained)"
      fi
    else
      setk mem_crit_streak 0
    fi
  fi

  # ── P2 · sidecar monitor channel (LOG-ONLY) ──────────────────────
  local liq ws liq_ok ws_ok
  liq=$(probe http://localhost:3010/health 5)
  ws=$(probe http://localhost:3003/ 5)
  liq_ok=0; [ "$liq" = "200" ] && liq_ok=1
  ws_ok=0;  { [ "$ws" = "200" ] || [ "$ws" = "400" ]; } && ws_ok=1
  if [ "$liq_ok" = "1" ]; then
    setk liq_fails 0
  else
    setk liq_fails $(( $(getk liq_fails) + 1 ))
    [ "$(getk liq_fails)" -ge "$SIDE_FAILS_TO_ALERT" ] && say "SIDECAR ERROR (log-only): liq-service :3010 http:$liq fails=$(getk liq_fails) — app falls back to derived probe; manual restart: cd $PROJECT && bun run mini-services/liq-service/index.ts"
  fi
  if [ "$ws_ok" = "1" ]; then
    setk ws_fails 0
  else
    setk ws_fails $(( $(getk ws_fails) + 1 ))
    [ "$(getk ws_fails)" -ge "$SIDE_FAILS_TO_ALERT" ] && say "SIDECAR ERROR (log-only): price-ws :3003 http:$ws fails=$(getk ws_fails) — app demotes to REST 2.5s poll; manual restart: cd $PROJECT/mini-services/price-ws && bun index.ts"
  fi

  # ── P2.5 · telegram bridge :3005 — OWNED heal (v3.2) ───────────────
  # ROLLBACK-RECOVERY-0912-0030: the platform rollback killed the bridge and
  # manual spawns die with their spawning session — only watchdog-tree spawns
  # persist. The bridge is the operator's ONLY inbound channel, so unlike the
  # log-only sidecars it gets an owned respawn here (rate-limited 300s).
  local bcode; bcode=$(probe http://localhost:3005/health 5)
  if [ "$bcode" != "200" ]; then
    local blast; blast=$(getk last_bridge_spawn)
    if [ $(( now - ${blast:-0} )) -ge 300 ]; then
      # v10.16 audit: cross-layer ledger — if layer-1 (p0-watchdog) healed this
      # service <300s ago, defer (no dueling spawns, shared stamp file)
      local bl2; bl2=$(cat "$PROJECT/.data/p0-watchdog/heal-bridge" 2>/dev/null || echo 0); bl2="${bl2%%:*}"
      if [ $(( now - ${bl2:-0} )) -lt 300 ]; then
        say "HEAL SKIP: bridge healed <300s ago by layer-1 (cross-layer ledger)"
      else
        say "BRIDGE DOWN (http:$bcode) — respawn bun index.ts (owned by watchdog)"
        # 9>&- — the child MUST NOT inherit the locked flock fd (v3.2a: an
        # inheriting child pins the lock forever and deadlocks every cycle)
        ( cd "$PROJECT/mini-services/telegram-bridge" && setsid bash -c 'exec bun index.ts' </dev/null 9>&- >> /tmp/bridge-wd.out 2>&1 & )
        setk last_bridge_spawn "$now"
        echo "$now:$$" > "$PROJECT/.data/p0-watchdog/heal-bridge" 2>/dev/null
      fi
    fi
  else
    setk bridge_fails 0
  fi

  # ── P2.6 · price-ws :3003 — OWNED heal (v3.2, same rationale as bridge) ──
  # The rollback left a live-but-deaf ws proc (files swapped under it). Manual
  # spawns die with their session; owned spawns persist. Graceful degradation
  # in the app stays, but a healable ws beats a permanent REST-poll demotion.
  # v14.1 RING-FRESHNESS probe (operator drought trace 1a18c926cd7742fd):
  #   port-up ≠ rings-up. On 10-30 a deaf proc answered :3003 with HTTP 200 for
  #   ~5h (10:14→15:00 Tehran) while BOTH quote rings were dead — futws froze
  #   at 43 rows (10:14) and the dashboard FUTWS plane starved on "WARMING".
  #   The probe below now ALSO reads the ring's product file: futws-quotes.json
  #   is pushed every 3s, so mtime >120s = deaf rings REGARDLESS of the port.
  #   Kill is by listening port (the proc's cmdline is just "bun index.ts" —
  #   `pkill -f price-ws` never matched anything; the old kill was a no-op and
  #   the respawn lost the port race silently). 180s post-spawn grace keeps the
  #   staggered ring warm-up out of the staleness verdict.
  local wcode; wcode=$(probe http://localhost:3003/ 5)
  local wring_stale=0
  local wfile="$PROJECT/.data/futws-quotes.json"
  if [ -f "$wfile" ]; then
    local wmt; wmt=$(stat -c %Y "$wfile" 2>/dev/null || echo 0)
    [ $(( $(date +%s) - ${wmt:-0} )) -gt 120 ] && wring_stale=1
  else
    wring_stale=1
  fi
  local wlast; wlast=$(getk last_ws_spawn)
  local wport_down=0
  { [ "$wcode" != "200" ] && [ "$wcode" != "400" ]; } && wport_down=1
  # ring-staleness only counts once a fresh spawn had its warm-up window
  { [ "$wring_stale" = "1" ] && [ $(( now - ${wlast:-0} )) -ge 180 ]; } && wport_down=1
  if [ "$wport_down" = "1" ]; then
    if [ $(( now - ${wlast:-0} )) -ge 300 ]; then
      # v10.16 audit: cross-layer ledger (same contract as bridge heal)
      local wl2; wl2=$(cat "$PROJECT/.data/p0-watchdog/heal-ws" 2>/dev/null || echo 0); wl2="${wl2%%:*}"
      if [ $(( now - ${wl2:-0} )) -lt 300 ]; then
        say "HEAL SKIP: price-ws healed <300s ago by layer-1 (cross-layer ledger)"
      else
        if [ "$wring_stale" = "1" ] && [ "$wcode" = "200" -o "$wcode" = "400" ]; then
          say "PRICE-WS RING-STALE (port:$wcode ok but futws file >120s — deaf rings, product is the file) — kill + respawn (owned by watchdog)"
        else
          say "PRICE-WS DEAF (http:$wcode, proc alive?) — kill + respawn (owned by watchdog)"
        fi
        # kill by LISTENING PORT — cmdline is "bun index.ts", name-matches never hit it
        ss -tlnp 2>/dev/null | grep -E ':3003\b' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u | xargs -r kill 2>/dev/null
        sleep 1
        ( cd "$PROJECT/mini-services/price-ws" && setsid bash -c 'exec bun index.ts' </dev/null 9>&- >> /tmp/ws-wd.out 2>&1 & )
        setk last_ws_spawn "$now"
        echo "$now:$$" > "$PROJECT/.data/p0-watchdog/heal-ws" 2>/dev/null
      fi
    fi
  fi

  # ── P2.7 · mem-guard :3019 — OWNED heal (v3.3, RECOVERY-1016) ──
  # 2026-10-16 incident: the recycle killed mem-guard and NOTHING re-spawned it
  # → the rollback sentinel + OOM guard + schema gate were all dead for ~50min
  # while the box ran on a 19-day-stale tree. mem-guard is the boot authority —
  # it gets an owned heal here (mem-guard-up.sh is idempotent + probe-gated).
  local mcode; mcode=$(probe http://localhost:3019/health 5)
  if [ "$mcode" != "200" ]; then
    local mlast; mlast=$(getk last_memspawn)
    if [ $(( now - ${mlast:-0} )) -ge 300 ]; then
      local ml2; ml2=$(cat "$PROJECT/.data/p0-watchdog/heal-mem" 2>/dev/null || echo 0); ml2="${ml2%%:*}"
      if [ $(( now - ${ml2:-0} )) -lt 300 ]; then
        say "HEAL SKIP: mem-guard healed <300s ago by layer-1 (cross-layer ledger)"
      else
        say "MEM-GUARD DOWN (http:$mcode) — spawn via mem-guard-up.sh (owned by watchdog)"
        ( setsid bash "$PROJECT/scripts/mem-guard-up.sh" </dev/null 9>&- >> /tmp/mem-wd.out 2>&1 & )
        setk last_memspawn "$now"
        echo "$now:$$" > "$PROJECT/.data/p0-watchdog/heal-mem" 2>/dev/null
      fi
    fi
  fi

  # ── P3 · supervisor-of-the-supervisor: keep layer-1 guardian alive ──
  # Layer-1 (mini-services/p0-watchdog :3020) owns fast healing of all three
  # services; this loop revives it if it dies or hangs (3 failed probes ≈ 3min).
  local p0 p0fails p0pid
  p0=$(probe http://localhost:3020/health 4)
  if [ "$p0" = "200" ]; then
    setk p0_fails 0
  else
    p0fails=$(( $(getk p0_fails) + 1 )); setk p0_fails "$p0fails"
    if [ "$p0fails" -ge 3 ]; then
      p0pid=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$PROJECT/.data/p0-watchdog/lock.json" 2>/dev/null)
      if [ -n "$p0pid" ] && kill -0 "$p0pid" 2>/dev/null; then
        say "LAYER1 HUNG: health http:$p0 but pid $p0pid alive — recycling guardian"
        kill "$p0pid" 2>/dev/null; sleep 1
      else
        say "LAYER1 DOWN: health http:$p0 fails=$p0fails — re-arming guardian"
      fi
      bash "$PROJECT/scripts/watchdog-up.sh" >> "$LOG" 2>&1
      setk p0_fails 0
    fi
  fi

  setk last_cycle_epoch "$now"
  [ $(( cyc % HEARTBEAT_EVERY )) -eq 0 ] && say "heartbeat: green cycles=$cyc rss=${rss}MB avail=${avail:-?}MB liq=$liq ws=$ws breaker=$(breaker_count)/$BREAKER_MAX"
  trim_log
  # v3.2b (RECOVERY-0927): release the flock at cycle end. A persistently-open
  # fd 9 pins the lock across the inter-cycle sleep AND leaks into every spawned
  # child (dev-up, self-warm, heal spawns) — one inheriting child can blind the
  # entire two-layer stack.
  exec 9>&-
  return 0
}

case "${1:---loop}" in
  --once)
    one_cycle; exit $?
    ;;
  --loop)
    # v3.3 INSTANCE LOCK (fd 8) — the pidfile check alone had a TOCTOU race:
    # 2026-10-16 boot armed TWO loops (pid 1366+1439 same minute — both passed
    # the pidfile check before either wrote it). flock is atomic; the pidfile
    # stays for operator visibility. fd 8 ≠ cycle lock fd 9 (nested-safe).
    exec 8>>"$LOCKF.loop"
    if ! flock -n 8; then
      echo "refusing: another watchdog LOOP holds the instance lock"
      exit 0
    fi
    if [ -f "$PIDF" ]; then
      held_pid=$(cat "$PIDF" 2>/dev/null)
      if [ -n "$held_pid" ] && [ "$held_pid" != "$$" ] && kill -0 "$held_pid" 2>/dev/null; then
        echo "refusing: watchdog already running pid=$held_pid"
        exit 0
      fi
    fi
    echo $$ > "$PIDF"
    say "P0 WATCHDOG v3.1 ARMED (pid $$) — ${INTERVAL}s probe · restart @${FAILS_TO_RESTART} fails · backoff ${COOLDOWN_SECS}s · breaker ${BREAKER_MAX}/h · sidecars log-only · heartbeat /${HEARTBEAT_EVERY} · pause-until honored"
    while true; do
      one_cycle || true
      sleep "$INTERVAL"
    done
    ;;
  --stop)
    if [ -f "$PIDF" ]; then
      stop_pid=$(cat "$PIDF" 2>/dev/null)
      if [ -n "$stop_pid" ] && kill -0 "$stop_pid" 2>/dev/null; then
        kill "$stop_pid" && echo "watchdog stopped (pid $stop_pid)"
      else
        echo "watchdog not running (stale pidfile)"
      fi
      rm -f "$PIDF"
    else
      echo "watchdog not running"
    fi
    ;;
  --status)
    echo "== NEXUS P0 WATCHDOG v3.1 =="
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then
      echo "loop: RUNNING pid=$(cat "$PIDF")"
    else
      echo "loop: NOT RUNNING"
    fi
    echo "state: $(tr '\n' ' ' < "$STATEF" 2>/dev/null)"
    echo "recoveries_last_hour: $(breaker_count)/$BREAKER_MAX"
    echo "-- last 12 log lines --"
    tail -12 "$LOG" 2>/dev/null
    ;;
  *)
    echo "usage: watchdog.sh [--loop|--once|--status|--stop]"
    exit 2
    ;;
esac
