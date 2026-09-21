// ── v9.4.1 7-SKIN CYCLE PROOF (operator mandate 2026-09-13) ──────────────────
// «TELEGRAM ART SKIN باید ساخت و تولید تصویر را با 7-SKIN CYCLE ACROSS ALL
//  TELEGRAM REPORTS انجام دهد» — visual proof that:
//   (1) all 7 AI-generated style backdrops exist and rotate in the operator's
//       fixed order (BLUEPRINT → MOVIE → CYBERPUNK → ANIME → POP ART → VECTOR
//       → CLAY), one per Tehran day;
//   (2) TODAY's skin dresses EVERY report: daily poster + WIN/STOP sample
//       cards all wear the same style (skin-primary everywhere, v9.4.1).
// Run: npx tsx scripts/render-skin-proof-0913.ts [--send]
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { dailySkin, skinBySeed, SKIN_COUNT } from "../src/lib/daily-skin";
import { renderSignalBannerV2, loadSkinArt } from "../src/lib/telegram-art";
import { renderDailyPoster } from "../src/lib/telegram-art";
import type { DailyDigest } from "../src/lib/dailyReport";
import { sendPhotoDirect } from "../src/lib/notify";

const W = 620;
const H = 349;
const COLS = 2;

function dateLabelForSeed(seed: number): string {
  return new Date(seed * 86_400_000).toISOString().slice(0, 10);
}

const SAMPLE_DIGEST: DailyDigest = {
  windowLabel: "Sep 12 → Sep 13, 2026 (Tehran) · SAMPLE",
  opened: 12, closed: 11, wins: 4, stops: 3, expired: 4,
  winRatePct: 36, realizedUsd: 18.42, feesUsd: 2.31, unrealizedUsd: 1.12,
  equityUsd: 107.06, active: 3,
  best: { symbol: "LSKUSDT", pnl: 38.9, strategy: "AI-SWING" },
  worst: { symbol: "PUMPUSDT", pnl: -26.5, strategy: "AI-SWING" },
  volCauseCaptures: 9, topCause: "FUNDING-SQUEEZE",
  statusMix: { tp: 4, sl: 3, expired: 4, manual: 0 },
  trades: [
    { symbol: "LSKUSDT", pnl: 38.9, status: "TP3", strategy: "AI-SWING", direction: "LONG" },
    { symbol: "IOSTUSDT", pnl: 32.4, status: "TP3", strategy: "MEAN-REVERT", direction: "SHORT" },
    { symbol: "ENAUSDT", pnl: -12.2, status: "SL", strategy: "AI-SCALP", direction: "SHORT" },
    { symbol: "PUMPUSDT", pnl: -26.5, status: "SL", strategy: "AI-SWING", direction: "LONG" },
  ],
};

async function main() {
  const today = dailySkin();
  const outDir = path.join(process.cwd(), "download");
  await fs.mkdir(outDir, { recursive: true });

  // ── strip 1: the 7-day skin book (AI backdrops, real rotation order) ──
  const tiles: Buffer[] = [];
  let missing = 0;
  for (let i = 0; i < SKIN_COUNT; i++) {
    const skin = skinBySeed(today.seed + i);
    const art = await loadSkinArt(skin.key);
    if (!art) missing++;
    const base = art
      ? await sharp(art).resize(W, H, { fit: "cover" }).modulate({ brightness: skin.tune.brightness, saturation: skin.tune.saturation }).toBuffer()
      : await sharp({ create: { width: W, height: H, channels: 3, background: skin.deep1 } }).png().toBuffer();
    const label = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <rect x="0" y="0" width="${W}" height="64" fill="rgba(6,9,14,0.78)"/>
        <text x="18" y="28" font-family="DejaVu Sans" font-size="22" font-weight="700" fill="${skin.accent}">${i === 0 ? "TODAY" : `D+${i}`} · SKIN ${skin.name}${art ? "" : " (MISSING)"}</text>
        <text x="18" y="52" font-family="DejaVu Sans Mono" font-size="15" fill="#8aa094">${dateLabelForSeed(skin.seed)} · skin-${skin.key}.png · AI-generated backdrop</text>
      </svg>`
    );
    tiles.push(await sharp(base).composite([{ input: label }]).png().toBuffer());
  }
  const rows = Math.ceil(SKIN_COUNT / COLS);
  const strip = await sharp({ create: { width: W * COLS, height: H * rows, channels: 3, background: "#06090e" } })
    .composite(tiles.map((t, i) => ({ input: t, left: (i % COLS) * W, top: Math.floor(i / COLS) * H })))
    .png({ compressionLevel: 8 }).toBuffer();
  const stripPath = path.join(outDir, "SKIN-CYCLE-7book-proof.png");
  await fs.writeFile(stripPath, strip);

  // ── strip 2: TODAY's skin across ALL report types (poster + WIN + STOP) ──
  const poster = await renderDailyPoster({ digest: SAMPLE_DIGEST, ts: "SKIN PROOF · ALL REPORTS" });
  const winCard = await renderSignalBannerV2({
    status: "WIN", title: "LSKUSDT LONG", line1: "NX-0138 · TP2 HIT · +25.6% NET",
    line2: "LADDER 2/3 BANKED · RR 1:2.8", footer: "SAMPLE — FORMAT PROOF", ts: "SKIN PROOF",
  });
  const stopCard = await renderSignalBannerV2({
    status: "STOP", title: "PUMPUSDT LONG", line1: "NX-0140 · STOPPED · −1R",
    line2: "BE-ARM +1.5%px DID NOT TRIGGER", footer: "SAMPLE — FORMAT PROOF", ts: "SKIN PROOF",
  });
  const pw = 640, ph = 360;
  const scaled = await Promise.all([poster, winCard, stopCard].map((b) => sharp(b).resize(pw, ph, { fit: "cover" }).png().toBuffer()));
  const head = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pw * 2}" height="72">
      <rect x="0" y="0" width="${pw * 2}" height="72" fill="#06090e"/>
      <text x="20" y="46" font-family="DejaVu Sans" font-size="28" font-weight="700" fill="#ffd700">TODAY'S SKIN: ${today.name} — DAILY POSTER · WIN CARD · STOP CARD</text>
    </svg>`
  );
  const strip2 = await sharp({ create: { width: pw * 2, height: 72 + ph * 2, channels: 3, background: "#06090e" } })
    .composite([
      { input: head, left: 0, top: 0 },
      { input: scaled[0], left: 0, top: 72 },
      { input: scaled[1], left: pw, top: 72 },
      { input: scaled[2], left: 0, top: 72 + ph },
    ])
    .png({ compressionLevel: 8 }).toBuffer();
  const strip2Path = path.join(outDir, "SKIN-CYCLE-today-allreports-proof.png");
  await fs.writeFile(strip2Path, strip2);

  console.log(`today skin: ${today.name} (${today.key}) · missing backdrops: ${missing}/7`);
  console.log(`strip1 → ${stripPath}`);
  console.log(`strip2 → ${strip2Path}`);

  if (process.argv.includes("--send")) {
    const r1 = await sendPhotoDirect(
      [
        "🎨 <b>7-SKIN CYCLE — کتاب کامل پوسته‌ها (تصویر ۱ از ۲)</b>",
        "",
        `هفت بکگراندِ تولیدشده با هوش مصنوعی، به ترتیب انتخاب خودت: BLUEPRINT · MOVIE · CYBERPUNK · ANIME · POP ART · VECTOR · CLAY — هر روز تهران یک استایل. امروز: <b>${today.name}</b> · فردا: POP ART`,
        "<i>چرخش از امروز (D+0) به بعد — صحنهٔ ثابت گاو و خرس، استایلِ متغیر.</i>",
      ].join("\n"),
      strip,
      "SKIN-CYCLE-7book-proof.png",
    );
    console.log("send1:", JSON.stringify(r1));
    const r2 = await sendPhotoDirect(
      [
        "🎨 <b>7-SKIN CYCLE — پوستهٔ امروز روی همهٔ گزارش‌ها (تصویر ۲ از ۲)</b>",
        "",
        `پوستر روزانه + کارت WIN + کارت STOP — همه با استایل امروز (<b>${today.name}</b>).`,
        "اصلاح مهندسی امروز (v9.4.1): قبلاً کارت‌های سیگنال آرت قدیمی را ترجیح می‌دادند و پوستهٔ روز هرگز رویشان نمی‌نشست؛ از این لحظه پوستهٔ روز «اصلی» است روی همهٔ تصاویر تلگرام و آرت قدیمی فقط fallback است.",
        "",
        "<i>رندر زنده از موتور با اعداد SAMPLE — اعداد واقعی گزارش رسمی جداگانه می‌آید. هر نیمه‌شب تهران → استایل بعدی.</i>",
      ].join("\n"),
      strip2,
      "SKIN-CYCLE-today-allreports-proof.png",
    );
    console.log("send2:", JSON.stringify(r2));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
