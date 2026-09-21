// ── v8.2 SKIN PROOF SHEET — operator round 2026-09-11 ──────────────────────
// Operator mandate: «بکگراند تصاویر تلگرام هر روز تغییر کند». This renders a
// single proof image: TODAY's real daily poster (rendered through the new
// skin pipeline from live DB digest) on top, and the deterministic 7-skin
// rotation strip beneath (Sep 11 → Sep 17 preview, each panel showing its
// palette + art backdrop + hue treatment). Delivered via sendPhoto.
// Run: bun scripts/skin-preview-0911.ts [--no-send]

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { dailySkin, skinBySeed } from "../src/lib/daily-skin";
import { loadArt } from "../src/lib/telegram-art";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
}

const W = 1280, H = 720;
const today = dailySkin();
const INK = "#e8f0ec", MUTED = "#8aa094", DIM = "#5a6e66";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── strip: 7 panels (one per skin), Sep 11 + i ──────────────────────────────
const PW = 158, PH = 190, GAP = 15, X0 = 40, Y0 = 30;
const stripParts: string[] = [];
for (let i = 0; i < 7; i++) {
  const s = skinBySeed(today.seed + i);
  const x = X0 + i * (PW + GAP);
  const d = new Date(Date.now() + i * 86_400_000);
  const dayLabel = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", day: "2-digit", month: "short" }).format(d);
  stripParts.push(`
  <g>
    <rect x="${x}" y="${Y0}" width="${PW}" height="${PH}" rx="12" fill="url(${`#p${i}`})"/>
    <rect x="${x}" y="${Y0}" width="${PW}" height="${PH}" rx="12" fill="url(#h${i})"/>
    <rect x="${x}" y="${Y0}" width="${PW}" height="${PH}" rx="12" fill="none" stroke="${i === 0 ? s.accent : "rgba(138,160,148,0.25)"}" stroke-width="${i === 0 ? 2 : 1}"/>
    ${i === 0 ? `<rect x="${x + 10}" y="${Y0 + 10}" rx="6" width="52" height="20" fill="${s.accent}" opacity="0.2"/><text x="${x + 16}" y="${Y0 + 24}" font-family="DejaVu Sans Mono" font-size="11" fill="${s.accent}" letter-spacing="1">TODAY</text>` : ""}
    <text x="${x + PW - 10}" y="${Y0 + PH - 12}" font-family="DejaVu Sans Mono" font-size="12" fill="${DIM}" text-anchor="end">${esc(dayLabel)}</text>
    <text x="${x + 12}" y="${Y0 + PH - 12}" font-family="DejaVu Sans" font-size="15" font-weight="700" fill="${s.accent}" letter-spacing="2">${esc(s.name)}</text>
    <text x="${x + PW - 10}" y="${Y0 + 24}" font-family="DejaVu Sans Mono" font-size="10" fill="${MUTED}" text-anchor="end">art-${esc(s.artKind)}</text>
  </g>`);
}

const stripDefs = skinBySeedLoop();

function skinBySeedLoop(): string {
  let out = "";
  for (let i = 0; i < 7; i++) {
    const s = skinBySeed(today.seed + i);
    const gx = [0.3, 0.7, 0.5][s.geometry], gy = [0.35, 0.3, 0.6][s.geometry];
    out += `
    <linearGradient id="p${i}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${s.deep1}"/><stop offset="1" stop-color="${s.deep2}"/>
    </linearGradient>
    <radialGradient id="h${i}" cx="${gx}" cy="${gy}" r="0.9">
      <stop offset="0" stop-color="${s.accent}" stop-opacity="0.30"/><stop offset="1" stop-color="${s.accent}" stop-opacity="0"/>
    </radialGradient>`;
  }
  return out;
}

const stripH = Y0 * 2 + PH;
const sheetH = H + stripH;

// ── render today's real poster first (same code path as the 00:00 cron) ────
const { buildDailyDigest } = await import("../src/lib/dailyReport");
const { renderDailyPoster } = await import("../src/lib/telegram-art");
const digest = await buildDailyDigest();
const poster = await renderDailyPoster({ digest, ts: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date()).toUpperCase() });

const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${sheetH}">
  <defs>${stripDefs}</defs>
  <rect width="${W}" height="${sheetH}" fill="#070a12"/>
  <text x="${W - 40}" y="26" font-family="DejaVu Sans Mono" font-size="16" fill="${DIM}" text-anchor="end">TODAY'S POSTER (REAL DIGEST) + 7-DAY SKIN ROTATION — v8.2</text>
</svg>`);

// paste poster at y=40, strip svg below at y = H + 40
const stripSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${stripH}">
  <defs>${stripDefs}</defs>
  <text x="${X0}" y="${Y0 - 8}" font-family="DejaVu Sans Mono" font-size="14" fill="${MUTED}" letter-spacing="3">DETERMINISTIC ROTATION — SEQUENCE FOR THE NEXT 7 DAYS</text>
  ${stripParts.join("")}
</svg>`);

const sheet = await sharp({
  create: { width: W, height: sheetH, channels: 3, background: { r: 7, g: 10, b: 18 } },
})
  .composite([
    { input: poster, left: 0, top: 40 },
    { input: stripSvg, left: 0, top: H + 40 },
  ])
  .png({ compressionLevel: 8 })
  .toBuffer();

const out = path.join(process.cwd(), "download", "skin-proof-0911.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, sheet);
console.log(`SKIN PROOF SHEET → ${out} (${(sheet.length / 1024).toFixed(0)}KB) · today=${today.name}`);
void overlay; void INK;

// ── send ──
if (!process.argv.includes("--no-send")) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!TOKEN) { console.log("SEND SKIP: token unset"); process.exit(0); }
  let chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path.join(process.cwd(), "db", "custom.db"), { readonly: true });
    const row = db.query<{ value: string }>(`SELECT value FROM EngineSetting WHERE key='telegram.chatId'`).get();
    const botOwnId = TOKEN.split(":")[0];
    if (row?.value && row.value !== botOwnId) chatId = row.value;
  } catch { /* env fallback */ }

  const caption = [
    `🎨 <b>بکگراند تلگرام — چرخش روزانه فعال شد (v8.2)</b>`,
    ``,
    `• امروز: اسکین <b>${today.name}</b> — بک‌دراپ art-${today.artKind}.png با hue-shift`,
    `• چرخه ۷ روزه قطعی (به تقویم تهران قفل است): ${["EMBER", "VIOLET", "JADE", "GOLD", "ROSE", "MAGMA", "LIME"].join(" → ")}`,
    `• روی همه تصاویر اعمال شد: پوستر روزانه، بنرهای سیگنال، پوستر مینیمال، کارت‌های ممیزی`,
    `• پنل بالا: پوستر واقعی امروز از دیتابیس زنده — پنل پایین: ۷ روز آینده`,
  ].join("\n");

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("photo", new Blob([new Uint8Array(sheet)], { type: "image/png" }), "skin-proof.png");
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: form });
  const j = await res.json() as { ok: boolean; description?: string; result?: { message_id: number } };
  console.log(`SEND: ${j.ok ? `OK (message_id ${j.result?.message_id})` : `FAIL — ${j.description}`}`);
}
