// ── Deliver the R1–R7 corrective-action deployment summary to Telegram ─────
// Mandate «برای تمام گزارشات ارسالی تصویر هم صادر شود»: every report ships
// with an image → Latin/digit summary card (RTL-safe), Persian caption rides
// in the message. Run: bun scripts/deliver-rplan-0911.ts
import sharp from "sharp";
import fs from "node:fs/promises";
import { sendPhotoDirect } from "../src/lib/notify";

const W = 1080, H = 900;
const BG = "#0C1F1A", INK = "#E8F0EC", MUTED = "#8AA094", DIM = "#5A6E66";
const ACCENT = "#3DDBB5", OK = "#3DDBB5", AMBER = "#FFB347", VIOLET = "#B26BFF";

function r(y: number, tag: string, text: string, col: string): string {
  return `<text x="72" y="${y}" font-family="DejaVu Sans Mono" font-size="25" font-weight="700" fill="${col}">${tag}</text>
  <text x="250" y="${y}" font-family="DejaVu Sans" font-size="26" fill="${INK}">${text}</text>
  <rect x="72" y="${y + 14}" width="${W - 144}" height="1.5" fill="rgba(138,160,148,0.16)"/>`;
}

async function main() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#10281F"/><stop offset="1" stop-color="${BG}"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <rect x="0" y="0" width="${W}" height="6" fill="${ACCENT}"/>
    <text x="72" y="90" font-family="DejaVu Sans Mono" font-size="22" fill="${ACCENT}" letter-spacing="4">NEXUS-LIVE · R-PLAN DEPLOYED</text>
    <text x="${W - 72}" y="90" font-family="DejaVu Sans Mono" font-size="22" fill="${DIM}" text-anchor="end">2026-09-11</text>
    <text x="72" y="150" font-family="DejaVu Sans" font-size="50" font-weight="700" fill="${INK}">R1–R7: ALL 7 LIVE IN ENGINE v8.4</text>
    <text x="72" y="196" font-family="DejaVu Sans Mono" font-size="23" fill="${MUTED}">audit corrective actions — engineered, wired, verified</text>
    ${r(268, "R1", "SHORT deploys PAUSED (shortGuard=2) — WR 11.1% / −$9.69", VIOLET)}
    ${r(332, "R2", "BE arms decisively at +1.5% price (leverage-invariant)", OK)}
    ${r(396, "R3", "weights recalibrated on EPOCH-2 only — then FROZEN", OK)}
    ${r(460, "R4", "flow = VETO-ONLY — confirm boost / discount retired", OK)}
    ${r(524, "R5", "research ladder 1.2×ATR · RR×1.15 shadow A/B (1m replay)", OK)}
    ${r(588, "R6", "no weight move until epoch-2 n≥100 (auto-lift gate)", OK)}
    ${r(652, "R7", "early exit: 50%TTL stalled / −0.45R adverse → mark", OK)}
    <text x="72" y="730" font-family="DejaVu Sans Mono" font-size="22" fill="${MUTED}">EARLY-EXIT 50%TTL@0.45R · SHORT-GUARD VETO · R-SHADOW ON</text>
    <text x="72" y="766" font-family="DejaVu Sans Mono" font-size="22" fill="${MUTED}">CALIB FROZEN (28 settled) · gate journal + UI card updated</text>
    <rect x="72" y="800" width="${W - 144}" height="1.5" fill="rgba(138,160,148,0.25)"/>
    <text x="72" y="846" font-family="DejaVu Sans Mono" font-size="21" fill="${AMBER}">A/B evidence accrues in shadow — adoption stays evidence-gated</text>
    <text x="${W - 72}" y="880" font-family="DejaVu Sans Mono" font-size="20" fill="${DIM}" text-anchor="end">NEXUS//SIGNALS v8.4 R-PACKAGE</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 8 }).toBuffer();
  const cardPath = "/home/z/my-project/download/RPLAN-deploy-card-0911.png";
  await fs.writeFile(cardPath, png);
  console.log("card →", cardPath);

  const cap =
    "✅ برنامه ۷ اقدام اصلاحی (R1…R7) — کامل و مهندسی، هم‌اکنون در موتور v8.4 زنده است\n\n" +
    "• R1: انتشار SHORT تا بهبود شواهد متوقف شد (shortGuard=2)\n" +
    "• R2: سربه‌سر قطعی در +۱.۵٪ حرکت قیمت (مستقل از لوریج) + خروج زمانی زودتر\n" +
    "• R3: وزن‌ها فقط روی داده اپوک-۲ بازتنظیم و منجمد شد (۲۸ نمونه)\n" +
    "• R4: عامل جریان فقط وتو — هیچ سهم مثبتی در امتیاز ندارد\n" +
    "• R5: پارامترهای پژوهش (slAtr ۱.۲ / rr ۱.۱۵) در حالت سایه با ری‌پلی کندل ۱دقیقه A/B می‌شوند\n" +
    "• R6: هیچ جابه‌جایی وزنی تا n≥۱۰۰ اپوک-۲ (بازگشایی خودکار با شواهد)\n" +
    "• R7: خروج زودهنگام به سبک EXPIRED — معطل ۵۰٪TTL یا زیان ≥۰.۴۵R → خروج در مارکت\n\n" +
    "همه تغییرات لاگ‌شده (gate journal) و در کارت GATE TUNABLES ترمینال قابل مشاهده‌اند. شواهد A/B در لجر سایه جمع می‌شود و پذیرش فقط با مدرک انجام خواهد شد.";
  const r1 = await sendPhotoDirect(cap, png, "RPLAN-deploy-card-0911.png");
  console.log("photo:", JSON.stringify(r1));
}
main();
