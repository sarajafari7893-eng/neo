#!/bin/bash
# ── NEXUS v9.5 kind-art filler — rate-limit aware, idempotent, resumable ────
# Generates missing skin-{style}-{KIND}.png files (5 kinds × 7 styles minus
# what already exists). Designed for bounded runs (cron接力): processes the
# pending list until BUDGET seconds elapse, then exits cleanly — next run
# resumes automatically (skip-if-exists). Spacing 100s absorbs the 429 window.
set -u
OUT=/home/z/my-project/assets/telegram
BUDGET="${BUDGET:-480}"
START=$(date +%s)

PLACE="main subject composition positioned on the right third of the frame, left two-thirds of the image fades into very dark shadow for text overlay"
NEG=", no text, no letters, no numbers, no watermark, no logo, ultra detailed professional digital art, 16:9 cinematic composition"

declare -A K
K[LONG]="furious raging bull charging upward and smashing through a glowing green resistance line, rising shards of emerald light, upward momentum streaks and rocket trails, bullish breakout energy over a holographic candlestick chart"
K[SHORT]="massive fierce bear striking downward with a heavy paw smash, glowing red support line shattering into falling crimson fragments, heavy downward pressure energy over a holographic candlestick chart"
K[TP]="triumphant golden take-profit victory, a powerful bull reaching a glowing golden target flag on the chart peak, golden coins and light confetti raining down, celebration energy over a holographic candlestick chart"
K[STOP]="defensive stop-loss scene, a bear planting a glowing red hexagonal shield barrier on the chart floor, protective crimson aura deflecting falling debris, guarded bunker energy over a holographic candlestick chart"
K[EXPIRED]="melting glowing clock face and a large hourglass with running sand floating over a holographic candlestick chart, amber twilight timeout mood, fading momentum trails, expired opportunity atmosphere"

# pending styles in operator order minus generic (generic skins exist for all 7)
STYLES="blueprint movie cyberpunk anime popart vector clay"
KINDS="LONG SHORT TP STOP EXPIRED"

done_n=0; fail_n=0; left_n=0
# count remaining first
for st in $STYLES; do for k in $KINDS; do [ -s "$OUT/skin-$st-$k.png" ] || left_n=$((left_n+1)); done; done
echo "FILLER START pending=$left_n budget=${BUDGET}s"

for st in $STYLES; do
  for k in $KINDS; do
    [ -s "$OUT/skin-$st-$k.png" ] && continue
    now=$(date +%s); [ $((now - START)) -ge "$BUDGET" ] && { echo "BUDGET REACHED (done=$done_n fail=$fail_n pending-now=$((left_n-done_n-fail_n)))"; exit 0; }
    ok=0
    for a in 1 2 3; do
      if timeout 110 z-ai image -p "epic scene of a powerful raging bull and a fierce bear facing off across a glowing holographic candlestick chart arena — ${K[$k]}, $PLACE$NEG" -o "$OUT/skin-$st-$k.png" -s 1344x768 >/dev/null 2>&1; then
        echo "OK $st-$k"; ok=1; done_n=$((done_n+1)); break
      fi
      echo "RETRY $st-$k (attempt $a) — backing off $((a*60))s"
      sleep $((a * 60))
    done
    [ $ok -eq 0 ] && { echo "FAIL $st-$k"; fail_n=$((fail_n+1)); }
    sleep 100
  done
done
echo "FILLER DONE done=$done_n fail=$fail_n remaining=$(( $(ls $OUT | grep -cE 'skin-[a-z]+-(LONG|SHORT|TP|STOP|EXPIRED)\.png') ))"
