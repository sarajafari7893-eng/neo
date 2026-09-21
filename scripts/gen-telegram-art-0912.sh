#!/bin/bash
# v8.4.2 art restoration (bridge mandate 2026-09-12: «بکگراند تصاویر حتما باید
# مثل قبل بکگراند داشته باشند») — the v8.1 AI-art set (assets/telegram/art-*.png)
# was lost in the Sep-11 platform rollback (assets/ was outside the restore swap
# AND the old backup scope; backup.sh v3.2.1 now includes assets/). This script
# regenerates the full 8-piece set with the same design language:
#   dark cyber-terminal, near-black #070a12 base, neon accent glow, subject
#   right-of-center (the Telegram overlay darkens the left), NO text/letters.
#   WIN=mint raging bull · STOP=red raging bear · NEW=mint rocket ·
#   SHORT=red descending bear · EXPIRED=amber hourglass · FULL=gold trophy ·
#   TTL_EXT=violet clock · DAILY=gold ember abstract
set -u
DIR="/home/z/my-project/assets/telegram"
mkdir -p "$DIR"
SIZE="1344x768"
BASE="dark cyberpunk trading terminal background, near-black deep charcoal backdrop, cinematic neon glow lighting, moody atmospheric haze, subtle grid lines, high contrast, professional fintech poster art, subject positioned on the right side of the frame, left half mostly dark empty space for text overlay, no text, no letters, no numbers, no watermark, no logo, ultra detailed, 4k"

declare -A PROMPTS
PROMPTS[WIN]="$BASE, a powerful raging bull in fierce charging pose rendered in glowing neon mint green energy lines and particles, dramatic green rim light, emerald glow trails"
PROMPTS[STOP]="$BASE, a fierce raging bear in aggressive roaring pose rendered in glowing neon crimson red energy lines and particles, dramatic red rim light, ember sparks"
PROMPTS[NEW]="$BASE, a sleek rocket launching upward with a bright mint green plasma exhaust trail, launching pad light beams, vertical momentum, emerald glow"
PROMPTS[SHORT]="$BASE, a descending stock market crash concept, glowing red downward arrow and falling candlestick chart fragments, bear silhouette dissolving into red particles, dramatic danger red glow"
PROMPTS[EXPIRED]="$BASE, a large glowing amber hourglass with golden sand flowing, time running out concept, warm amber clock fragments, honey orange glow"
PROMPTS[FULL]="$BASE, a triumphant glowing golden trophy with radiant gold light rays and victory laurels, celebration sparks, rich gold glow, target bullseye rings"
PROMPTS[TTL_EXT]="$BASE, a mystical glowing violet clock with extension arrows circling it, purple nebula energy, amethyst glow, time extension concept"
PROMPTS[DAILY]="$BASE, abstract performance dashboard artwork, glowing golden rising bar chart and line graph holograms, ember orange and gold particle field, warm ambient glow"

FAIL=0
for KIND in WIN STOP NEW SHORT EXPIRED FULL TTL_EXT DAILY; do
  OUT="$DIR/art-$KIND.png"
  if [ -s "$OUT" ]; then echo "SKIP $KIND (exists)"; continue; fi
  echo "GEN  $KIND …"
  OK=""
  for ATTEMPT in 1 2 3 4 5; do
    if z-ai image -p "${PROMPTS[$KIND]}" -o "$OUT" -s "$SIZE" >/dev/null 2>&1 && [ -s "$OUT" ]; then
      OK=1; echo "  OK  $KIND (attempt $ATTEMPT, $(stat -c%s "$OUT") bytes)"; break
    fi
    echo "  retry $ATTEMPT failed for $KIND — backing off 65s (429 rate limit)"
    rm -f "$OUT"
    sleep 65
  done
  [ -z "$OK" ] && { echo "FAIL $KIND (all attempts)"; FAIL=1; }
  sleep 5
done

echo "---"
ls -la "$DIR"
exit $FAIL
