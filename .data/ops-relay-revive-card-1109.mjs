// SENTINEL-20261109-RELAY-REVIVE — ops status card → @mytradeneo
// Trace 1a1c1ecd9694a129 — operator order: «کارت‌های سیگنال به کانال تلگرام
// ارسال نمی‌شود، احیا و پایدار کن». This is an OPS-STATUS card (clearly
// labeled, NOT a signal) proving the channel lane is alive end-to-end through
// the SAME Telegram API lane (token + chat) the notify.ts mirror uses.
// The definitive proof is the next NATURAL lifecycle card (CREATED) which now
// flows through relaySignalEvent → mirrorCardToChannel (TELEGRAM_SIGNAL_CHANNEL
// armed in the app process; boot log line confirms).
import { readFileSync } from "node:fs";

const env = readFileSync("/home/z/my-project/.env", "utf8");
const token = (env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m) || [])[1]?.trim();
const channel = (env.match(/^TELEGRAM_SIGNAL_CHANNEL=(.+)$/m) || [])[1]?.trim();
if (!token || !channel) throw new Error("token/channel missing from .env — aborting (never echoed)");

const text = [
  "🔧 <b>OPS · RELAY REVIVED</b> — NEXUS//SIGNALS",
  "",
  "کارت‌های سیگنال دوباره به این کانال جاری می‌شوند.",
  "",
  "① <b>ریشه</b>: متغیر <code>TELEGRAM_SIGNAL_CHANNEL</code> در env پروسه اپ نبود — میرور کانال از ابتدای بوت ARM نمی‌شد (ارسال‌های دستی مستقل کار می‌کردند، مسیر خودکار خمشده بود).",
  "② <b>احیا</b>: env افزوده شد + ری‌استارت کنترل‌شده → بوت‌بنر: <code>signal-channel mirror → @***eneo (full lifecycle)</code>",
  "③ <b>پایداری</b>: کلاینت Prisma بازتولید شد (فانتوم fundingByb صفر) · هاگر وزن اسپات ۵۰× سبک شد · REGIME-GUARD به L0 بازگشت و با OPERATOR PIN قفل شد.",
  "④ <b>SHADOW-VETO → حالت VETO</b> (دستور عملگر، audited force — fail-open روی وریدی قدیمی، بلاک‌ها paper-track می‌شوند).",
  "",
  "کارت بعدی <b>CREATED</b> که موتور صادر کند، همین‌جا می‌نشیند — آن اثبات نهایی چرخه کامل عمر سیگنال است.",
  "",
  `<code>SENTINEL-20261109-RELAY-REVIVE · trace 1a1c1ecd9694a129 · ${new Date().toISOString()}</code>`,
].join("\n");

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: channel, text, parse_mode: "HTML", disable_web_page_preview: true }),
});
const out = await res.json();
console.log("telegram ok:", out.ok, out.ok ? `message_id=${out.result?.message_id} → ${channel}` : `err=${out.error_code} ${out.description}`);
