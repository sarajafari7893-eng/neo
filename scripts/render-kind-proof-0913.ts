// ── v9.5 KIND-AWARE SKIN ART PROOF (operator mandate 2026-09-13) ─────────────
// «بکگراند ثابت نباشد — تصویر هر کارت باید مطابق همان کارت باشد: سیگنال جدید
//  لانگ، شورت، تی‌پی، استاپ و بقیه» — visual proof that every card type now
// wears ITS OWN AI-generated subject inside the day's skin style:
//   NEW → skin-{key}-LONG.png (bull breakout)     SHORT → skin-{key}-SHORT.png (bear smash)
//   WIN/FULL → skin-{key}-TP.png (golden TP)      STOP → skin-{key}-STOP.png (red shield)
//   EXPIRED/AFTERLIFE/TTL_EXT → skin-{key}-EXPIRED.png (timeout hourglass)
// Run: npx tsx scripts/render-kind-proof-0913.ts [--send]
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { dailySkin } from "../src/lib/daily-skin";
import { renderSignalBannerV2 } from "../src/lib/telegram-art";
import { sendPhotoDirect } from "../src/lib/notify";

const W = 640;
const H = 360;

async function main() {
  const today = dailySkin();
  const outDir = path.join(process.cwd(), "download");
  await fs.mkdir(outDir, { recursive: true });

  const cards: Array<{ label: string; file: string; spec: Parameters<typeof renderSignalBannerV2>[0] }> = [
    {
      label: "NEW SIGNAL LONG", file: "LONG",
      spec: { status: "NEW", title: "WLDUSDT LONG", line1: "NX-0152 · ENTRY 1.482 · RR 1:2.6", line2: "SCORE 74 · FLOW OK", footer: "SAMPLE — FORMAT PROOF", ts: "KIND PROOF" },
    },
    {
      label: "SHORT SIGNAL", file: "SHORT",
      spec: { status: "SHORT", title: "ENAUSDT SHORT", line1: "NX-0153 · ENTRY 0.912 · RR 1:2.4", line2: "SCORE 69 · FLOW OK", footer: "SAMPLE — FORMAT PROOF", ts: "KIND PROOF" },
    },
    {
      label: "TP / WIN", file: "TP",
      spec: { status: "WIN", title: "LSKUSDT LONG", line1: "NX-0138 · TP2 HIT · +25.6% NET", line2: "LADDER 2/3 BANKED · RR 1:2.8", footer: "SAMPLE — FORMAT PROOF", ts: "KIND PROOF" },
    },
    {
      label: "STOP", file: "STOP",
      spec: { status: "STOP", title: "PUMPUSDT LONG", line1: "NX-0140 · STOPPED · −1R", line2: "BE-ARM +1.5%px DID NOT TRIGGER", footer: "SAMPLE — FORMAT PROOF", ts: "KIND PROOF" },
    },
  ];

  const scaled = await Promise.all(cards.map(async (c) => {
    const buf = await renderSignalBannerV2(c.spec);
    return sharp(buf).resize(W, H, { fit: "cover" }).png().toBuffer();
  }));

  const head = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="120">
      <rect x="0" y="0" width="${W * 2}" height="120" fill="#06090e"/>
      <text x="20" y="46" font-family="DejaVu Sans" font-size="28" font-weight="700" fill="#ffd700">v9.5 KIND-ART — SKIN ${today.name}: EVERY CARD WEARS ITS OWN SUBJECT</text>
      <text x="20" y="82" font-family="DejaVu Sans Mono" font-size="18" fill="#8aa094">NEW→LONG-bull · SHORT→bear-smash · WIN→golden-TP · STOP→red-shield (all in today's ${today.name} style)</text>
    </svg>`
  );
  const strip = await sharp({ create: { width: W * 2, height: 120 + H * 2, channels: 3, background: "#06090e" } })
    .composite([
      { input: head, left: 0, top: 0 },
      { input: scaled[0], left: 0, top: 120 },
      { input: scaled[1], left: W, top: 120 },
      { input: scaled[2], left: 0, top: 120 + H },
      { input: scaled[3], left: W, top: 120 + H },
    ])
    .png({ compressionLevel: 8 }).toBuffer();
  const stripPath = path.join(outDir, "KIND-ART-today-4cards-proof.png");
  await fs.writeFile(stripPath, strip);
  console.log(`today skin: ${today.name} (${today.key})`);
  console.log(`strip → ${stripPath}`);

  if (process.argv.includes("--send")) {
    const r = await sendPhotoDirect(
      [
        "🎯 <b>«بکگراند ثابت نباشد» — انجام شد (v9.5 KIND-ART)</b>",
        "",
        "از این لحظه هر کارت تصویرِ خودش را دارد — موضوعِ تصویر با معنیِ کارت یکی است، داخل استایلِ روز:",
        "🟢 سیگنال جدید لانگ → گاوی که خط مقاومت سبز را می‌شکند",
        "🔴 سیگنال شورت → خرسی که خط حمایت را می‌کوبد و می‌شکند",
        "🏆 تی‌پی / وین → صحنه طلایی رسیدن به تارگت با سکه و جشن",
        "🛡 استاپ → سپر شش‌ضلعی قرمز دفاعی روی کف چارت",
        "⌛ منقضی/افترلایف → ساعت شنی و شن‌های تمام‌شده",
        "",
        `رندر زندهٔ بالا: پوستهٔ امروز <b>${today.name}</b> — چهار کارت NEW LONG · SHORT · TP · STOP، هر کدام با بکگراند اختصاصی. مجموعهٔ کامل ۷ استایل × ۶ صحنه در حال تولید است و خودکار جایگزین می‌شود.`,
        "",
        "<i>خطای NaN کارت RAW-CAL هم ریشه‌یابی و بسته شد — گارد v9.4.2 سر جایش است و سرور با کشِ تمیز دوباره بالا آمد.</i>",
      ].join("\n"),
      strip,
      "KIND-ART-today-4cards-proof.png",
    );
    console.log("send:", JSON.stringify(r));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
