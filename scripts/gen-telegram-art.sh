#!/bin/bash
# NEXUS banner artwork set — 8 pieces, consistent dark cyber aesthetic.
# Subjects sit on the RIGHT third; left two-thirds stays dark for text overlay.
# v2: rate-limit aware — 15s spacing, 4 attempts per image with backoff.
set -u
OUT=/home/z/my-project/assets/telegram
mkdir -p "$OUT"
SUFFIX=", dark cyberpunk financial trading terminal background, cinematic dramatic lighting, neon glow accents, ultra detailed professional digital art, main subject positioned on the right third of the frame, left two-thirds of the image fades into very dark shadow for text overlay, no text, no letters, no numbers, no watermark, no logo"

declare -A PROMPTS
PROMPTS[art-WIN]="Furious raging bull charging forward aggressively, glowing neon mint green and golden energy trails and sparks bursting from its horns, powerful muscular silhouette$SUFFIX"
PROMPTS[art-STOP]="Ferocious massive bear roaring with rage, glowing crimson red energy and floating embers, claws slashing downward through crashing red candlestick chart holograms$SUFFIX"
PROMPTS[art-EXPIRED]="Majestic glowing amber hourglass with golden sand flowing through it, surrounded by fading orange embers and dissolving clock fragments$SUFFIX"
PROMPTS[art-NEW]="Sleek golden rocket launching upward with brilliant neon green exhaust trail, ascending glowing green candlestick holograms$SUFFIX"
PROMPTS[art-SHORT]="Aggressive red bear swiping its claw downward, neon red energy claw marks tearing through falling red candlestick chart holograms$SUFFIX"
PROMPTS[art-TTL_EXT]="Mystical glowing violet hourglass fused with an ancient clock face, purple energy streams and swirling time particles$SUFFIX"
PROMPTS[art-FULL]="Majestic golden trophy cup with a triumphant raging bull silhouette standing on top, golden fireworks and confetti raining$SUFFIX"
PROMPTS[art-DAILY]="Futuristic holographic financial dashboard with glowing charts, graphs and statistics panels floating in a dark navy control room, mint green and gold data visualization, cinematic wide shot"

for k in art-WIN art-STOP art-EXPIRED art-NEW art-SHORT art-TTL_EXT art-FULL art-DAILY; do
  if [ -s "$OUT/$k.png" ]; then echo "SKIP $k (exists)"; continue; fi
  ok=0
  for attempt in 1 2 3 4; do
    echo "GEN $k (attempt $attempt) ..."
    if timeout 240 z-ai image -p "${PROMPTS[$k]}" -o "$OUT/$k.png" -s 1344x768; then
      echo "OK $k"; ok=1; break
    fi
    echo "RETRY $k in $((attempt * 45))s ..."
    sleep $((attempt * 45))
  done
  [ $ok -eq 1 ] || echo "FAIL $k (gave up)"
  sleep 15
done
echo "ART GENERATION DONE"
ls -la "$OUT"
