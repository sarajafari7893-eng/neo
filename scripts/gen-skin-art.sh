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
PLACE="main subject composition positioned on the right third of the frame, right side fully detailed and dramatic, the entire left half of the image dissolves into near-black empty negative space reserved for text overlay, strong left-to-right darkness gradient"
NEG=", no text, no letters, no numbers, no words, no typography, no watermark, no logo, one clean single focal subject, no clutter, ultra detailed professional digital art, masterpiece quality, 16:9 cinematic composition"

declare -A STYLE
STYLE[blueprint]="ultra-premium dark technical blueprint art, glowing cyan holographic schematic line-work on deep navy slate, layered translucent drafting sheets floating in depth, precise measurement marks and cross-section annotations, soft cyan edge-glow, subtle depth-of-field bokeh between drawing layers, elegant engineering masterpiece composition"
STYLE[movie]="epic cinematic movie key art, anamorphic widescreen composition, dramatic volumetric god rays cutting through haze, strong rim lighting sculpting the subject, teal and amber color grade, shallow depth of field, high-contrast chiaroscuro lighting, luxury film-poster craft, subtle film grain"
STYLE[cyberpunk]="futuristic neon cyberpunk megacity key art, glowing magenta and cyan neon signage, rain-slick streets with mirror reflections, volumetric fog carrying neon glow, holographic depth layers, high-contrast night atmosphere, cinematic blade-runner mood, ultra-detailed professional digital art"
STYLE[anime]="premium japanese anime key visual, bold cel shading with crisp highlights, dynamic energy trails and speed lines, dramatic backlighting, vibrant saturated palette, studio-grade composition, sharp expressive detail, cinematic anime poster quality"
STYLE[popart]="premium retro pop-art screen print, bold black ink outlines, large crisp halftone ben-day dots, punchy flat color blocks with offset print misregistration, dramatic comic-book shading, gallery-quality warhol poster composition"
STYLE[vector]="premium minimal vector fintech key art, smooth gradient mesh shapes, elegant geometric composition with layered depth, crisp rounded edges, subtle isometric accents, sophisticated dark-mode palette with glowing mint accents, high-end poster design"
STYLE[clay]="premium 3D claymation diorama, soft matte plasticine textures, rounded chunky shapes, cozy pastel studio lighting with soft shadows, subtle subsurface scattering glow, high-end 3D render quality, charming handcrafted look"

declare -A KINDSUBJ
KINDSUBJ[LONG]="one single furious raging bull charging upward and smashing through a glowing green resistance line, rising shards of emerald light, upward momentum streaks and rocket trails, bullish breakout energy over a holographic candlestick chart"
KINDSUBJ[SHORT]="one single massive fierce bear striking downward with a heavy paw smash, glowing red support line shattering into falling crimson fragments, heavy downward pressure energy over a holographic candlestick chart"
KINDSUBJ[TP]="one single triumphant golden bull reaching a glowing golden target flag on the chart peak, golden coins and light confetti raining down, victory celebration energy over a holographic candlestick chart, no bear in the frame"
KINDSUBJ[STOP]="one single bear planting a glowing red hexagonal shield barrier on the chart floor, protective crimson aura deflecting falling debris, guarded defensive bunker energy over a holographic candlestick chart"
KINDSUBJ[EXPIRED]="a melting glowing clock face and a large hourglass with running sand floating over a holographic candlestick chart, amber twilight timeout mood, fading momentum trails, expired opportunity atmosphere"
KINDSUBJ[generic]="one powerful raging bull and one fierce bear facing off across a glowing holographic candlestick chart arena of a futuristic financial trading terminal"

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
