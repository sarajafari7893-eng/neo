// Test: render the three status banners + verify PNG structure
import { renderStatusBanner } from "../src/lib/telegram-image";
import fs from "node:fs";

const specs = [
  { status: "WIN" as const, title: "BNBUSDT LONG", line1: "NX-0125 · +25.6% NET", line2: "LADDER 2/3 BANKED · RR 1:2.8" },
  { status: "STOP" as const, title: "ARBUSDT SHORT", line1: "NX-0123 · -11.5% NET", line2: "RISK CONTAINED · LADDER 0/3" },
  { status: "EXPIRED" as const, title: "NEARUSDT LONG", line1: "NX-0119 · +0.4% NET", line2: "TTL 120M ELAPSED · LADDER 0/3" },
];
for (const [i, s] of specs.entries()) {
  const png = renderStatusBanner(s);
  const sig = png.subarray(0, 8).toString("hex");
  const okSig = sig === "89504e470d0a1a0a";
  // verify IEND trailer
  const okEnd = png.subarray(png.length - 8).toString("hex") === "0000000049454e44ae426082" || png.subarray(png.length - 4).toString("hex") === "ae426082";
  fs.writeFileSync(`/tmp/banner-${i}.png`, png);
  console.log(`banner-${i}: ${png.length} bytes sig=${okSig} iend=${okEnd}`);
}
