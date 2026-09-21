// v8.4.2 art-restore verification — render REAL cards through the REAL module
// chain (renderSignalBannerV2 → sharp composite over art-*.png) and prove the
// background is back (art-composited PNGs are visually rich → much larger than
// the old flat procedural backdrop; also probe per-pixel variance via sharp).
import { renderSignalBannerV2 } from "../src/lib/telegram-art";
import sharp from "sharp";
import fs from "node:fs";

const CASES: Array<[string, Parameters<typeof renderSignalBannerV2>[0]]> = [
  ["WIN", { status: "WIN", title: "SOLUSDT LONG", line1: "NX-0045 · +12.4% NET", line2: "LADDER 1/3 BANKED · RR 1:2.1", ts: "2026-09-12 13:25 TEHRAN" }],
  ["STOP", { status: "STOP", title: "BTCUSDT SHORT", line1: "NX-0046 · -18.2% NET", line2: "RISK CONTAINED · LADDER 0/3", ts: "2026-09-12 13:25 TEHRAN" }],
  ["NEW", { status: "NEW", title: "ETHUSDT LONG", line1: "NX-0047 · +0.0% NET", line2: "ENTRY 2531.5 · RR 1:2.4", ts: "2026-09-12 13:25 TEHRAN" }],
  ["DAILY-poster-check", { status: "FULL", title: "CHECK FULL", line1: "NX-0048 · +31.0% NET", line2: "LADDER 3/3 BANKED · RR 1:2.8", ts: "2026-09-12 13:25 TEHRAN" }],
];

let fails = 0;
for (const [label, spec] of CASES) {
  try {
    const png = await renderSignalBannerV2(spec);
    const img = sharp(png);
    const stats = await img.stats();
    // background richness probe: stdev of channel 0 across the whole frame —
    // a flat/transparent-backed card is near-uniform (low stdev); an AI-art
    // composite has photographic variance (high stdev).
    const sd = stats.channels[0].stdev;
    const out = `/home/z/my-project/scripts/art-verify-${label}.png`;
    fs.writeFileSync(out, png);
    const ok = sd > 20;
    if (!ok) fails++;
    console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${(png.length / 1024).toFixed(0)}KB · stdev=${sd.toFixed(1)} → ${ok ? "art background present" : "BACKGROUND LOOKS FLAT"}`);
  } catch (e) {
    fails++;
    console.log(`FAIL ${label}: ${(e as Error).message}`);
  }
}
console.log(fails === 0 ? "ART-VERIFY PASS" : `ART-VERIFY FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
