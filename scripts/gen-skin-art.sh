#!/bin/bash
# ── NEXUS//SIGNALS v9.5 — KIND-AWARE SKIN ART generator (operator mandate
# 2026-09-13: «بکگراند ثابت نباشد — تصویر هر کارت باید مطابق همان کارت باشد:
# سیگنال جدید لانگ، شورت، تی‌پی، استاپ و بقیه») ──────────────────────────────
#
# Two axes:
#   STYLE (7-SKIN CYCLE, fixed operator order, one per Tehran day):
#     blueprint · movie · cyberpunk · anime · popart · vector · clay
#   KIND (per card type — the SUBJECT matches the card's meaning):
#     LONG    → new signal LONG  (charging bull breakout, green upward)
#     SHORT   → new signal SHORT (bear strike-down breakdown, red downward)
#     TP      → WIN / FULL target hit (golden take-profit celebration)
#     STOP    → stop-loss (red defensive shield)
#     EXPIRED → EXPIRED / AFTERLIFE / TTL_EXT (timeout clock + hourglass)
#   generic  → daily poster / any card without a kind file (bull-vs-bear arena)
#
# Output files: assets/telegram/skin-{style}-{KIND}.png (+ skin-{style}.png
# for the generic daily piece). Style prompts mirror src/lib/daily-skin.ts.
# Idempotent: existing files are skipped. FORCE=1 regenerates.
# Today's style is generated FIRST so live cards pick it up immediately.

set -u
OUT=/home/z/my-project/assets/telegram
mkdir -p "$OUT"
FORCE="${FORCE:-0}"

# Right-third subject placement keeps the left two-thirds dark for the data
# overlay (same rule as the v8 art set + v9.4 generic skins).
PLACE="main subject composition positioned on the right third of the frame, left two-thirds of the image fades into very dark shadow for text overlay"
NEG=", no text, no letters, no numbers, no watermark, no logo, ultra detailed professional digital art, 16:9 cinematic composition"

declare -A STYLE
STYLE[blueprint]="technical engineering blueprint drawing style, precise white and cyan line-work on deep dark slate blueprint paper, measurement marks, cross-sections, annotated construction lines, faint grid paper texture"
STYLE[movie]="epic cinematic film still style, anamorphic lens flare, dramatic rim lighting, volumetric haze, shallow depth of field, movie-poster color grading, subtle film grain"
STYLE[cyberpunk]="neon cyberpunk megacity style, glowing magenta and orange holograms, rain-slick reflective floor, dense futuristic detail, blade-runner atmosphere"
STYLE[anime]="japanese anime illustration style, bold cel shading, dramatic speed lines, dynamic action energy, vibrant saturated colors, studio-quality key visual"
STYLE[popart]="retro pop-art comic style, thick bold black outlines, halftone ben-day dots, saturated flat color blocks, andy-warhol screen-print energy, dramatic comic shading"
STYLE[vector]="clean flat vector illustration style, geometric shapes, smooth gradient mesh, minimal premium fintech poster art, crisp edges, subtle isometric accents"
STYLE[clay]="cute 3D clay render style, soft matte plasticine texture, rounded chunky shapes, pastel studio lighting, blender claymation look, subtle subsurface glow"

declare -A KINDSUBJ
KINDSUBJ[LONG]="furious raging bull charging upward and smashing through a glowing green resistance line, rising shards of emerald light, upward momentum streaks and rocket trails, bullish breakout energy over a holographic candlestick chart"
KINDSUBJ[SHORT]="massive fierce bear striking downward with a heavy paw smash, glowing red support line shattering into falling crimson fragments, heavy downward pressure energy over a holographic candlestick chart"
KINDSUBJ[TP]="triumphant golden take-profit victory, a powerful bull reaching a glowing golden target flag on the chart peak, golden coins and light confetti raining down, celebration energy over a holographic candlestick chart"
KINDSUBJ[STOP]="defensive stop-loss scene, a bear planting a glowing red hexagonal shield barrier on the chart floor, protective crimson aura deflecting falling debris, guarded bunker energy over a holographic candlestick chart"
KINDSUBJ[EXPIRED]="melting glowing clock face and a large hourglass with running sand floating over a holographic candlestick chart, amber twilight timeout mood, fading momentum trails, expired opportunity atmosphere"
KINDSUBJ[generic]="epic scene of a powerful raging bull and a fierce bear facing off across a glowing holographic candlestick chart arena of a futuristic financial trading terminal"

# Style order: today's Tehran-day skin FIRST (live cards pick it up fastest),
# then the rest of the operator's fixed rotation.
TODAY=$(TZ=Asia/Tehran date +%F)
ORDER=$(bun -e "
const SK=['blueprint','movie','cyberpunk','anime','popart','vector','clay'];
const [y,m,d]=process.argv[1].split('-').map(Number);
const seed=Math.floor(Date.UTC(y,m-1,d)/86400000);
const t=SK[seed%7];
console.log([t,...SK.filter(k=>k!==t)].join(' '));
" "$TODAY" 2>/dev/null || echo "anime blueprint movie cyberpunk popart vector clay")

KINDS="generic LONG SHORT TP STOP EXPIRED"

echo "== KIND-SKIN ART GENERATOR v9.5 — today=$TODAY order=[$ORDER] =="

gen_one() { # $1=file basename (skin-...), $2=prompt
  local f="$1" prompt="$2"
  if [ "$FORCE" != "1" ] && [ -s "$OUT/$f.png" ]; then echo "SKIP $f (exists)"; return 0; fi
  for attempt in 1 2 3 4; do
    echo "GEN $f (attempt $attempt) ..."
    if timeout 240 z-ai image -p "$prompt$NEG" -o "$OUT/$f.png" -s 1344x768; then
      echo "OK $f"; return 0
    fi
    echo "RETRY $f in $((attempt * 45))s ..."
    sleep $((attempt * 45))
  done
  echo "FAIL $f"; return 1
}

fail=0
for s in $ORDER; do
  for k in $KINDS; do
    f="skin-${s}"
    [ "$k" != "generic" ] && f="skin-${s}-${k}"
    gen_one "$f" "${STYLE[$s]} — ${KINDSUBJ[$k]}, $PLACE" || fail=$((fail+1))
    sleep 8
  done
done

echo "KIND-SKIN GENERATION DONE fail=$fail"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
