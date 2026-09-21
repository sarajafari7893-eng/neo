// ── Deliver the module-audit report to Telegram (operator round 0911) ───────
// Mandate «برای تمام گزارشات ارسالی تصویر هم صادر شود»: every report ships
// with an image → a Latin/digit summary card (avoids sandbox RTL shaping risk
// in librsvg; the Persian nuance rides in the caption). Then the docx itself
// goes out as a document via the v8.3 bridge (sendDocumentDirect).
// Run: bun scripts/deliver-audit-report-0911.ts
import sharp from "sharp";
import fs from "node:fs/promises";
import { sendPhotoDirect } from "../src/lib/notify";
import { sendDocumentDirect } from "../src/lib/telegram-bridge";

const W = 1080, H = 720;
const BG = "#0C1F1A", INK = "#E8F0EC", MUTED = "#8AA094", DIM = "#5A6E66";
const ACCENT = "#3DDBB5", DANGER = "#FF4D5E", AMBER = "#FFB347";

function row(y: number, label: string, value: string, col: string): string {
  return `<text x="72" y="${y}" font-family="DejaVu Sans Mono" font-size="26" fill="${MUTED}">${label}</text>
  <text x="${W - 72}" y="${y}" font-family="DejaVu Sans" font-size="30" font-weight="700" fill="${col}" text-anchor="end">${value}</text>
  <rect x="72" y="${y + 16}" width="${W - 144}" height="1.5" fill="rgba(138,160,148,0.18)"/>`;
}

async function main() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#10281F"/><stop offset="1" stop-color="${BG}"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <rect x="0" y="0" width="${W}" height="6" fill="${ACCENT}"/>
    <text x="72" y="92" font-family="DejaVu Sans Mono" font-size="22" fill="${ACCENT}" letter-spacing="4">NEXUS-LIVE · MODULE PERFORMANCE AUDIT</text>
    <text x="${W - 72}" y="130" font-family="DejaVu Sans Mono" font-size="22" fill="${DIM}" text-anchor="end">2026-09-11 TEHRAN</text>
    <text x="72" y="188" font-family="DejaVu Sans" font-size="52" font-weight="700" fill="${INK}">EPOCH-2 VERDICT: EDGE DEFICIT</text>
    <text x="72" y="238" font-family="DejaVu Sans Mono" font-size="24" fill="${MUTED}">operator claim CONFIRMED — flow filter not yet accurate</text>
    ${row(320, "WINDOW", "35 settled · WR 20% · net -$9.95 · fees $2.23", DANGER)}
    ${row(400, "FLOW BACKTEST", "verdict FAIL — test pf 0.25…0.61", DANGER)}
    ${row(480, "CONFIDENCE 75%+", "-$10.10 · anti-predictive", AMBER)}
    ${row(560, "SHORT SIDE / GIVE-BACK", "-$9.69 / -$4.73 missed", AMBER)}
    <text x="72" y="650" font-family="DejaVu Sans Mono" font-size="22" fill="${MUTED}">7-point fix plan (R1…R7) inside the DOCX → delivered via bridge</text>
    <text x="${W - 72}" y="690" font-family="DejaVu Sans Mono" font-size="20" fill="${DIM}" text-anchor="end">NEXUS//SIGNALS v8.3</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 8 }).toBuffer();
  const cardPath = "/home/z/my-project/download/AUDIT-summary-card-0911.png";
  await fs.writeFile(cardPath, png);
  console.log("card →", cardPath);

  const docPath = "/home/z/my-project/download/NEXUS-Module-Performance-Audit-FA-0911.docx";
  const doc = await fs.readFile(docPath);

  const cap =
    "📄 گزارش تحقیق عملکرد ماژول‌ها (تحلیل مستند)\n\n" +
    "• پنجره: ۳۵ معامله تسویه‌شده اپوک-۲ — برد ۲۰٪، خالص −$9.95\n" +
    "• ادعای شما تأیید شد: حکم بک‌تست عامل جریان «FAIL» است\n" +
    "• وارونگی اطمینان (سبد ۷۵٪+: −$10.10) و خون‌ریزی SHORT (−$9.69)\n" +
    "• سوزاندن سود: ۸ معامله، ≈$4.73 از دست رفته\n" +
    "• برنامه ۷ اقدامی اصلاحی (R1…R7) در سند Word\n\n" +
    "سند کامل فارسی (docx) در پیام بعدی ارسال می‌شود.";
  const r1 = await sendPhotoDirect(cap, png, "AUDIT-summary-card-0911.png");
  console.log("photo:", JSON.stringify(r1));

  const r2 = await sendDocumentDirect(
    "📊 سند کامل گزارش تحقیق عملکرد ماژول‌ها (فارسی، RTL) — NEXUS-Module-Performance-Audit-FA-0911.docx",
    doc,
    "NEXUS-Module-Performance-Audit-FA-0911.docx"
  );
  console.log("document:", JSON.stringify(r2));
}
main();
