// Render all v8.1 telegram artwork samples to /tmp/nexus-art for visual QA.
// Run: bun scripts/test-art.ts
import fs from "node:fs";
import path from "node:path";
import { renderSignalBannerV2, renderDailyPoster, type BannerV2Spec } from "../src/lib/telegram-art";

const OUT = "/tmp/nexus-art";
fs.mkdirSync(OUT, { recursive: true });

const samples: Array<[string, BannerV2Spec]> = [
  ["WIN", { status: "WIN", title: "WLDUSDT LONG", line1: "NX-0009 · +25.6% NET", line2: "LADDER 2/3 BANKED · RR 1:2.8", ts: "2026-09-09 07:26 TEHRAN" }],
  ["STOP", { status: "STOP", title: "ETHUSDT SHORT", line1: "NX-0011 · −29.8% NET", line2: "RISK CONTAINED · LADDER 0/3", ts: "2026-09-09 07:26 TEHRAN" }],
  ["EXPIRED", { status: "EXPIRED", title: "SOLUSDT LONG", line1: "NX-0007 · +11.2% NET", line2: "TTL 90M ELAPSED · LADDER 1/3", ts: "2026-09-09 07:26 TEHRAN" }],
  ["NEW", { status: "NEW", title: "BTCUSDT LONG", line1: "NX-0013 · ENTRY 78520 · RR 1:2.9", line2: "CONVICTION 78% · TTL 120M", ts: "2026-09-09 07:26 TEHRAN" }],
  ["SHORT", { status: "SHORT", title: "ETHUSDT SHORT", line1: "NX-0012 · ENTRY 3120 · RR 1:2.6", line2: "CONVICTION 71% · TTL 90M", ts: "2026-09-09 07:26 TEHRAN" }],
  ["TTL_EXT", { status: "TTL_EXT", title: "SOLUSDT LONG", line1: "NX-0008 · +6.4% NET", line2: "+1 EXT · STILL LIVE", ts: "2026-09-09 07:26 TEHRAN" }],
  ["FULL", { status: "FULL", title: "SOLUSDT LONG", line1: "NX-0010 · +48.9% NET", line2: "LADDER 3/3 BANKED · RR 1:3.1", ts: "2026-09-09 07:26 TEHRAN" }],
];

const digest = {
  windowLabel: "2026-09-07 → 2026-09-08 (Tehran)",
  opened: 5, closed: 4, wins: 3, stops: 1, expired: 0, winRatePct: 75,
  realizedUsd: 42.19, feesUsd: 0.84, unrealizedUsd: 17.62, equityUsd: 1059.81,
  active: 2,
  best: { symbol: "SOLUSDT", pnl: 48.9, strategy: "AI-SWING" },
  worst: { symbol: "ETHUSDT", pnl: -29.8, strategy: "BREAKOUT" },
  volCauseCaptures: 2, topCause: "OI-SPIKE",
  trades: [
    { symbol: "SOLUSDT", pnl: 48.9, status: "TP3" },
    { symbol: "WLDUSDT", pnl: 25.6, status: "TP2" },
    { symbol: "BTCUSDT", pnl: 12.4, status: "TP1" },
    { symbol: "LITUSDT", pnl: -9.2, status: "EXPIRED" },
    { symbol: "ETHUSDT", pnl: -29.8, status: "SL" },
  ],
};

async function main() {
  for (const [name, spec] of samples) {
    try {
      const png = await renderSignalBannerV2(spec);
      const p = path.join(OUT, `banner-${name}.png`);
      fs.writeFileSync(p, png);
      console.log(`OK banner-${name}.png ${(png.length / 1024).toFixed(0)}KB`);
    } catch (e) {
      console.log(`FAIL banner-${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    const png = await renderDailyPoster({ digest, ts: "2026-09-09 07:26 TEHRAN" });
    fs.writeFileSync(path.join(OUT, "poster-DAILY.png"), png);
    console.log(`OK poster-DAILY.png ${(png.length / 1024).toFixed(0)}KB`);
  } catch (e) {
    console.log(`FAIL poster-DAILY: ${e instanceof Error ? e.message : String(e)}`);
  }
}
void main();
