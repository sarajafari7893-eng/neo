// ── v8.2 DAILY-SKIN 7-DAY PROOF STRIP (operator round 0911) ─────────────────
// Renders the next 7 Tehran days of background skins (art pick + hue shift)
// into one grid PNG — visual proof that «بکگراند تصاویر تگلرام هر روز تغییر
// کند» holds: same day → same skin, next midnight → next skin.
// Run: bun scripts/render-skin-proof-0911.ts [--send]
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { dailySkin, skinBySeed } from "../src/lib/daily-skin";
import { sendPhotoDirect } from "../src/lib/notify";

const W = 640;
const H = 360;
const COLS = 2;

function dateLabelForSeed(seed: number): string {
  return new Date(seed * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  const today = dailySkin();
  const tiles: Buffer[] = [];
  for (let i = 0; i < 7; i++) {
    const skin = skinBySeed(today.seed + i);
    const artPath = path.join(process.cwd(), "assets", "telegram", `art-${skin.artKind}.png`);
    let base: Buffer;
    try {
      base = await sharp(artPath).resize(W, H, { fit: "cover" }).modulate({ brightness: 0.72, saturation: 0.85, hue: skin.hueShift }).toBuffer();
    } catch {
      base = await sharp({ create: { width: W, height: H, channels: 3, background: skin.deep1 } }).png().toBuffer();
    }
    const label = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <rect x="0" y="0" width="${W}" height="64" fill="rgba(6,9,14,0.78)"/>
        <text x="18" y="28" font-family="DejaVu Sans" font-size="22" font-weight="700" fill="${skin.accent}">D+${i} · SKIN ${skin.name}</text>
        <text x="18" y="52" font-family="DejaVu Sans Mono" font-size="16" fill="#8aa094">${dateLabelForSeed(skin.seed)} · art-${skin.artKind} · hue ${skin.hueShift}°</text>
      </svg>`
    );
    tiles.push(await sharp(base).composite([{ input: label }]).png().toBuffer());
  }
  const rows = Math.ceil(7 / COLS);
  const canvas = sharp({ create: { width: W * COLS, height: H * rows, channels: 3, background: "#06090e" } });
  const composite = tiles.map((t, i) => ({ input: t, left: (i % COLS) * W, top: Math.floor(i / COLS) * H }));
  const out = path.join(process.cwd(), "download", "DAILY-SKIN-7day-proof.png");
  await canvas.composite(composite).png({ compressionLevel: 8 }).toFile(out);
  console.log(`strip → ${out}`);
  if (process.argv.includes("--send")) {
    const r = await sendPhotoDirect(
      "🎨 اثبات چرخش روزانه بکگراند (v8.2) — هر روز تهران یک پوسته جدید: art متفاوت + hue متفاوت. امروز: " + today.name,
      await fs.readFile(out),
      "DAILY-SKIN-7day-proof.png"
    );
    console.log("send:", JSON.stringify(r));
  }
}
main();
